// Einstieg der Oberfläche: Zustand, Router, Live-Verbindung, zentrale Aktionen.
import { createApi, errorMessage, NetworkError } from './api.js';
import { h, prefs, replaceChildren, plural } from './util.js';
import { icon } from './icons.js';
import { toast, announce } from './components.js';
import * as overview from './views/overview.js';
import * as historyView from './views/history.js';
import * as settings from './views/settings.js';
import * as setup from './views/setup.js';

const ROUTES = {
  uebersicht: { view: overview, title: 'Übersicht', icon: 'overview' },
  verlauf: { view: historyView, title: 'Verlauf', icon: 'history' },
  einstellungen: { view: settings, title: 'Einstellungen', icon: 'settings' },
  einrichtung: { view: setup, title: 'Ersteinrichtung', icon: 'logo', hidden: true },
};
const DEFAULT_ROUTE = 'uebersicht';
const MAX_LOG_BUFFER = 2000;

// ------------------------------------------------------------------ Zustand

function createStore() {
  const listeners = new Map();
  return {
    status: null,
    runs: null,
    files: null,
    logLines: [],
    connection: 'connecting', // SSE: connecting | open | closed
    reachable: true, // Backend per HTTP erreichbar
    loginPending: false,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      for (const fn of listeners.get(type) ?? []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(err);
        }
      }
    },
  };
}

const store = createStore();
let api;
let current = null; // { name, instance }

// ------------------------------------------------------------------ Datenabruf

function setReachable(ok) {
  if (store.reachable === ok) return;
  store.reachable = ok;
  document.getElementById('offline-banner').hidden = ok;
  store.emit('reachable', ok);
}

async function guarded(promise) {
  try {
    const value = await promise;
    setReachable(true);
    return value;
  } catch (err) {
    if (err instanceof NetworkError) setReachable(false);
    throw err;
  }
}

function applyStatus(status) {
  const prev = store.status;
  store.status = status;
  if (prev && !prev.running && status.running) {
    announce(status.current?.dry_run ? 'Probelauf gestartet.' : 'Synchronisierung gestartet.');
  }
  if (store.loginPending && status.session?.state === 'valid') {
    store.loginPending = false;
    toast('Anmeldung erfolgreich. Die Sitzung ist wieder gültig.', { tone: 'success' });
    announce('Anmeldung erfolgreich.');
  }
  store.emit('status', status);
}

async function refreshStatus() {
  const status = await guarded(api.getStatus());
  applyStatus(status);
  return status;
}

async function refreshRuns(limit = 50) {
  store.runs = await guarded(api.getRuns(limit));
  store.emit('runs', store.runs);
  return store.runs;
}

async function refreshFiles(limit = 50) {
  store.files = await guarded(api.getRecentFiles(limit));
  store.emit('files', store.files);
  return store.files;
}

async function loadLogs(lines = 200) {
  try {
    const data = await guarded(api.getLogs(lines));
    store.logLines = data.lines ?? [];
    store.emit('logs:reset', store.logLines);
  } catch {
    /* Protokoll ist optional */
  }
}

function pushLog(line) {
  store.logLines.push(line);
  if (store.logLines.length > MAX_LOG_BUFFER) store.logLines.splice(0, store.logLines.length - MAX_LOG_BUFFER);
  store.emit('log', line);
}

function onRunFinished(report) {
  const t = report.totals ?? {};
  const label = report.dry_run ? 'Probelauf' : 'Synchronisierung';
  let message;
  let tone = 'success';
  switch (report.result) {
    case 'success':
      message = report.dry_run
        ? `${label} abgeschlossen: ${plural(t.found ?? 0, 'Datei', 'Dateien')} geprüft.`
        : `${label} abgeschlossen: ${plural(t.downloaded ?? 0, 'neue Datei', 'neue Dateien')}.`;
      break;
    case 'errors':
      tone = 'warning';
      message = `${label} mit ${plural(t.errors ?? 0, 'Fehler', 'Fehlern')} abgeschlossen.`;
      break;
    case 'session_expired':
      tone = 'danger';
      message = 'Sitzung abgelaufen – bitte neu anmelden.';
      break;
    case 'offline':
      tone = 'warning';
      message = 'ILIAS ist nicht erreichbar.';
      break;
    case 'cancelled':
      tone = 'neutral';
      message = `${label} abgebrochen.`;
      break;
    default:
      tone = 'danger';
      message = report.message || `${label} fehlgeschlagen.`;
  }
  toast(message, { tone });
  announce(message);
  store.emit('run_finished', report);
  refreshRuns().catch(() => {});
  refreshFiles().catch(() => {});
}

// ------------------------------------------------------------------ Aktionen

const actions = {
  async startSync(dryRun = false) {
    if (store.status?.running) return;
    store.logLines = [];
    store.emit('logs:reset', store.logLines);
    try {
      await guarded(api.startSync({ dryRun }));
      // Status sofort holen, falls das erste SSE-Event noch unterwegs ist.
      refreshStatus().catch(() => {});
    } catch (err) {
      if (err.code === 'already_running') {
        toast('Es läuft bereits eine Synchronisierung.', { tone: 'neutral' });
        refreshStatus().catch(() => {});
      } else {
        toast(errorMessage(err), { tone: 'danger' });
      }
    }
  },
  async cancelSync() {
    try {
      await guarded(api.cancelSync());
      announce('Abbruch angefordert.');
      toast('Abbruch angefordert …', { tone: 'neutral', timeout: 2500 });
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
  },
  async login() {
    try {
      await guarded(api.login());
      store.loginPending = true;
      store.emit('status', store.status);
      toast('Anmeldefenster wird geöffnet – bitte dort bei ILIAS anmelden.', { tone: 'neutral', timeout: 6000 });
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
  },
  async checkSession() {
    try {
      const res = await guarded(api.checkSession());
      const text = { valid: 'Sitzung ist gültig.', expired: 'Sitzung ist abgelaufen.', offline: 'ILIAS ist nicht erreichbar.' }[res.state] ?? 'Sitzung geprüft.';
      toast(text, { tone: res.state === 'valid' ? 'success' : 'warning' });
      refreshStatus().catch(() => {});
      return res;
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
      return null;
    }
  },
  async openFile(path) {
    try {
      await guarded(api.openFile(path));
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
  },
  async revealFile(path) {
    try {
      await guarded(api.revealFile(path));
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
  },
  async openFolder(which) {
    try {
      await guarded(api.openFolder(which));
    } catch (err) {
      toast(errorMessage(err), { tone: 'danger' });
    }
  },
};

// ------------------------------------------------------------------ Live-Verbindung

let pollTimer = null;

function setConnection(state) {
  const prev = store.connection;
  store.connection = state;
  const dot = document.getElementById('conn-indicator');
  dot.dataset.state = state;
  dot.title = { open: 'Live verbunden', connecting: 'Verbinde …', closed: 'Verbindung unterbrochen – neuer Versuch läuft' }[state];
  dot.querySelector('.conn-text').textContent = { open: 'Live', connecting: 'Verbinde …', closed: 'Getrennt' }[state];
  if (state === 'open' && prev !== 'open') {
    // Nach (Wieder-)Verbindung Stand abgleichen.
    refreshStatus().catch(() => {});
    if (store.status?.running) loadLogs();
  }
  // Fallback-Polling, solange kein Live-Strom besteht.
  clearInterval(pollTimer);
  if (state !== 'open') pollTimer = setInterval(() => refreshStatus().catch(() => {}), 5000);
  store.emit('connection', state);
}

function connectLive() {
  api.connectEvents({
    onConnection: setConnection,
    onLog: pushLog,
    onStatus: applyStatus,
    onRunFinished,
  });
}

// ------------------------------------------------------------------ Router

function parseRoute() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES[name] ? name : DEFAULT_ROUTE;
}

export function navigate(name) {
  const target = `#/${name}`;
  if (location.hash === target) render();
  else location.hash = target;
}

const ctx = {
  get api() {
    return api;
  },
  store,
  actions,
  toast,
  announce,
  navigate,
  refreshStatus,
  refreshRuns,
  refreshFiles,
  loadLogs,
};

function render() {
  const name = parseRoute();
  const route = ROUTES[name];
  if (current?.name === name) return;
  current?.instance?.unmount?.();
  const main = document.getElementById('view');
  main.replaceChildren();
  document.body.classList.toggle('is-setup', name === 'einrichtung');
  document.title = `${route.title} – ILIAS Sync`;
  for (const link of document.querySelectorAll('.nav-link')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  current = { name, instance: route.view.mount(main, ctx) };
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  // Fokus für Screenreader-/Tastaturnutzer auf die neue Überschrift legen.
  const heading = main.querySelector('h1');
  if (heading && document.activeElement?.classList.contains('nav-link')) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

function buildShell() {
  const nav = document.getElementById('nav');
  replaceChildren(
    nav,
    ...Object.entries(ROUTES)
      .filter(([, r]) => !r.hidden)
      .map(([name, r]) =>
        h('a', { class: 'nav-link', href: `#/${name}`, dataset: { route: name } }, icon(r.icon, { size: 18 }), h('span', {}, r.title)),
      ),
  );
  if (api.mock) {
    const badge = document.getElementById('mock-badge');
    badge.hidden = false;
    badge.title = `Demo-Modus mit Beispieldaten (Szenario: ${api.scenario})`;
  }
  document.getElementById('offline-retry').addEventListener('click', () => refreshStatus().catch(() => {}));
}

// ------------------------------------------------------------------ Start

async function boot() {
  api = await createApi();
  buildShell();

  let status = null;
  for (let attempt = 0; !status; attempt += 1) {
    try {
      status = await refreshStatus();
    } catch (err) {
      document.getElementById('boot-message').textContent = errorMessage(err);
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
    }
  }
  document.getElementById('boot').hidden = true;
  document.getElementById('app').hidden = false;

  connectLive();
  if (status.running) loadLogs();
  refreshRuns().catch(() => {});
  refreshFiles().catch(() => {});

  // Relative Zeitangaben aktuell halten.
  setInterval(() => store.emit('tick', Date.now()), 30000);

  const needsSetup = !status.credentials_configured || !status.last_run;
  if (needsSetup && !prefs.get('setupDone', false) && !location.hash.includes('einstellungen')) {
    window.history.replaceState(null, '', '#/einrichtung');
  }
  window.addEventListener('hashchange', render);
  render();
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('boot-message').textContent = `Die Oberfläche konnte nicht gestartet werden: ${errorMessage(err)}`;
});
