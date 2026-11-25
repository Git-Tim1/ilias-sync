// Einstellungen: Konfiguration, Zugangsdaten, Zeitplan, Ordner.
import { h, button, iconButton, prefs } from '../util.js';
import { icon } from '../icons.js';
import { settingRow, switchInput, nextId, chipsInput, showFieldErrors, clearFieldErrors } from '../components.js';
import { errorMessage } from '../api.js';
import { folderInput, credentialsBlock, sessionBlock, scheduleBlock } from './forms.js';

const EXTENSION_SUGGESTIONS = ['pdf', 'pptx', 'docx', 'xlsx', 'zip', 'txt', 'py', 'ipynb', 'java', 'png', 'jpg', 'mp4'];
const CONFIG_KEYS = [
  'download_dir',
  'local_download_dir',
  'auto_discover_current_semester',
  'semester_filter',
  'include_configured_courses',
  'courses',
  'file_extensions',
  'max_depth',
  'overwrite',
  'auto_login',
  'keychain_service',
  'open_login_window_on_failure',
  'notifications',
  'base_url',
  'login_url',
];

function section(title, iconName, ...children) {
  const id = nextId('sec');
  return h(
    'section',
    { class: 'card settings-card', 'aria-labelledby': id },
    h('div', { class: 'card-head' }, h('h2', { id }, h('span', { class: 'section-icon' }, icon(iconName, { size: 16 })), title)),
    ...children,
  );
}

/** Editierbare Liste manueller Kurse (Name → URL). */
function coursesEditor(initial, onchange) {
  const list = h('ul', { class: 'course-editor' });
  const empty = h('p', { class: 'muted small empty-inline' }, 'Keine manuellen Kurse eingetragen.');

  function addRow(name = '', url = '', focus = false) {
    const nameInput = h('input', { class: 'input', type: 'text', value: name, placeholder: 'Name, z. B. Brückenkurs', 'aria-label': 'Kursname', spellcheck: 'false' });
    const urlInput = h('input', {
      class: 'input mono',
      type: 'url',
      value: url,
      placeholder: 'https://www.ilias.uni-koeln.de/ilias/goto.php/crs/…',
      'aria-label': 'Kurs-URL',
      spellcheck: 'false',
    });
    const li = h(
      'li',
      { class: 'course-editor-row' },
      nameInput,
      urlInput,
      iconButton('trash', 'Kurs entfernen', {
        class: 'danger-hover',
        onclick: () => {
          const next = li.nextElementSibling ?? li.previousElementSibling;
          li.remove();
          updateEmpty();
          onchange();
          (next?.querySelector('input') ?? addBtn).focus();
        },
      }),
    );
    for (const i of [nameInput, urlInput]) i.addEventListener('input', onchange);
    list.appendChild(li);
    updateEmpty();
    if (focus) nameInput.focus();
  }

  function updateEmpty() {
    empty.hidden = list.childElementCount > 0;
  }

  const addBtn = button('Kurs hinzufügen', {
    icon: 'plus',
    variant: 'secondary',
    size: 'sm',
    onclick: () => {
      addRow('', '', true);
      onchange();
    },
  });

  function setValue(obj) {
    list.replaceChildren();
    for (const [n, u] of Object.entries(obj ?? {})) addRow(n, u);
    updateEmpty();
  }
  setValue(initial);

  return {
    el: h('div', { class: 'course-editor-wrap' }, list, empty, addBtn),
    get value() {
      const out = {};
      for (const row of list.children) {
        const [n, u] = row.querySelectorAll('input');
        const name = n.value.trim();
        const url = u.value.trim();
        if (name || url) out[name] = url;
      }
      return out;
    },
    set value(v) {
      setValue(v);
    },
  };
}

export function mount(root, ctx) {
  const { api } = ctx;
  const cleanups = [];
  const header = h('header', { class: 'page-header' }, h('h1', {}, 'Einstellungen'));
  const body = h('div', { class: 'settings', 'aria-busy': 'true' }, h('p', { class: 'muted' }, 'Lade Einstellungen …'));
  root.append(header, body);

  Promise.all([api.getConfig(), api.getCredentials(), api.getSchedule()])
    .then(([config, credentials, schedule]) => build(config, credentials, schedule))
    .catch((err) => {
      body.replaceChildren(h('p', { class: 'empty' }, `Einstellungen konnten nicht geladen werden: ${errorMessage(err)}`));
    });

  function build(config, credentials, schedule) {
    let saved = structuredClone(config);
    const errors = new Map();
    const fields = {};
    const ids = Object.fromEntries(CONFIG_KEYS.map((k) => [k, nextId(k)]));

    // ---- Ordner
    const dl = folderInput({ id: ids.download_dir, value: config.download_dir, placeholder: '~/Documents/Uni/ILIAS', which: 'download', ctx });
    const local = folderInput({
      id: ids.local_download_dir,
      value: config.local_download_dir ?? '',
      placeholder: 'optional, z. B. ~/Library/Mobile Documents/com~apple~CloudDocs/Uni',
      which: 'local',
      ctx,
      optional: true,
    });
    fields.download_dir = { get: () => dl.input.value.trim(), set: (v) => (dl.input.value = v ?? '') };
    fields.local_download_dir = { get: () => local.input.value.trim() || null, set: (v) => (local.input.value = v ?? '') };

    // ---- Kurse & Semester
    const autoDiscover = switchInput({ id: ids.auto_discover_current_semester, checked: config.auto_discover_current_semester });
    const semester = h('input', {
      id: ids.semester_filter,
      class: 'input input-short',
      type: 'text',
      value: config.semester_filter ?? 'auto',
      placeholder: 'auto',
      spellcheck: 'false',
    });
    const includeConfigured = switchInput({ id: ids.include_configured_courses, checked: config.include_configured_courses });
    const courses = coursesEditor(config.courses, markDirty);
    fields.auto_discover_current_semester = { get: () => autoDiscover.checked, set: (v) => (autoDiscover.checked = Boolean(v)) };
    fields.semester_filter = { get: () => semester.value.trim() || 'auto', set: (v) => (semester.value = v ?? 'auto') };
    fields.include_configured_courses = { get: () => includeConfigured.checked, set: (v) => (includeConfigured.checked = Boolean(v)) };
    fields.courses = {
      get: () => courses.value,
      set: (v) => {
        courses.value = v;
      },
    };

    // ---- Downloads
    const exts = chipsInput({ id: ids.file_extensions, values: config.file_extensions ?? [], suggestions: EXTENSION_SUGGESTIONS, onchange: markDirty });
    const maxDepth = h('input', { id: ids.max_depth, class: 'input input-number', type: 'number', min: '1', step: '1', value: String(config.max_depth ?? 10) });
    const overwrite = switchInput({ id: ids.overwrite, checked: config.overwrite });
    fields.file_extensions = { get: () => exts.value, set: (v) => (exts.value = v ?? []) };
    fields.max_depth = {
      get: () => {
        const n = Number(maxDepth.value);
        return Number.isFinite(n) && maxDepth.value !== '' ? n : maxDepth.value;
      },
      set: (v) => (maxDepth.value = String(v ?? '')),
    };
    fields.overwrite = { get: () => overwrite.checked, set: (v) => (overwrite.checked = Boolean(v)) };

    // ---- Anmeldung
    const autoLogin = switchInput({ id: ids.auto_login, checked: config.auto_login });
    fields.auto_login = { get: () => autoLogin.checked, set: (v) => (autoLogin.checked = Boolean(v)) };
    const fallback = switchInput({ id: ids.open_login_window_on_failure, checked: config.open_login_window_on_failure });
    const notifications = switchInput({ id: ids.notifications, checked: config.notifications });
    const keychain = h('input', { id: ids.keychain_service, class: 'input mono', type: 'text', value: config.keychain_service, spellcheck: 'false' });
    fields.open_login_window_on_failure = { get: () => fallback.checked, set: (v) => (fallback.checked = Boolean(v)) };
    fields.notifications = { get: () => notifications.checked, set: (v) => (notifications.checked = Boolean(v)) };
    fields.keychain_service = { get: () => keychain.value.trim(), set: (v) => (keychain.value = v ?? '') };
    const creds = credentialsBlock(ctx, { credentials });
    const session = sessionBlock(ctx);
    cleanups.push(session.destroy);

    // ---- Erweitert
    const baseUrl = h('input', { id: ids.base_url, class: 'input mono', type: 'url', value: config.base_url ?? '', spellcheck: 'false' });
    const loginUrl = h('input', { id: ids.login_url, class: 'input mono', type: 'url', value: config.login_url ?? '', spellcheck: 'false' });
    fields.base_url = { get: () => baseUrl.value.trim(), set: (v) => (baseUrl.value = v ?? '') };
    fields.login_url = { get: () => loginUrl.value.trim(), set: (v) => (loginUrl.value = v ?? '') };

    // ---- Speicherleiste
    const saveState = h('span', { class: 'savebar-text', 'aria-live': 'polite' });
    const discardBtn = button('Verwerfen', { variant: 'secondary', size: 'sm', onclick: () => discard() });
    const saveBtn = button('Speichern', { variant: 'primary', size: 'sm', onclick: () => save() });
    const savebar = h('div', { class: 'savebar' }, saveState, h('span', { class: 'spacer' }), discardBtn, saveBtn);

    function currentValues() {
      return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.get()]));
    }
    function changes() {
      const now = currentValues();
      const partial = {};
      for (const [k, v] of Object.entries(now)) {
        const before = k === 'semester_filter' ? saved[k] || 'auto' : saved[k] ?? null;
        if (JSON.stringify(v ?? null) !== JSON.stringify(before)) partial[k] = v;
      }
      return partial;
    }
    function markDirty() {
      const n = Object.keys(changes()).length;
      savebar.dataset.dirty = String(n > 0);
      saveState.textContent = n ? (n === 1 ? '1 ungespeicherte Änderung' : `${n} ungespeicherte Änderungen`) : 'Alle Änderungen gespeichert';
      saveBtn.disabled = !n;
      discardBtn.disabled = !n;
    }
    function discard() {
      for (const [k, f] of Object.entries(fields)) f.set(structuredClone(saved[k]));
      clearFieldErrors(errors);
      markDirty();
    }
    async function save() {
      const partial = changes();
      if (!Object.keys(partial).length) return;
      clearFieldErrors(errors);
      saveBtn.disabled = true;
      saveState.textContent = 'Speichere …';
      try {
        const res = await api.putConfig(partial);
        saved = res && typeof res === 'object' && 'download_dir' in res ? res : { ...saved, ...partial };
        for (const k of Object.keys(partial)) fields[k].set(structuredClone(saved[k]));
        if ('keychain_service' in partial) creds.refresh().catch(() => {});
        ctx.toast('Einstellungen gespeichert.', { tone: 'success' });
      } catch (err) {
        if (err.status === 422 && err.fields) {
          if (err.fields.keychain_service) credentialAdvanced.open = true;
          showFieldErrors(errors, err.fields);
          ctx.toast(err.message || 'Bitte die markierten Felder prüfen.', { tone: 'danger' });
        } else {
          ctx.toast(errorMessage(err), { tone: 'danger' });
        }
      } finally {
        markDirty();
      }
    }

    const row = (key, label, control, opts = {}) => settingRow({ label, control, forId: ids[key], errorKey: key, errors, ...opts });

    const credentialAdvanced = h(
      'details',
      {},
      h('summary', {}, 'Erweitert'),
      row('keychain_service', 'Schlüsselbund-Dienst', keychain, { stacked: true, description: 'Wählt den Eintrag im System-Schlüsselbund. Änderungen gelten nach dem Speichern der Einstellungen.' }),
    );

    const advanced = h(
      'details',
      { class: 'card settings-card advanced' },
      h('summary', { class: 'card-head' }, h('h2', {}, h('span', { class: 'section-icon' }, icon('settings', { size: 16 })), 'Erweitert'), icon('chevronDown', { size: 16, className: 'chev' })),
      row('base_url', 'ILIAS-Adresse', baseUrl, { stacked: true, description: 'Nur ändern, wenn du ILIAS Sync mit einer anderen Hochschule nutzt.' }),
      row('login_url', 'Login-Adresse', loginUrl, { stacked: true }),
      h(
        'div',
        { class: 'setting-row' },
        h('div', { class: 'setting-text' }, h('span', { class: 'setting-label' }, 'Einrichtungsassistent'), h('p', { class: 'setting-desc' }, 'Zugangsdaten, Ordner und Zeitplan Schritt für Schritt einrichten.')),
        h(
          'div',
          { class: 'setting-control' },
          button('Erneut starten', {
            variant: 'secondary',
            size: 'sm',
            onclick: () => {
              prefs.set('setupDone', false);
              ctx.navigate('einrichtung');
            },
          }),
        ),
      ),
      h('p', { class: 'muted small version' }, `ILIAS Sync ${ctx.store.status?.version ?? ''}${ctx.api.mock ? ' · Demo-Modus' : ''}`),
    );

    body.removeAttribute('aria-busy');
    body.replaceChildren(
      section(
        'Ordner',
        'folder',
        row('download_dir', 'Download-Ordner', dl.el, { stacked: true, description: 'Hier legt ILIAS Sync die Kursmaterialien ab – pro Kurs ein Unterordner.' }),
        row('local_download_dir', 'Zusätzliche lokale Kopie', local.el, {
          stacked: true,
          description: 'Optional. Neue Dateien werden zusätzlich hierhin kopiert, z. B. in einen iCloud- oder Nextcloud-Ordner.',
        }),
      ),
      section(
        'Kurse & Semester',
        'layers',
        row('auto_discover_current_semester', 'Kurse automatisch erkennen', autoDiscover, { description: 'Findet alle Kurse, in denen du im aktuellen Semester Mitglied bist.' }),
        row('semester_filter', 'Semester', semester, { description: '„auto“ wählt das laufende Semester. Oder fest, z. B. „WS26/27“ oder „SoSe27“.' }),
        row('include_configured_courses', 'Manuelle Kurse zusätzlich laden', includeConfigured, { description: 'Lädt die unten eingetragenen Kurse auch bei automatischer Erkennung.' }),
        settingRow({ label: 'Manuelle Kurse', description: 'Kurse, die nicht automatisch gefunden werden – mit Link aus ILIAS („Permanenter Link“).', control: courses.el, stacked: true, errorKey: 'courses', errors }),
      ),
      section(
        'Downloads',
        'download',
        row('file_extensions', 'Dateitypen', exts.el, { stacked: true, description: 'Nur Dateien mit diesen Endungen werden geladen.' }),
        row('max_depth', 'Maximale Ordnertiefe', maxDepth, { description: 'Wie tief Unterordner in ILIAS durchsucht werden (mindestens 1).' }),
        row('overwrite', 'Geänderte Dateien überschreiben', overwrite, { description: 'Aus: Vorhandene Dateien bleiben unverändert.' }),
      ),
      section(
        'Anmeldung',
        'key',
        row('auto_login', 'Automatisch neu anmelden', autoLogin, { description: 'Meldet sich mit den gespeicherten Zugangsdaten an, wenn die Sitzung abläuft.' }),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Zugangsdaten'), creds.el, credentialAdvanced),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'ILIAS-Sitzung'), session.el),
      ),
      section(
        'Zeitplan',
        'calendar',
        scheduleBlock(ctx, schedule).el,
        row('notifications', 'macOS-Mitteilungen', notifications, { description: 'Meldet neue Dateien oder eine erforderliche Anmeldung nach einem geplanten Lauf.' }),
        row('open_login_window_on_failure', 'Login-Fenster bei abgelaufener Sitzung öffnen', fallback, { description: 'Öffnet bei einem geplanten Lauf in deiner grafischen macOS-Sitzung das ILIAS-Login und versucht den Sync nach der Anmeldung erneut.' }),
      ),
      advanced,
      savebar,
    );

    for (const el of [dl.input, local.input, semester, maxDepth, baseUrl, loginUrl, keychain]) el.addEventListener('input', markDirty);
    for (const el of [autoDiscover, includeConfigured, overwrite, autoLogin, fallback, notifications]) el.addEventListener('change', markDirty);
    markDirty();

    const onKey = (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', onKey);
    cleanups.push(() => document.removeEventListener('keydown', onKey));

    const beforeUnload = (ev) => {
      if (Object.keys(changes()).length) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    cleanups.push(() => window.removeEventListener('beforeunload', beforeUnload));
  }

  return { unmount: () => cleanups.forEach((fn) => fn()) };
}
