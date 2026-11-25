// Dialog „Erweiterter Sync“: alle Optionen von `ilias-sync run` für einen einzelnen Lauf.
import { h, button, iconButton } from '../util.js';
import { icon } from '../icons.js';
import { settingRow, switchInput, nextId, showFieldErrors, clearFieldErrors } from '../components.js';
import { errorMessage } from '../api.js';

const OTHER = '__other__';

// Schalter in der Reihenfolge der Oberfläche; `flag` ist die CLI-Option.
const SWITCHES = [
  { key: 'dry_run', flag: '--dry-run', group: 'run', label: 'Probelauf', desc: 'Zeigt nur, was geladen würde – es werden keine Dateien gespeichert.' },
  { key: 'overwrite', flag: '--overwrite', group: 'run', label: 'Vorhandene Dateien überschreiben', desc: 'Lädt auch Dateien erneut, die schon im Ordner liegen.' },
  {
    key: 'no_auto_discover',
    flag: '--no-auto-discover',
    group: 'scope',
    label: 'Nur eingetragene Kurse',
    desc: 'Ohne automatische Kurserkennung – nutzt nur die manuellen Kurse aus den Einstellungen.',
  },
  { key: 'no_auto_login', flag: '--no-auto-login', group: 'run', label: 'Ohne automatische Anmeldung', desc: 'Bricht ab, statt sich mit den gespeicherten Zugangsdaten neu anzumelden.' },
  { key: 'notify', flag: '--notify', group: 'run', label: 'Mitteilung senden', desc: 'Meldet das Ergebnis nach dem Lauf als Systemmitteilung.' },
  { key: 'headful', flag: '--headful', group: 'debug', label: 'Browser sichtbar anzeigen', desc: 'Öffnet das Chromium-Fenster, statt unsichtbar im Hintergrund zu arbeiten.' },
  { key: 'verbose', flag: '--verbose', group: 'debug', label: 'Ausführliches Protokoll', desc: 'Schreibt zusätzliche Details (DEBUG) ins Protokoll.' },
  { key: 'debug_links', flag: '--debug-links', group: 'debug', label: 'Link-Diagnose', desc: 'Protokolliert alle gefundenen Links – hilfreich, wenn Dateien fehlen.' },
];

// Bleibt bis zum Neuladen der Seite erhalten (bewusst nicht in localStorage).
let remembered = null;

function shellQuote(value) {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Kurse aus den letzten Läufen (voller Name als Wert, Kurzname als Beschriftung). */
function knownCourses(store) {
  const seen = new Map();
  const runs = [store.status?.last_run, ...(store.runs ?? [])].filter(Boolean);
  for (const run of runs) {
    for (const c of run.courses ?? []) if (c?.name && !seen.has(c.name)) seen.set(c.name, c.short_name || c.name);
    if (seen.size && run.courses?.length) break; // Stand des letzten Laufs mit Kursen
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'de'));
}

/**
 * Öffnet den Dialog. Gibt ein Promise zurück, das nach dem Schließen erfüllt wird.
 * @param {object} ctx
 * @param {{opener?: HTMLElement}} [opts]
 */
export function openSyncOptions(ctx, { opener } = {}) {
  const { store, actions, api } = ctx;
  const errors = new Map();
  const values = { ...(remembered ?? {}) };
  const ids = { course: nextId('opt-course'), other: nextId('opt-other'), semester: nextId('opt-sem'), depth: nextId('opt-depth') };
  const titleId = nextId('opt-title');

  // ---- Umfang
  const courses = knownCourses(store);
  const courseSelect = h(
    'select',
    { id: ids.course, class: 'input select' },
    h('option', { value: '' }, 'Alle Kurse'),
    courses.length ? h('optgroup', { label: 'Aus dem letzten Lauf' }, courses.map(([name, label]) => h('option', { value: name, title: name }, label))) : null,
    h('option', { value: OTHER }, 'Anderer Kurs …'),
  );
  const otherInput = h('input', {
    id: ids.other,
    class: 'input',
    type: 'text',
    placeholder: 'Voller Kursname, z. B. [WS26/27] Softwaretechnik',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const otherRow = settingRow({
    label: 'Kursname',
    description: 'Genau so, wie er im Verlauf oder in ILIAS heißt.',
    control: otherInput,
    forId: ids.other,
    stacked: true,
    errorKey: 'course',
    errors,
  });
  if (values.course && courses.some(([n]) => n === values.course)) courseSelect.value = values.course;
  else if (values.course) {
    courseSelect.value = OTHER;
    otherInput.value = values.course;
  }

  const semester = h('input', { id: ids.semester, class: 'input input-short', type: 'text', value: values.semester ?? '', placeholder: 'auto', spellcheck: 'false', autocomplete: 'off' });
  const depth = h('input', { id: ids.depth, class: 'input input-number', type: 'number', min: '1', max: '100', step: '1', value: values.max_depth ?? '', placeholder: '10' });
  const switches = Object.fromEntries(SWITCHES.map((s) => [s.key, switchInput({ id: nextId(`opt-${s.key}`), checked: Boolean(values[s.key]) })]));
  const switchRow = (s) => settingRow({ label: s.label, description: s.desc, control: switches[s.key], forId: switches[s.key].id, errorKey: s.key, errors });
  const manualHint = h('p', { class: 'hint hint-warning', hidden: true }, icon('warning', { size: 13 }), ' In den Einstellungen sind keine manuellen Kurse eingetragen – dieser Lauf fände keine Kurse.');

  // Einstellungen als Platzhalter („leer = wie eingestellt“).
  let config = null;
  api
    .getConfig()
    .then((c) => {
      config = c;
      semester.placeholder = c.semester_filter || 'auto';
      depth.placeholder = String(c.max_depth ?? 10);
      update();
    })
    .catch(() => {});

  // ---- Vorschau des Terminal-Befehls
  const preview = h('code', { class: 'cli-preview-code' });
  const copyBtn = iconButton('copy', 'Befehl kopieren', {
    class: 'cli-copy',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(preview.textContent);
        ctx.toast('Befehl kopiert.', { tone: 'success', timeout: 2000 });
      } catch {
        ctx.toast('Kopieren ist hier nicht möglich.', { tone: 'neutral' });
      }
    },
  });

  function collect() {
    const course = courseSelect.value === OTHER ? otherInput.value.trim() : courseSelect.value;
    const depthValue = depth.value.trim();
    const out = {
      course: course || null,
      semester: semester.value.trim() || null,
      max_depth: depthValue === '' ? null : Number(depthValue),
    };
    for (const s of SWITCHES) out[s.key] = switches[s.key].checked;
    return out;
  }

  function command(opts) {
    const parts = ['ilias-sync', 'run'];
    for (const s of SWITCHES) if (opts[s.key]) parts.push(s.flag);
    if (opts.course) parts.push('--course', shellQuote(opts.course));
    if (opts.semester) parts.push('--semester', shellQuote(opts.semester));
    if (opts.max_depth !== null && opts.max_depth !== undefined && !Number.isNaN(opts.max_depth)) parts.push('--max-depth', String(opts.max_depth));
    return parts.join(' ');
  }

  const startBtn = button('Sync starten', { icon: 'sync', variant: 'primary', type: 'submit' });
  const resetBtn = button('Zurücksetzen', {
    variant: 'ghost',
    size: 'sm',
    onclick: () => {
      courseSelect.value = '';
      otherInput.value = '';
      semester.value = '';
      depth.value = '';
      for (const s of SWITCHES) switches[s.key].checked = false;
      clearFieldErrors(errors);
      update();
      courseSelect.focus();
    },
  });

  function update() {
    const opts = collect();
    otherRow.hidden = courseSelect.value !== OTHER;
    preview.textContent = command(opts);
    manualHint.hidden = !(opts.no_auto_discover && config && !Object.keys(config.courses ?? {}).length);
    startBtn.querySelector('.btn-label').textContent = opts.dry_run ? 'Probelauf starten' : 'Sync starten';
  }

  const closeBtn = iconButton('close', 'Schließen', { class: 'modal-close', onclick: () => dialog.close() });
  const form = h(
    'form',
    { class: 'modal-card', method: 'dialog', novalidate: true },
    h(
      'header',
      { class: 'modal-head' },
      h('span', { class: 'section-icon' }, icon('sliders', { size: 16 })),
      h('div', {}, h('h2', { id: titleId }, 'Erweiterter Sync'), h('p', { class: 'muted small' }, 'Gilt nur für diesen Lauf – deine Einstellungen bleiben unverändert.')),
      closeBtn,
    ),
    h(
      'div',
      { class: 'modal-body' },
      h('h3', { class: 'subhead' }, 'Umfang'),
      settingRow({ label: 'Kurs', description: 'Nur einen Kurs synchronisieren.', control: courseSelect, forId: ids.course }),
      otherRow,
      settingRow({ label: 'Semester', description: 'Leer lassen für die Einstellung. Sonst z. B. „WS26/27“.', control: semester, forId: ids.semester, errorKey: 'semester', errors }),
      settingRow({ label: 'Ordnertiefe', description: 'Leer lassen für die Einstellung.', control: depth, forId: ids.depth, errorKey: 'max_depth', errors }),
      SWITCHES.filter((s) => s.group === 'scope').map(switchRow),
      manualHint,
      h('h3', { class: 'subhead' }, 'Ablauf'),
      SWITCHES.filter((s) => s.group === 'run').map(switchRow),
      h('details', { class: 'modal-details' }, h('summary', {}, 'Fehlersuche'), SWITCHES.filter((s) => s.group === 'debug').map(switchRow)),
      h('div', { class: 'cli-preview' }, h('span', { class: 'cli-preview-label' }, icon('terminal', { size: 13 }), 'Entspricht im Terminal'), h('div', { class: 'cli-preview-box' }, preview, copyBtn)),
    ),
    h('footer', { class: 'modal-foot' }, resetBtn, h('span', { class: 'spacer' }), button('Abbrechen', { variant: 'secondary', onclick: () => dialog.close() }), startBtn),
  );
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': titleId }, form);

  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearFieldErrors(errors);
    const opts = collect();
    if (courseSelect.value === OTHER && !opts.course) {
      showFieldErrors(errors, { course: 'Bitte einen Kursnamen eingeben.' });
      return;
    }
    startBtn.disabled = true;
    const { dry_run: dryRun, ...rest } = opts;
    const err = await actions.startSync({ dryRun, ...rest });
    startBtn.disabled = false;
    if (err?.fields) {
      showFieldErrors(errors, err.fields);
      ctx.toast(errorMessage(err), { tone: 'danger' });
      return;
    }
    if (!err) {
      remembered = opts;
      dialog.close();
    }
  });
  // Klick auf den abgedunkelten Hintergrund schließt.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      opener?.focus?.();
      resolve();
    });
    document.body.append(dialog);
    update();
    dialog.showModal();
    courseSelect.focus();
  });
}
