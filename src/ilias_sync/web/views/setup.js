// Ersteinrichtung in fünf Schritten: Willkommen → Anmelden → Speicherort → Automatik → Test.
// Alles ist sinnvoll vorbelegt – im Normalfall tippt man nur die Zugangsdaten ein.
// Ob der Assistent erscheint, entscheidet das Backend (status.setup), nicht localStorage.
import { h, button, plural, fmtNumber } from '../util.js';
import { icon } from '../icons.js';
import { LogView, settingRow, switchInput, showFieldErrors, clearFieldErrors, nextId, announce } from '../components.js';
import { errorMessage } from '../api.js';
import { folderInput, credentialsBlock, scheduleBlock, browserBlock } from './forms.js';

const STEPS = [
  { key: 'welcome', title: 'Willkommen' },
  { key: 'credentials', title: 'Anmelden' },
  { key: 'folder', title: 'Speicherort' },
  { key: 'automation', title: 'Automatik' },
  { key: 'test', title: 'Test' },
];
const CUSTOM = 'custom';
const RECOMMENDED_SCHEDULE = { enabled: true, time: '09:00', run_at_login: true };

/** Vergleich von Ordnerpfaden ohne abschließenden Schrägstrich. */
const samePath = (a, b) => Boolean(a && b) && a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Auswahlkarten auf Basis echter Radiobuttons: Pfeiltasten, Tab und Leertaste
 * funktionieren wie gewohnt, Screenreader lesen eine Radiogruppe vor.
 */
function choiceCards({ name, legend, options, value, onchange }) {
  const group = h('fieldset', { class: 'choice-group' }, h('legend', { class: 'visually-hidden' }, legend));
  const inputs = [];
  for (const opt of options) {
    const id = nextId(name);
    const descId = `${id}-desc`;
    const input = h('input', { type: 'radio', class: 'choice-input', name, id, value: opt.value, checked: opt.value === value, 'aria-describedby': descId });
    inputs.push(input);
    group.append(
      h(
        'label',
        { class: 'choice-card', for: id, dataset: { value: opt.value } },
        input,
        h('span', { class: `choice-icon${opt.tone ? ` tone-${opt.tone}` : ''}`, 'aria-hidden': 'true' }, icon(opt.icon, { size: 20 })),
        h(
          'span',
          { class: 'choice-text' },
          h('span', { class: 'choice-title' }, opt.label, opt.badge ? h('span', { class: 'badge badge-soft' }, opt.badge) : null),
          h('span', { class: 'choice-desc', id: descId }, opt.description, opt.path ? h('code', { class: 'choice-path' }, opt.path) : null),
        ),
        h('span', { class: 'choice-check', 'aria-hidden': 'true' }, icon('check', { size: 13 })),
      ),
    );
  }
  const sync = () => {
    for (const input of inputs) input.closest('.choice-card').classList.toggle('is-selected', input.checked);
  };
  group.addEventListener('change', () => {
    sync();
    onchange?.(group.querySelector('input:checked')?.value);
  });
  sync();
  return {
    el: group,
    get value() {
      return group.querySelector('input:checked')?.value ?? null;
    },
    focus() {
      (group.querySelector('input:checked') ?? inputs[0])?.focus();
    },
  };
}

export function mount(root, ctx) {
  const { api, store } = ctx;
  let step = 0;
  let data = null;
  let blocks = {};
  let dryRunReport = null;
  let stepCleanups = [];
  let busy = false;

  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Fortschritt der Einrichtung' });
  const progressBar = h('div', { class: 'wizard-progress-bar' });
  const progress = h('div', { class: 'wizard-progress', role: 'progressbar', 'aria-label': 'Fortschritt', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length) }, progressBar);
  const stepBody = h('div', { class: 'wizard-body' });
  const backBtn = button('Zurück', { variant: 'secondary', onclick: () => go(step - 1) });
  const skipBtn = button('Später einrichten', { variant: 'ghost', onclick: () => finish(false) });
  const nextBtn = button('Weiter', { variant: 'primary', onclick: () => next() });
  const heading = h('h1', { class: 'wizard-title', tabindex: '-1' }, 'ILIAS Sync einrichten');
  const counter = h('p', { class: 'wizard-counter' });

  const card = h(
    'div',
    { class: 'wizard card' },
    h('div', { class: 'wizard-head' }, h('div', { class: 'wizard-logo' }, icon('logo', { size: 26 })), h('div', { class: 'wizard-head-text' }, heading, counter), stepper),
    progress,
    stepBody,
    h('div', { class: 'wizard-foot' }, backBtn, skipBtn, h('span', { class: 'spacer' }), nextBtn),
  );
  root.append(h('div', { class: 'wizard-page' }, card));

  // Enter in einem Textfeld bedeutet „Weiter“ (nicht im Protokoll oder auf Knöpfen).
  stepBody.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('input[type=text], input[type=password], input[type=url], input[type=time]')) {
      ev.preventDefault();
      next();
    }
  });

  Promise.all([api.getConfig(), api.getCredentials(), api.getSchedule(), api.getSetupSuggestions().catch(() => null)])
    .then(([config, credentials, schedule, suggestions]) => {
      data = { config, credentials, schedule, suggestions, defaults: suggestions?.defaults ?? null };
      go(0, { focusHeading: true });
    })
    .catch((err) => {
      stepBody.replaceChildren(h('p', { class: 'empty' }, `Einrichtung konnte nicht geladen werden: ${errorMessage(err)}`));
    });

  function renderStepper() {
    stepper.replaceChildren(
      ...STEPS.map((s, i) =>
        h(
          'li',
          { class: `step${i === step ? ' is-current' : ''}${i < step ? ' is-done' : ''}`, 'aria-current': i === step ? 'step' : null },
          h('span', { class: 'step-num', 'aria-hidden': 'true' }, i < step ? icon('check', { size: 12 }) : String(i + 1)),
          h('span', { class: 'step-title' }, s.title, i < step ? h('span', { class: 'visually-hidden' }, ' (erledigt)') : null),
        ),
      ),
    );
    counter.textContent = `Schritt ${step + 1} von ${STEPS.length} · ${STEPS[step].title}`;
    progressBar.style.width = `${((step + 1) / STEPS.length) * 100}%`;
    progress.setAttribute('aria-valuenow', String(step + 1));
    progress.setAttribute('aria-valuetext', `Schritt ${step + 1} von ${STEPS.length}: ${STEPS[step].title}`);
  }

  function go(index, { focusHeading = false } = {}) {
    stepCleanups.forEach((fn) => fn());
    stepCleanups = [];
    step = Math.max(0, Math.min(STEPS.length - 1, index));
    renderStepper();
    backBtn.hidden = step === 0;
    skipBtn.hidden = step === STEPS.length - 1;
    nextBtn.disabled = false;
    const key = STEPS[step].key;
    stepBody.replaceChildren(renderStep(key));
    updateNextLabel();
    // Fokus: Beim Start die Überschrift, sonst das erste sinnvolle Feld bzw. die Schrittüberschrift.
    if (focusHeading) heading.focus({ preventScroll: true });
    else {
      const target = key === 'credentials' && !data.credentials.configured ? stepBody.querySelector('input') : stepBody.querySelector('h2');
      target?.focus({ preventScroll: true });
      announce(`Schritt ${step + 1} von ${STEPS.length}: ${STEPS[step].title}`);
    }
    card.scrollIntoView?.({ block: 'start' });
  }

  function updateNextLabel() {
    const key = STEPS[step].key;
    let label = 'Weiter';
    if (key === 'welcome') label = 'Los geht’s';
    if (key === 'credentials' && (blocks.creds?.hasInput() || !data.credentials.configured)) label = 'Speichern und weiter';
    if (key === 'test') label = 'Fertig';
    nextBtn.querySelector('.btn-label').textContent = label;
  }

  const stepSection = (id, title, lead, ...children) =>
    h('section', { class: 'wizard-step', 'aria-labelledby': id }, h('h2', { id, tabindex: '-1' }, title), lead ? h('p', { class: 'wizard-step-lead' }, lead) : null, ...children);

  function renderStep(key) {
    if (key === 'welcome') return renderWelcome();
    if (key === 'credentials') return renderCredentials();
    if (key === 'folder') return renderFolder();
    if (key === 'automation') return renderAutomation();
    return renderTest();
  }

  // ------------------------------------------------------------ 1 Willkommen

  function renderWelcome() {
    const defaults = data.defaults ?? {};
    const isDefault = !defaults.base_url || (data.config.base_url === defaults.base_url && data.config.login_url === defaults.login_url);
    const errors = new Map();
    const baseId = nextId('wz-base');
    const loginId = nextId('wz-login');
    const base = h('input', { id: baseId, class: 'input mono', type: 'url', value: isDefault ? '' : data.config.base_url, placeholder: 'https://ilias.example-uni.de/ilias/', spellcheck: 'false' });
    const login = h('input', { id: loginId, class: 'input mono', type: 'url', value: isDefault ? '' : data.config.login_url, placeholder: 'https://ilias.example-uni.de/ilias/login.php?…', spellcheck: 'false' });
    const other = h(
      'div',
      { class: 'choice-extra', id: nextId('wz-other') },
      settingRow({ label: 'ILIAS-Adresse', description: 'Startseite deiner ILIAS-Instanz, endet meist auf „/ilias/“.', control: base, forId: baseId, stacked: true, errorKey: 'base_url', errors }),
      settingRow({ label: 'Login-Adresse', description: 'Seite mit dem Anmeldeformular.', control: login, forId: loginId, stacked: true, errorKey: 'login_url', errors }),
    );
    const school = choiceCards({
      name: 'school',
      legend: 'Hochschule',
      value: isDefault ? 'uk' : 'other',
      options: [
        { value: 'uk', icon: 'school', label: 'Universität zu Köln', description: 'ILIAS der Uni Köln – alles ist bereits eingestellt.', badge: 'Empfohlen' },
        { value: 'other', icon: 'globe', label: 'Andere ILIAS-Instanz', description: 'Für andere Hochschulen: Adressen selbst eintragen.' },
      ],
      onchange: (v) => {
        other.hidden = v !== 'other';
        if (v === 'other') base.focus();
      },
    });
    other.hidden = school.value !== 'other';
    blocks.welcome = { school, base, login, errors };

    const feature = (iconName, title, text) =>
      h('li', { class: 'feature' }, h('span', { class: 'feature-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 18 })), h('div', {}, h('strong', {}, title), h('p', {}, text)));
    return stepSection(
      'wz-welcome',
      'Willkommen!',
      'ILIAS Sync hält deine Kursmaterialien aktuell – du musst dafür nichts mehr anklicken.',
      h(
        'ul',
        { class: 'feature-list' },
        feature('download', 'Lädt neue Dateien automatisch', 'Folien, Übungsblätter und Skripte landen sortiert nach Kurs in einem Ordner deiner Wahl.'),
        feature('shield', 'Passwort bleibt sicher', 'Deine Zugangsdaten liegen nur im Schlüsselbund deines Systems – nie in Dateien oder Protokollen.'),
        feature('laptop', 'Nichts wird hochgeladen', 'ILIAS Sync läuft nur auf diesem Computer und lädt ausschließlich herunter.'),
      ),
      h('h3', { class: 'wizard-subhead' }, 'Deine Hochschule'),
      school.el,
      other,
    );
  }

  // ------------------------------------------------------------ 2 Anmelden

  function renderCredentials() {
    blocks.creds = credentialsBlock(ctx, {
      credentials: data.credentials,
      embedded: true,
      onChange: (c) => {
        data.credentials = c;
        updateNextLabel();
      },
    });
    const onInput = () => updateNextLabel();
    blocks.creds.el.addEventListener('input', onInput);
    return stepSection(
      'wz-cred',
      'Bei ILIAS anmelden',
      data.credentials.configured
        ? 'Es sind bereits Zugangsdaten gespeichert. Du kannst sie hier ersetzen oder einfach weitergehen.'
        : 'Mit deiner Uni-Kennung meldet sich ILIAS Sync selbst neu an, wenn die Sitzung abläuft.',
      blocks.creds.el,
    );
  }

  // ------------------------------------------------------------ 3 Speicherort

  function renderFolder() {
    const errors = new Map();
    const fallback = { id: 'documents', label: 'Dokumente', description: 'Nur auf diesem Computer.', path: data.defaults?.download_dir ?? '~/Documents/Uni', kind: 'local', exists: false };
    const suggestions = data.suggestions?.download_dirs?.length ? data.suggestions.download_dirs : [fallback];
    const current = data.config.download_dir;
    const match = suggestions.find((s) => samePath(s.path, current));
    // Eigene Ordner bestehender Installationen nicht stillschweigend ersetzen.
    const isCustom = !match && current && !samePath(current, data.defaults?.download_dir);
    const initial = match?.id ?? (isCustom ? CUSTOM : suggestions[0].id);

    const customId = nextId('wz-custom');
    const custom = folderInput({ id: customId, value: isCustom ? current : '', placeholder: '/Pfad/zu/deinem/Ordner' });
    const customBox = h(
      'div',
      { class: 'choice-extra' },
      settingRow({ label: 'Eigener Ordner', description: 'Pro Kurs entsteht darin ein Unterordner.', control: custom.el, forId: customId, stacked: true, errorKey: 'download_dir', errors }),
    );
    const cards = choiceCards({
      name: 'folder',
      legend: 'Speicherort für Kursmaterialien',
      value: initial,
      options: [
        ...suggestions.map((s, i) => ({
          value: s.id,
          icon: s.kind === 'cloud' ? 'cloud' : 'laptop',
          tone: s.kind === 'cloud' ? 'cloud' : null,
          label: s.label,
          description: s.description,
          path: s.path,
          badge: s.exists ? 'existiert bereits' : i === 0 ? 'Empfohlen' : null,
        })),
        { value: CUSTOM, icon: 'folder', label: 'Eigener Ordner …', description: 'Einen beliebigen Ordner wählen.' },
      ],
      onchange: (v) => {
        customBox.hidden = v !== CUSTOM;
        if (v === CUSTOM) custom.input.focus();
      },
    });
    customBox.hidden = cards.value !== CUSTOM;

    const localId = nextId('wz-local');
    const local = folderInput({ id: localId, value: data.config.local_download_dir ?? '', placeholder: 'optional, z. B. ein Cloud-Ordner' });
    const copy = h(
      'details',
      { class: 'wizard-details', open: Boolean(data.config.local_download_dir) },
      h('summary', {}, icon('chevronRight', { size: 14, className: 'chev' }), 'Zusätzliche Kopie anlegen (optional)'),
      settingRow({
        label: 'Zweiter Ordner',
        description: 'Neue Dateien werden zusätzlich hierhin kopiert – praktisch für einen Cloud- oder USB-Ordner.',
        control: local.el,
        forId: localId,
        stacked: true,
        errorKey: 'local_download_dir',
        errors,
      }),
    );
    blocks.folder = { cards, custom, local, errors, suggestions, copy };
    return stepSection('wz-folder', 'Wo sollen die Dateien hin?', 'Pro Kurs entsteht ein Unterordner. Bereits vorhandene Dateien werden nicht doppelt geladen.', cards.el, customBox, copy);
  }

  // ------------------------------------------------------------ 4 Automatik

  function renderAutomation() {
    const sched = data.schedule;
    // Neue Nutzer bekommen die Empfehlung; wer schon Läufe hat, sieht seinen Stand.
    const prefill = sched.supported === false ? sched : sched.enabled || store.status?.last_run ? sched : { ...sched, ...RECOMMENDED_SCHEDULE };
    blocks.schedule = scheduleBlock(ctx, prefill, { withSave: false });
    const notifyId = nextId('wz-notify');
    const fallbackId = nextId('wz-fallback');
    const notify = switchInput({ id: notifyId, checked: data.config.notifications ?? true });
    const fallback = switchInput({ id: fallbackId, checked: data.config.open_login_window_on_failure ?? true });
    blocks.automation = { notify, fallback };
    return stepSection(
      'wz-auto',
      'Automatisch aktuell bleiben',
      'Empfohlen ist ein täglicher Lauf. Du kannst jederzeit zusätzlich von Hand synchronisieren.',
      h('div', { class: 'wizard-group' }, h('h3', { class: 'wizard-subhead' }, icon('calendar', { size: 15 }), 'Zeitplan'), blocks.schedule.el),
      h(
        'div',
        { class: 'wizard-group' },
        h('h3', { class: 'wizard-subhead' }, icon('bell', { size: 15 }), 'Benachrichtigungen'),
        settingRow({ label: 'Mitteilungen anzeigen', description: 'Meldet neue Dateien oder eine nötige Anmeldung nach einem geplanten Lauf.', control: notify, forId: notifyId }),
        settingRow({
          label: 'Login-Fenster bei abgelaufener Sitzung',
          description: 'Öffnet bei Bedarf das ILIAS-Login und versucht den Sync danach erneut.',
          control: fallback,
          forId: fallbackId,
        }),
      ),
    );
  }

  // ------------------------------------------------------------ 5 Test

  function renderTest() {
    const log = new LogView({ label: 'Protokoll des Probelaufs', height: '200px' });
    const result = h('div', { class: 'dry-result', 'aria-live': 'polite' });
    const startBtn = button('Probelauf starten', { icon: 'flask', variant: 'primary', onclick: () => start() });
    const realBtn = button('Jetzt richtig synchronisieren', {
      icon: 'sync',
      variant: 'secondary',
      onclick: async () => {
        await finish(true);
        ctx.actions.startSync(false);
      },
    });
    realBtn.hidden = true;
    log.el.hidden = true;

    // Fehlt Chromium, muss es vor dem Probelauf installiert werden.
    const browser = browserBlock(ctx);
    const browserBox = h(
      'div',
      { class: 'notice notice-danger wizard-browser' },
      h('div', { class: 'notice-icon' }, icon('browser', { size: 20 })),
      h(
        'div',
        { class: 'notice-body' },
        h('strong', { class: 'notice-title' }, 'Zuerst: Browser-Komponente installieren'),
        h('p', {}, 'ILIAS Sync meldet sich mit einem eigenen Chromium bei ILIAS an. Das ist einmalig nötig (ca. 150 MB, wenige Minuten).'),
        browser.el,
      ),
    );
    const updateBrowser = () => {
      const missing = ctx.actions.browserMissing() || Boolean(store.browser?.installing);
      browserBox.hidden = !missing;
      startBtn.disabled = missing || Boolean(store.status?.running);
    };
    stepCleanups.push(store.on('browser', updateBrowser), store.on('status', updateBrowser), browser.destroy);

    const offLog = store.on('log', (line) => !log.el.hidden && log.add([line]));
    const offFinish = store.on('run_finished', (report) => {
      if (!report.dry_run) return;
      dryRunReport = report;
      showResult(report);
    });
    stepCleanups.push(offLog, offFinish, () => log.destroy());

    async function start() {
      startBtn.disabled = true;
      log.el.hidden = false;
      log.setLines([]);
      result.replaceChildren(h('p', { class: 'muted running-line' }, icon('sync', { size: 14, className: 'spin' }), ' Probelauf läuft – es werden keine Dateien gespeichert …'));
      const err = await ctx.actions.startSync(true);
      if (err) {
        startBtn.disabled = false;
        result.replaceChildren();
      }
    }

    function showResult(report) {
      const t = report.totals ?? {};
      const ok = report.result === 'success' || report.result === 'errors';
      updateBrowser();
      startBtn.querySelector('.btn-label').textContent = 'Erneut testen';
      realBtn.hidden = !ok;
      result.replaceChildren(
        h(
          'div',
          { class: `notice notice-${ok ? 'success' : 'danger'}` },
          h('div', { class: 'notice-icon' }, icon(ok ? 'checkCircle' : 'warning', { size: 20 })),
          h(
            'div',
            { class: 'notice-body' },
            h('strong', { class: 'notice-title' }, ok ? 'Verbindung klappt!' : 'Der Probelauf hat nicht geklappt'),
            h(
              'p',
              {},
              ok
                ? `${plural(report.courses?.length ?? 0, 'Kurs', 'Kurse')} gefunden, ${fmtNumber(t.found ?? 0)} Dateien erkannt, davon ${fmtNumber(t.skipped ?? 0)} bereits vorhanden. Mit „Fertig“ ist alles eingerichtet.`
                : report.message || 'Bitte Zugangsdaten und Verbindung prüfen. Du kannst trotzdem fertigstellen und es später erneut versuchen.',
            ),
          ),
        ),
      );
    }

    const summary = summaryList();
    const el = stepSection(
      'wz-test',
      'Alles testen',
      'Der Probelauf meldet sich an, sucht deine Kurse und zeigt, was geladen würde – ohne etwas zu speichern.',
      summary,
      browserBox,
      h('div', { class: 'row-actions' }, startBtn, realBtn),
      result,
      log.el,
    );
    updateBrowser();
    if (dryRunReport) showResult(dryRunReport);
    return el;
  }

  /** Kurze Zusammenfassung der gewählten Einstellungen. */
  function summaryList() {
    const s = data.schedule;
    const item = (iconName, label, value) => h('li', {}, h('span', { class: 'summary-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 15 })), h('span', { class: 'summary-label' }, label), h('span', { class: 'summary-value' }, value));
    return h(
      'ul',
      { class: 'wizard-summary', 'aria-label': 'Deine Einstellungen' },
      item('key', 'Anmeldung', data.credentials.configured ? `gespeichert für ${data.credentials.username ?? '***'}` : 'keine Zugangsdaten'),
      item('folder', 'Ordner', h('code', {}, data.config.download_dir)),
      item('calendar', 'Zeitplan', s.supported === false ? 'manuell einrichten' : s.enabled ? `täglich um ${s.time} Uhr${s.run_at_login ? ' und beim Anmelden' : ''}` : 'aus'),
    );
  }

  // ------------------------------------------------------------ Navigation

  async function saveConfig(partial, errors) {
    clearFieldErrors(errors);
    try {
      data.config = (await api.putConfig(partial)) ?? { ...data.config, ...partial };
      return true;
    } catch (err) {
      if (err.fields) showFieldErrors(errors, err.fields);
      else ctx.toast(errorMessage(err), { tone: 'danger' });
      return false;
    }
  }

  async function next() {
    if (busy || !data) return;
    const key = STEPS[step].key;
    busy = true;
    nextBtn.disabled = true;
    try {
      if (key === 'welcome') {
        const { school, base, login, errors } = blocks.welcome;
        const defaults = data.defaults ?? {};
        let partial = null;
        if (school.value === 'other') {
          partial = { base_url: base.value.trim(), login_url: login.value.trim() };
          if (!partial.base_url || !partial.login_url) {
            showFieldErrors(errors, {
              ...(partial.base_url ? {} : { base_url: 'Bitte die ILIAS-Adresse eintragen.' }),
              ...(partial.login_url ? {} : { login_url: 'Bitte die Login-Adresse eintragen.' }),
            });
            return;
          }
        } else if (defaults.base_url && (data.config.base_url !== defaults.base_url || data.config.login_url !== defaults.login_url)) {
          partial = { base_url: defaults.base_url, login_url: defaults.login_url };
        }
        if (partial && !(await saveConfig(partial, errors))) return;
      } else if (key === 'credentials') {
        const c = blocks.creds;
        if (c.hasInput()) {
          if (!(await c.save())) return;
        } else if (!data.credentials.configured) {
          await c.save(); // zeigt die Feldfehler
          return;
        }
      } else if (key === 'folder') {
        const { cards, custom, local, errors, suggestions } = blocks.folder;
        const choice = cards.value;
        const dir = choice === CUSTOM ? custom.input.value.trim() : suggestions.find((s) => s.id === choice)?.path;
        if (!dir) {
          showFieldErrors(errors, { download_dir: 'Bitte einen Ordner wählen oder eintragen.' });
          return;
        }
        const extra = local.input.value.trim() || null;
        if (!(await saveConfig({ download_dir: dir, local_download_dir: extra }, errors))) {
          if (errors.get('local_download_dir')?.el.hidden === false) blocks.folder.copy.open = true;
          return;
        }
      } else if (key === 'automation') {
        if (!(await blocks.schedule.save())) return;
        data.schedule = { ...data.schedule, ...blocks.schedule.value() };
        const { notify, fallback } = blocks.automation;
        if (!(await saveConfig({ notifications: notify.checked, open_login_window_on_failure: fallback.checked }, new Map()))) return;
      } else if (key === 'test') {
        await finish(true);
        return;
      }
      go(step + 1);
    } finally {
      busy = false;
      nextBtn.disabled = false;
    }
  }

  async function finish(done) {
    try {
      await api.completeSetup();
      await ctx.refreshStatus().catch(() => {});
    } catch (err) {
      ctx.toast(errorMessage(err), { tone: 'danger' });
      return;
    }
    if (!done) ctx.toast('Du kannst die Einrichtung jederzeit unter Einstellungen → Erweitert fortsetzen.', { tone: 'neutral', timeout: 6000 });
    else ctx.toast('Fertig eingerichtet. Viel Erfolg im Semester!', { tone: 'success' });
    ctx.navigate('uebersicht');
  }

  return {
    unmount: () => {
      stepCleanups.forEach((fn) => fn());
    },
  };
}
