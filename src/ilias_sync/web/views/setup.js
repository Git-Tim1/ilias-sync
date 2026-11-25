// Ersteinrichtung: Zugangsdaten → Ordner → Zeitplan → erster Probelauf.
import { h, button, prefs, plural, fmtNumber } from '../util.js';
import { icon } from '../icons.js';
import { LogView, settingRow, showFieldErrors, clearFieldErrors, nextId } from '../components.js';
import { errorMessage } from '../api.js';
import { folderInput, credentialsBlock, scheduleBlock } from './forms.js';

const STEPS = [
  { key: 'credentials', title: 'Zugangsdaten' },
  { key: 'folders', title: 'Ordner' },
  { key: 'schedule', title: 'Zeitplan' },
  { key: 'dryrun', title: 'Probelauf' },
];

export function mount(root, ctx) {
  const { api, store } = ctx;
  const cleanups = [];
  let step = 0;
  let data = null;
  let blocks = {};
  let dryRunReport = null;
  let stepCleanups = [];

  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Schritte der Einrichtung' });
  const stepBody = h('div', { class: 'wizard-body' });
  const backBtn = button('Zurück', { variant: 'secondary', onclick: () => go(step - 1) });
  const skipBtn = button('Später einrichten', { variant: 'ghost', onclick: () => finish(false) });
  const nextBtn = button('Weiter', { variant: 'primary', onclick: () => next() });
  const heading = h('h1', { class: 'wizard-title', tabindex: '-1' }, 'Willkommen bei ILIAS Sync');

  const card = h(
    'div',
    { class: 'wizard card' },
    h(
      'div',
      { class: 'wizard-head' },
      h('div', { class: 'wizard-logo' }, icon('logo', { size: 30 })),
      heading,
      h('p', { class: 'wizard-lead' }, 'In vier kurzen Schritten lädt ILIAS Sync deine Kursmaterialien automatisch in einen Ordner auf diesem Computer.'),
      stepper,
    ),
    stepBody,
    h('div', { class: 'wizard-foot' }, backBtn, skipBtn, h('span', { class: 'spacer' }), nextBtn),
  );
  root.append(h('div', { class: 'wizard-page' }, card));

  Promise.all([api.getConfig(), api.getCredentials(), api.getSchedule()])
    .then(([config, credentials, schedule]) => {
      data = { config, credentials, schedule };
      // Bereits erledigte Schritte überspringen.
      go(0);
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
          h('span', { class: 'step-num' }, i < step ? icon('check', { size: 13 }) : String(i + 1)),
          h('span', { class: 'step-title' }, s.title),
        ),
      ),
    );
  }

  function go(index) {
    stepCleanups.forEach((fn) => fn());
    stepCleanups = [];
    step = Math.max(0, Math.min(STEPS.length - 1, index));
    renderStepper();
    backBtn.hidden = step === 0;
    nextBtn.disabled = false;
    const key = STEPS[step].key;
    nextBtn.querySelector('.btn-label').textContent = key === 'dryrun' ? 'Fertig' : 'Weiter';
    stepBody.replaceChildren(renderStep(key));
    const first = stepBody.querySelector('input:not([type=hidden]), button.btn-primary');
    (first ?? heading).focus({ preventScroll: true });
  }

  function renderStep(key) {
    if (key === 'credentials') {
      blocks.creds = credentialsBlock(ctx, { credentials: data.credentials, embedded: true, onChange: (c) => (data.credentials = c) });
      return h(
        'section',
        { class: 'wizard-step', 'aria-labelledby': 'wz-cred' },
        h('h2', { id: 'wz-cred' }, 'Mit ILIAS verbinden'),
        h(
          'p',
          { class: 'muted' },
          'Gib deine Uni-Kennung und dein Passwort ein. Damit kann sich ILIAS Sync selbst neu anmelden, wenn die Sitzung abläuft.',
          data.credentials.configured ? ' Es sind bereits Zugangsdaten gespeichert – du kannst sie hier ersetzen oder einfach weitergehen.' : '',
        ),
        blocks.creds.el,
      );
    }
    if (key === 'folders') {
      const errors = new Map();
      const dlId = nextId('wz-dl');
      const localId = nextId('wz-local');
      const dl = folderInput({ id: dlId, value: data.config.download_dir, placeholder: '~/Documents/Uni/ILIAS' });
      const local = folderInput({ id: localId, value: data.config.local_download_dir ?? '', placeholder: 'optional' });
      blocks.folders = { dl, local, errors };
      return h(
        'section',
        { class: 'wizard-step', 'aria-labelledby': 'wz-folders' },
        h('h2', { id: 'wz-folders' }, 'Wohin sollen die Dateien?'),
        h('p', { class: 'muted' }, 'Pro Kurs entsteht ein Unterordner. Bereits vorhandene Dateien werden nicht doppelt geladen.'),
        settingRow({ label: 'Download-Ordner', control: dl.el, forId: dlId, stacked: true, errorKey: 'download_dir', errors }),
        settingRow({
          label: 'Zusätzliche lokale Kopie',
          description: 'Optional, z. B. ein iCloud- oder Nextcloud-Ordner.',
          control: local.el,
          forId: localId,
          stacked: true,
          errorKey: 'local_download_dir',
          errors,
        }),
      );
    }
    if (key === 'schedule') {
      blocks.schedule = scheduleBlock(ctx, data.schedule.supported === false ? data.schedule : { ...data.schedule, enabled: data.schedule.enabled || !store.status?.last_run }, { withSave: false });
      return h(
        'section',
        { class: 'wizard-step', 'aria-labelledby': 'wz-sched' },
        h('h2', { id: 'wz-sched' }, 'Wann soll synchronisiert werden?'),
        h('p', { class: 'muted' }, 'Am bequemsten ist ein täglicher Lauf. Du kannst jederzeit auch manuell synchronisieren.'),
        blocks.schedule.el,
      );
    }
    return renderDryRun();
  }

  function renderDryRun() {
    const log = new LogView({ label: 'Protokoll des Probelaufs', height: '220px' });
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
    blocks.dry = { log };

    const offLog = store.on('log', (line) => log.add([line]));
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
      result.replaceChildren(h('p', { class: 'muted' }, icon('sync', { size: 14, className: 'spin' }), ' Probelauf läuft – es werden keine Dateien gespeichert …'));
      await ctx.actions.startSync(true);
      if (!store.status?.running) {
        // Start fehlgeschlagen (Toast zeigt den Grund)
        setTimeout(() => {
          if (!store.status?.running && !dryRunReport) {
            startBtn.disabled = false;
            result.replaceChildren();
          }
        }, 1500);
      }
    }

    function showResult(report) {
      const t = report.totals ?? {};
      const ok = report.result === 'success' || report.result === 'errors';
      startBtn.disabled = false;
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
                ? `${plural(report.courses?.length ?? 0, 'Kurs', 'Kurse')} gefunden, ${fmtNumber(t.found ?? 0)} Dateien erkannt, davon ${fmtNumber(t.skipped ?? 0)} bereits vorhanden.`
                : report.message || 'Bitte Zugangsdaten und Verbindung prüfen.',
            ),
          ),
        ),
      );
    }

    const el = h(
      'section',
      { class: 'wizard-step', 'aria-labelledby': 'wz-dry' },
      h('h2', { id: 'wz-dry' }, 'Alles testen'),
      h('p', { class: 'muted' }, 'Der Probelauf meldet sich an, sucht deine Kurse und zeigt, was geladen würde – ohne etwas zu speichern.'),
      h('div', { class: 'row-actions' }, startBtn, realBtn),
      result,
      log.el,
    );
    if (dryRunReport) showResult(dryRunReport);
    return el;
  }

  async function next() {
    const key = STEPS[step].key;
    nextBtn.disabled = true;
    try {
      if (key === 'credentials') {
        const c = blocks.creds;
        if (c.hasInput()) {
          if (!(await c.save())) return;
        } else if (!data.credentials.configured) {
          await c.save(); // zeigt Feldfehler
          return;
        }
      } else if (key === 'folders') {
        const { dl, local, errors } = blocks.folders;
        clearFieldErrors(errors);
        const partial = { download_dir: dl.input.value.trim(), local_download_dir: local.input.value.trim() || null };
        try {
          data.config = (await api.putConfig(partial)) ?? { ...data.config, ...partial };
        } catch (err) {
          if (err.fields) showFieldErrors(errors, err.fields);
          else ctx.toast(errorMessage(err), { tone: 'danger' });
          return;
        }
      } else if (key === 'schedule') {
        if (!(await blocks.schedule.save())) return;
        data.schedule = { ...data.schedule, ...blocks.schedule.value() };
      } else if (key === 'dryrun') {
        await finish(true);
        return;
      }
      go(step + 1);
    } finally {
      nextBtn.disabled = false;
    }
  }

  async function finish(done) {
    prefs.set('setupDone', true);
    if (!done) ctx.toast('Du kannst die Einrichtung jederzeit unter Einstellungen → Erweitert fortsetzen.', { tone: 'neutral', timeout: 6000 });
    ctx.navigate('uebersicht');
  }

  return {
    unmount: () => {
      stepCleanups.forEach((fn) => fn());
      cleanups.forEach((fn) => fn());
    },
  };
}
