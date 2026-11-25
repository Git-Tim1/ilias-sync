// Übersicht: Status, Start/Abbruch, Live-Fortschritt, Kennzahlen, Kurse, zuletzt geladene Dateien.
import { h, button, iconButton, fmtRelative, fmtDayTime, fmtBytes, fmtNumber, fmtClock, plural, parseDate, runDurationSeconds, TRIGGER_LABEL, resultPill, debounce } from '../util.js';
import { icon, fileKind } from '../icons.js';
import { LogView, notice } from '../components.js';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const REVEAL_LABEL = IS_MAC ? 'Im Finder zeigen' : 'Im Ordner zeigen';

// ------------------------------------------------------------------ Zustand ableiten

function nextScheduledRun(schedule, now = new Date()) {
  if (!schedule?.supported || !schedule.enabled || !/^\d{2}:\d{2}$/.test(schedule.time ?? '')) return null;
  const [hh, mm] = schedule.time.split(':').map(Number);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm);
  const today = next > now;
  if (!today) next.setDate(next.getDate() + 1);
  return `${today ? 'heute' : 'morgen'} um ${schedule.time} Uhr`;
}

export function sessionExpired(status) {
  const last = status.last_run;
  if (status.session?.state === 'expired') return true;
  if (last?.result !== 'session_expired') return false;
  // Nach erneutem Login gilt die Sitzung wieder als gültig.
  const checked = parseDate(status.session?.checked_at);
  const finished = parseDate(last.finished_at);
  return !(status.session?.state === 'valid' && checked && finished && checked > finished);
}

function deriveState(status, now = Date.now()) {
  const last = status.last_run;
  if (status.running) {
    const cur = status.current;
    return {
      tone: 'running',
      icon: 'sync',
      title: cur?.dry_run ? 'Probelauf läuft …' : 'Synchronisierung läuft …',
      sub: `Gestartet ${fmtRelative(cur?.started_at, now)} · ${TRIGGER_LABEL[cur?.trigger] ?? 'manuell'}${cur?.dry_run ? ' · es werden keine Dateien gespeichert' : ''}`,
    };
  }
  if (sessionExpired(status)) {
    return {
      tone: 'danger',
      icon: 'lock',
      title: 'Anmeldung erforderlich',
      sub: last ? `Letzter Lauf ${fmtRelative(last.finished_at ?? last.started_at, now)} · ILIAS-Sitzung abgelaufen` : 'Die ILIAS-Sitzung ist abgelaufen.',
    };
  }
  if (!last) {
    return {
      tone: 'neutral',
      icon: 'download',
      title: 'Noch keine Synchronisierung',
      sub: 'Starte den ersten Lauf, um deine Kursmaterialien zu laden.',
    };
  }
  const when = `Letzter Lauf ${fmtRelative(last.finished_at ?? last.started_at, now)}`;
  const trigger = TRIGGER_LABEL[last.trigger] ?? last.trigger;
  const t = last.totals ?? {};
  const relogged = last.result === 'session_expired';
  const map = {
    success: {
      tone: 'success',
      icon: 'checkCircle',
      title: last.dry_run ? 'Probelauf erfolgreich' : 'Alles aktuell',
      detail: last.dry_run
        ? `${plural(t.found ?? 0, 'Datei', 'Dateien')} geprüft`
        : t.downloaded
          ? plural(t.downloaded, 'neue Datei', 'neue Dateien')
          : 'keine neuen Dateien',
    },
    errors: {
      tone: 'warning',
      icon: 'warning',
      title: 'Abgeschlossen mit Fehlern',
      detail: `${plural(t.errors ?? 0, 'Fehler', 'Fehler')} · ${plural(t.downloaded ?? 0, 'neue Datei', 'neue Dateien')}`,
    },
    offline: { tone: 'muted', icon: 'offline', title: 'ILIAS nicht erreichbar', detail: 'keine Verbindung' },
    failed: { tone: 'danger', icon: 'error', title: 'Synchronisierung fehlgeschlagen', detail: last.message || 'unbekannter Fehler' },
    cancelled: { tone: 'muted', icon: 'cancelled', title: 'Letzter Lauf abgebrochen', detail: plural(t.downloaded ?? 0, 'neue Datei', 'neue Dateien') },
    session_expired: { tone: 'neutral', icon: 'checkCircle', title: 'Wieder angemeldet', detail: 'bereit für die nächste Synchronisierung' },
  };
  const m = map[last.result] ?? { tone: 'muted', icon: 'info', title: 'Status unbekannt', detail: last.result };
  return { tone: m.tone, icon: m.icon, title: m.title, sub: `${when} · ${trigger} · ${m.detail}`, relogged };
}

/** Kurszeilen: Grundlage ist der letzte Lauf mit Kursen; während eines Laufs wird live ergänzt. */
function courseRows(status, runs) {
  const baseRun = status.last_run?.courses?.length ? status.last_run : runs?.find((r) => r.courses?.length) ?? null;
  const base = baseRun?.courses ?? [];
  if (!status.running || !status.current) {
    return { baseRun, rows: base.map((c) => ({ ...c, state: c.errors ? 'error' : 'done' })) };
  }
  const cur = status.current;
  const done = new Map((cur.courses ?? []).map((c) => [c.name, c]));
  const activeName = cur.progress?.current_course ?? null;
  const names = [...base.map((c) => c.name)];
  for (const c of cur.courses ?? []) if (!names.includes(c.name)) names.push(c.name);
  const rows = names.map((name) => {
    const fin = done.get(name);
    if (fin) return { ...fin, state: fin.errors ? 'error' : 'done' };
    const b = base.find((c) => c.name === name);
    const isActive = activeName && (b?.short_name === activeName || name === activeName);
    return { ...b, downloaded: null, skipped: null, errors: null, error_message: null, state: isActive ? 'active' : 'pending' };
  });
  return { baseRun: cur, rows };
}

// ------------------------------------------------------------------ Ansicht

export function mount(root, ctx) {
  const { store, actions } = ctx;
  const cleanups = [];
  let panelOpen = Boolean(store.status?.running);
  let lastFinished = null;
  let elapsedTimer = null;
  let noticeKey = null;

  // ---- Kopfzeile
  const logToggle = button('Protokoll', {
    icon: 'book',
    variant: 'ghost',
    size: 'sm',
    'aria-expanded': 'false',
    'aria-controls': 'run-panel',
    onclick: () => {
      panelOpen = !panelOpen;
      if (panelOpen && !store.logLines.length) ctx.loadLogs();
      updateRunPanel();
    },
  });
  const header = h('header', { class: 'page-header' }, h('h1', {}, 'Übersicht'), h('div', { class: 'page-actions' }, logToggle));

  // ---- Statuskarte
  const statusIcon = h('div', { class: 'status-icon' });
  const statusTitle = h('h2', { class: 'status-title' });
  const statusSub = h('p', { class: 'status-sub' });
  const statusNext = h('p', { class: 'status-next' });
  const semester = h('span', { class: 'badge', title: 'Aktuelles Semester' });
  const syncBtn = button('Jetzt synchronisieren', { icon: 'sync', variant: 'primary', size: 'lg', onclick: () => actions.startSync(false) });
  const dryBtn = button('Probelauf', {
    icon: 'flask',
    variant: 'secondary',
    title: 'Zeigt nur, was geladen würde – ohne Dateien zu speichern',
    onclick: () => actions.startSync(true),
  });
  const cancelBtn = button('Abbrechen', { icon: 'stop', variant: 'danger', onclick: () => actions.cancelSync() });
  const statusCard = h(
    'section',
    { class: 'card status-card', 'aria-labelledby': 'status-title' },
    statusIcon,
    h('div', { class: 'status-text', 'aria-live': 'polite', 'aria-atomic': 'true' }, h('div', { class: 'status-title-row' }, statusTitle, semester), statusSub, statusNext),
    h('div', { class: 'status-actions' }, syncBtn, dryBtn, cancelBtn),
  );
  statusTitle.id = 'status-title';

  // ---- Hinweise
  const notices = h('div', { class: 'notices' });

  // ---- Lauf-Panel
  const runLabel = h('span', { class: 'run-label' });
  const runElapsed = h('span', { class: 'run-elapsed tabular', 'aria-label': 'Laufzeit' });
  const runClose = iconButton('close', 'Protokoll schließen', {
    class: 'run-close',
    onclick: () => {
      panelOpen = false;
      updateRunPanel();
      logToggle.focus();
    },
  });
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Fortschritt' }, progressBar);
  const logView = new LogView({ label: 'Live-Protokoll' });
  logView.setLines(store.logLines);
  const runPanel = h(
    'section',
    { class: 'card run-panel', id: 'run-panel', hidden: true, 'aria-label': 'Laufender Vorgang' },
    h('div', { class: 'run-head' }, h('div', { class: 'run-title' }, runLabel), runElapsed, runClose),
    progress,
    logView.el,
  );

  // ---- Kennzahlen
  const stat = (label, key, tone) => {
    const value = h('span', { class: 'stat-value tabular' }, '–');
    const el = h('div', { class: `stat stat-${tone}` }, h('span', { class: 'stat-label' }, label), value);
    return { el, value, key };
  };
  const stats = [stat('Neu', 'downloaded', 'accent'), stat('Vorhanden', 'skipped', 'neutral'), stat('Fehler', 'errors', 'danger')];
  const statsCaption = h('p', { class: 'stats-caption' });
  const statsSection = h(
    'section',
    { class: 'stats-section', 'aria-label': 'Kennzahlen' },
    h('div', { class: 'stats' }, stats.map((s) => s.el)),
    statsCaption,
  );

  // ---- Kurse
  const courseList = h('ul', { class: 'course-list' });
  const courseCaption = h('span', { class: 'card-caption' });
  const coursesCard = h(
    'section',
    { class: 'card', 'aria-labelledby': 'courses-title' },
    h('div', { class: 'card-head' }, h('h2', { id: 'courses-title' }, 'Kurse'), courseCaption),
    courseList,
  );
  const rowCache = new Map();

  // ---- Zuletzt geladen
  const search = h('input', {
    class: 'input input-search',
    type: 'search',
    placeholder: 'Dateien durchsuchen …',
    'aria-label': 'Dateien durchsuchen',
    autocomplete: 'off',
  });
  const courseFilter = h('select', { class: 'input select', 'aria-label': 'Nach Kurs filtern' });
  const typeFilter = h('select', { class: 'input select', 'aria-label': 'Nach Dateityp filtern' });
  const fileCount = h('span', { class: 'card-caption', 'aria-live': 'polite' });
  const fileList = h('ul', { class: 'file-list', 'aria-label': 'Zuletzt geladene Dateien' });
  const filesCard = h(
    'section',
    { class: 'card', 'aria-labelledby': 'files-title' },
    h('div', { class: 'card-head' }, h('h2', { id: 'files-title' }, 'Zuletzt geladen'), fileCount),
    h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'search-field' }, icon('search', { size: 15 }), search),
      courseFilter,
      typeFilter,
    ),
    fileList,
  );

  root.append(header, statusCard, notices, runPanel, statsSection, coursesCard, filesCard);

  // ------------------------------------------------------------------ Aktualisierung

  function updateStatus() {
    const status = store.status;
    if (!status) return;
    const st = deriveState(status);
    statusCard.dataset.tone = st.tone;
    statusIcon.replaceChildren(icon(st.icon, { size: 26, className: st.tone === 'running' ? 'spin' : '' }));
    statusTitle.textContent = st.title;
    statusSub.textContent = st.sub;
    const next = nextScheduledRun(status.schedule);
    statusNext.textContent = status.running ? '' : next ? `Nächster automatischer Lauf ${next}` : 'Automatischer Lauf ist ausgeschaltet';
    const sem = status.current?.semester ?? status.last_run?.semester;
    semester.textContent = sem ?? '';
    semester.hidden = !sem;

    const running = Boolean(status.running);
    syncBtn.disabled = running;
    syncBtn.querySelector('.btn-label').textContent = running ? 'Synchronisiert …' : 'Jetzt synchronisieren';
    syncBtn.querySelector('.icon').classList.toggle('spin', running);
    dryBtn.hidden = running;
    cancelBtn.hidden = !running;

    if (running) {
      if (!panelOpen) panelOpen = true;
      lastFinished = null;
    }
    updateNotices();
    updateRunPanel();
    updateStats();
    updateCourses();
  }

  function updateNotices() {
    const status = store.status;
    const items = [];
    const last = status.last_run;
    if (store.loginPending) {
      items.push(
        notice({
          tone: 'info',
          iconName: 'user',
          title: 'Anmeldefenster ist geöffnet',
          text: 'Bitte im Chromium-Fenster bei ILIAS anmelden. Dieser Hinweis verschwindet, sobald die Sitzung gültig ist.',
        }),
      );
    } else if (!status.running && sessionExpired(status)) {
      items.push(
        notice({
          tone: 'danger',
          iconName: 'lock',
          title: 'Deine ILIAS-Sitzung ist abgelaufen',
          text: 'Melde dich einmal neu an – danach laufen die Synchronisierungen wieder automatisch.',
          actions: [
            button('Neu anmelden', { icon: 'user', variant: 'primary', onclick: () => actions.login() }),
            button('Sitzung prüfen', { variant: 'secondary', onclick: () => actions.checkSession() }),
          ],
        }),
      );
    } else if (!status.running && last?.result === 'offline') {
      items.push(
        notice({
          tone: 'muted',
          iconName: 'offline',
          title: 'ILIAS war nicht erreichbar',
          text: `${last.message ? `${last.message} ` : ''}Kein Grund zur Sorge: Der nächste geplante Lauf versucht es automatisch erneut.`,
          actions: [button('Erneut versuchen', { icon: 'sync', variant: 'secondary', onclick: () => actions.startSync(false) })],
        }),
      );
    } else if (!status.running && last?.result === 'failed' && last.message) {
      items.push(notice({ tone: 'danger', iconName: 'error', title: 'Der letzte Lauf ist fehlgeschlagen', text: last.message }));
    }
    if (!status.credentials_configured) {
      items.push(
        notice({
          tone: 'info',
          iconName: 'key',
          title: 'Keine Zugangsdaten gespeichert',
          text: 'Ohne gespeicherte Zugangsdaten kann sich ILIAS Sync nicht selbst neu anmelden, wenn die Sitzung abläuft.',
          actions: [button('Zugangsdaten hinterlegen', { variant: 'secondary', onclick: () => ctx.navigate('einstellungen') })],
        }),
      );
    }
    // Nur neu aufbauen, wenn sich die Hinweise ändern (Fokus bleibt sonst erhalten).
    const key = items.map((n) => n.textContent).join('|');
    if (key === noticeKey) return;
    noticeKey = key;
    notices.replaceChildren(...items);
    notices.hidden = !items.length;
  }

  function updateRunPanel() {
    const status = store.status;
    runPanel.hidden = !panelOpen;
    logToggle.setAttribute('aria-expanded', String(panelOpen));
    logToggle.classList.toggle('is-active', panelOpen);
    if (!panelOpen) return;
    const running = Boolean(status?.running);
    runPanel.dataset.state = running ? 'running' : lastFinished ? lastFinished.result : 'idle';
    runClose.hidden = running;
    clearInterval(elapsedTimer);

    if (running) {
      const cur = status.current ?? {};
      const p = cur.progress;
      const kind = cur.dry_run ? 'Probelauf' : 'Synchronisierung';
      if (p && p.courses_total) {
        const n = Math.min(p.courses_done + (p.current_course ? 1 : 0), p.courses_total);
        runLabel.replaceChildren(
          icon('sync', { size: 15, className: 'spin' }),
          h('strong', {}, kind),
          h('span', { class: 'muted' }, p.current_course ? ` · Kurs ${n} von ${p.courses_total}: ${p.current_course}` : ` · ${p.courses_done} von ${p.courses_total} Kursen`),
        );
        const pct = Math.round((p.courses_done / p.courses_total) * 100);
        progress.classList.remove('indeterminate');
        progressBar.style.width = `${Math.max(3, pct)}%`;
        progress.setAttribute('aria-valuenow', String(pct));
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', '100');
      } else {
        const doneCount = cur.courses?.length ?? 0;
        runLabel.replaceChildren(
          icon('sync', { size: 15, className: 'spin' }),
          h('strong', {}, kind),
          h('span', { class: 'muted' }, doneCount ? ` · ${plural(doneCount, 'Kurs', 'Kurse')} fertig` : ' · wird vorbereitet …'),
        );
        progress.classList.add('indeterminate');
        progressBar.style.width = '';
        progress.removeAttribute('aria-valuenow');
      }
      progress.hidden = false;
      const tick = () => {
        runElapsed.textContent = fmtClock(runDurationSeconds(cur) ?? 0);
      };
      tick();
      elapsedTimer = setInterval(tick, 1000);
    } else if (lastFinished) {
      const t = lastFinished.totals ?? {};
      runLabel.replaceChildren(
        resultPill(lastFinished.result),
        h('span', { class: 'muted' }, ` ${lastFinished.dry_run ? 'Probelauf' : 'Lauf'} beendet · ${fmtNumber(t.downloaded ?? 0)} neu · ${fmtNumber(t.skipped ?? 0)} vorhanden · ${fmtNumber(t.errors ?? 0)} Fehler`),
      );
      progress.classList.remove('indeterminate');
      progressBar.style.width = '100%';
      progress.hidden = false;
      runElapsed.textContent = fmtClock(runDurationSeconds(lastFinished) ?? 0);
    } else {
      runLabel.replaceChildren(icon('book', { size: 15 }), h('strong', {}, 'Protokoll'), h('span', { class: 'muted' }, ' · letzte Ausgaben'));
      progress.hidden = true;
      runElapsed.textContent = '';
    }
  }

  function updateStats() {
    const status = store.status;
    const run = status.running ? status.current : status.last_run;
    const t = run?.totals;
    for (const s of stats) {
      s.value.textContent = t ? fmtNumber(t[s.key] ?? 0) : '–';
      s.el.classList.toggle('is-zero', !t || !t[s.key]);
    }
    if (status.running) statsCaption.textContent = 'Im aktuellen Lauf';
    else if (run) statsCaption.textContent = `Im letzten Lauf (${fmtDayTime(run.started_at)})${t ? ` · ${fmtNumber(t.found ?? 0)} Dateien in ILIAS gefunden` : ''}`;
    else statsCaption.textContent = 'Noch kein Lauf';
  }

  function updateCourses() {
    const { rows, baseRun } = courseRows(store.status, store.runs);
    if (!rows.length) {
      rowCache.clear();
      courseList.replaceChildren(
        h(
          'li',
          { class: 'empty' },
          store.status.last_run ? 'Im letzten Lauf wurden keine Kurse verarbeitet.' : 'Nach dem ersten Lauf erscheinen hier deine Kurse.',
        ),
      );
      courseCaption.textContent = '';
      return;
    }
    const fromOlder = baseRun && baseRun !== store.status.last_run && !store.status.running;
    courseCaption.textContent = `${plural(rows.length, 'Kurs', 'Kurse')}${fromOlder ? ` · Stand ${fmtDayTime(baseRun.started_at)}` : ''}`;
    const els = rows.map((row) => {
      const sig = JSON.stringify(row);
      const cached = rowCache.get(row.name);
      if (cached && cached.sig === sig) return cached.el;
      const el = renderCourse(row);
      rowCache.set(row.name, { sig, el });
      return el;
    });
    const keep = new Set(rows.map((r) => r.name));
    for (const key of rowCache.keys()) if (!keep.has(key)) rowCache.delete(key);
    // Nur austauschen, was sich geändert hat (Fokus und Scrollposition bleiben erhalten).
    els.forEach((el, i) => {
      if (courseList.children[i] !== el) courseList.insertBefore(el, courseList.children[i] ?? null);
    });
    while (courseList.children.length > els.length) courseList.lastElementChild.remove();
  }

  function renderCourse(c) {
    const stateIcon = {
      done: icon('checkCircle', { size: 18 }),
      error: icon('warning', { size: 18 }),
      active: icon('sync', { size: 18, className: 'spin' }),
      pending: icon('clock', { size: 18 }),
    }[c.state];
    const stateLabel = { done: 'Fertig', error: 'Mit Fehlern', active: 'Wird synchronisiert', pending: 'Wartet' }[c.state];
    const counts =
      c.state === 'pending' || c.state === 'active'
        ? [h('span', { class: 'count muted' }, c.state === 'active' ? 'wird geprüft …' : 'wartet')]
        : [
            h('span', { class: `count${c.downloaded ? ' count-new' : ''}` }, h('b', { class: 'tabular' }, fmtNumber(c.downloaded ?? 0)), ' neu'),
            h('span', { class: 'count' }, h('b', { class: 'tabular' }, fmtNumber(c.skipped ?? 0)), ' vorhanden'),
            c.errors ? h('span', { class: 'count count-error' }, h('b', { class: 'tabular' }, fmtNumber(c.errors)), c.errors === 1 ? ' Fehler' : ' Fehler') : null,
          ];
    const title = c.short_name || c.name;
    return h(
      'li',
      { class: 'course', dataset: { state: c.state } },
      h('span', { class: 'course-state', title: stateLabel, 'aria-label': stateLabel, role: 'img' }, stateIcon),
      h('div', { class: 'course-text' }, h('span', { class: 'course-name' }, title), c.name && c.name !== title ? h('span', { class: 'course-full' }, c.name) : null),
      h('div', { class: 'course-counts' }, counts),
      c.url
        ? h(
            'a',
            { class: 'btn btn-icon', href: c.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${title} in ILIAS öffnen`, title: 'In ILIAS öffnen' },
            icon('external', { size: 15 }),
          )
        : h('span'),
      c.error_message
        ? h(
            'p',
            { class: 'course-error' },
            icon('warning', { size: 14 }),
            h('span', {}, c.error_message, ' '),
            c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'In ILIAS ansehen') : null,
          )
        : null,
    );
  }

  // ---- Dateien

  let filterState = { q: '', course: '', kind: '' };

  function updateFilterOptions() {
    const files = store.files ?? [];
    const courses = [...new Set(files.map((f) => f.course).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
    const kinds = new Map();
    for (const f of files) {
      const k = fileKind(f.name);
      kinds.set(k.kind, k.label);
    }
    const sel = (selectEl, allLabel, entries, value) => {
      selectEl.replaceChildren(h('option', { value: '' }, allLabel), ...entries.map(([v, l]) => h('option', { value: v }, l)));
      selectEl.value = entries.some(([v]) => v === value) ? value : '';
    };
    sel(courseFilter, 'Alle Kurse', courses.map((c) => [c, c]), filterState.course);
    sel(typeFilter, 'Alle Typen', [...kinds.entries()].sort((a, b) => a[1].localeCompare(b[1], 'de')), filterState.kind);
    filterState.course = courseFilter.value;
    filterState.kind = typeFilter.value;
  }

  function updateFiles() {
    const files = store.files;
    if (!files) {
      fileList.replaceChildren(h('li', { class: 'empty' }, 'Lade …'));
      return;
    }
    const q = filterState.q.trim().toLowerCase();
    const shown = files.filter((f) => {
      if (filterState.course && f.course !== filterState.course) return false;
      if (filterState.kind && fileKind(f.name).kind !== filterState.kind) return false;
      if (q && ![f.name, f.course, f.folder].some((v) => v?.toLowerCase().includes(q))) return false;
      return true;
    });
    fileCount.textContent = shown.length === files.length ? plural(files.length, 'Datei', 'Dateien') : `${fmtNumber(shown.length)} von ${fmtNumber(files.length)}`;
    if (!files.length) {
      fileList.replaceChildren(h('li', { class: 'empty' }, 'Noch keine Dateien geladen. Neue Kursmaterialien erscheinen hier nach dem nächsten Lauf.'));
      return;
    }
    if (!shown.length) {
      fileList.replaceChildren(h('li', { class: 'empty' }, 'Keine Dateien passen zum Filter.'));
      return;
    }
    fileList.replaceChildren(...shown.map(renderFile));
  }

  function renderFile(f) {
    const kind = fileKind(f.name);
    return h(
      'li',
      { class: 'file-row' },
      h(
        'button',
        { type: 'button', class: 'file-open', title: `${f.name} öffnen`, onclick: () => actions.openFile(f.path) },
        h('span', { class: `file-icon kind-${kind.kind}`, title: kind.label }, icon(kind.icon, { size: 20 })),
        h(
          'span',
          { class: 'file-text' },
          h('span', { class: 'file-name' }, f.name),
          h('span', { class: 'file-meta' }, [f.course, f.folder].filter(Boolean).join(' · ')),
        ),
        h('span', { class: 'file-size tabular' }, fmtBytes(f.size)),
        h('time', { class: 'file-date', datetime: f.downloaded_at, title: new Date(f.downloaded_at).toLocaleString('de-DE') }, fmtDayTime(f.downloaded_at)),
      ),
      iconButton('reveal', REVEAL_LABEL, { onclick: () => actions.revealFile(f.path), class: 'file-reveal' }),
    );
  }

  search.addEventListener(
    'input',
    debounce(() => {
      filterState.q = search.value;
      updateFiles();
    }, 120),
  );
  courseFilter.addEventListener('change', () => {
    filterState.course = courseFilter.value;
    updateFiles();
  });
  typeFilter.addEventListener('change', () => {
    filterState.kind = typeFilter.value;
    updateFiles();
  });

  // ------------------------------------------------------------------ Ereignisse

  cleanups.push(
    store.on('status', updateStatus),
    store.on('runs', updateCourses),
    store.on('files', () => {
      updateFilterOptions();
      updateFiles();
    }),
    store.on('log', (line) => logView.add([line])),
    store.on('logs:reset', (lines) => logView.setLines(lines)),
    store.on('run_finished', (report) => {
      lastFinished = report;
      panelOpen = true;
      updateRunPanel();
    }),
    store.on('tick', () => {
      updateStatus();
      for (const t of fileList.querySelectorAll('time.file-date')) t.textContent = fmtDayTime(t.dateTime);
    }),
  );

  updateStatus();
  updateFilterOptions();
  updateFiles();

  return {
    unmount() {
      cleanups.forEach((fn) => fn());
      clearInterval(elapsedTimer);
      logView.destroy();
    },
  };
}
