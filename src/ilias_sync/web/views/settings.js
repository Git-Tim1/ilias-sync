// Einstellungen: Konfiguration, Zugangsdaten, Zeitplan, Ordner.
import { h, button, iconButton, REVEAL_LABEL, hasNativeFilePicker, chooseFile, openInBrowser } from '../util.js';
import { icon } from '../icons.js';
import { settingRow, switchInput, nextId, chipsInput, showFieldErrors, clearFieldErrors } from '../components.js';
import { errorMessage } from '../api.js';
import { folderInput, credentialsBlock, sessionBlock, scheduleBlock, browserBlock } from './forms.js';

const EXTENSION_SUGGESTIONS = ['pdf', 'pptx', 'docx', 'xlsx', 'zip', 'txt', 'md', 'py', 'ipynb', 'java', 'tex', 'odt', 'png', 'jpg', 'mp4'];
// Diese Felder bleiben beim Zurücksetzen erhalten – sie sind persönlich, nicht „Standard“.
const PERSONAL_KEYS = new Set(['download_dir', 'local_download_dir', 'courses', 'keychain_service']);
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

const onOff = (v) => (v ? 'an' : 'aus');

/** Hängt „Standard: …“ an eine Beschreibung an. */
function withDefault(text, defaults, key, format = (v) => v) {
  if (!defaults || !(key in defaults)) return text;
  const value = defaults[key];
  const shown = typeof value === 'boolean' ? onOff(value) : format(value);
  return h('span', {}, text, ' ', h('span', { class: 'default-hint' }, `Standard: ${shown}`));
}

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

  let buildCleanups = [];
  function load() {
    return Promise.all([
      api.getConfig(),
      api.getCredentials(),
      api.getSchedule(),
      api.getConfigDefaults().catch(() => null),
      api.getPaths().catch(() => null),
    ])
      .then((data) => {
        buildCleanups.forEach((fn) => fn());
        buildCleanups = [];
        build(...data);
      })
      .catch((err) => {
        body.replaceChildren(h('p', { class: 'empty' }, `Einstellungen konnten nicht geladen werden: ${errorMessage(err)}`));
      });
  }
  load();
  cleanups.push(() => buildCleanups.forEach((fn) => fn()));

  function build(config, credentials, schedule, defaults, runtimePaths) {
    const cleanups = buildCleanups;
    let saved = structuredClone(config);
    const errors = new Map();
    const fields = {};
    const ids = Object.fromEntries(CONFIG_KEYS.map((k) => [k, nextId(k)]));

    // ---- Ordner
    const dl = folderInput({ id: ids.download_dir, value: config.download_dir, placeholder: defaults?.download_dir ?? '~/Documents/Uni', which: 'download', ctx });
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
    const maxDepth = h('input', { id: ids.max_depth, class: 'input input-number', type: 'number', min: '1', step: '1', value: String(config.max_depth ?? 10), placeholder: String(defaults?.max_depth ?? 10) });
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
    const keychain = h('input', { id: ids.keychain_service, class: 'input mono', type: 'text', value: config.keychain_service, spellcheck: 'false', placeholder: defaults?.keychain_service ?? '' });
    fields.open_login_window_on_failure = { get: () => fallback.checked, set: (v) => (fallback.checked = Boolean(v)) };
    fields.notifications = { get: () => notifications.checked, set: (v) => (notifications.checked = Boolean(v)) };
    fields.keychain_service = { get: () => keychain.value.trim(), set: (v) => (keychain.value = v ?? '') };
    const creds = credentialsBlock(ctx, { credentials });
    const session = sessionBlock(ctx);
    cleanups.push(session.destroy);

    // ---- Erweitert
    const baseUrl = h('input', { id: ids.base_url, class: 'input mono', type: 'url', value: config.base_url ?? '', spellcheck: 'false', placeholder: defaults?.base_url ?? '' });
    const loginUrl = h('input', { id: ids.login_url, class: 'input mono', type: 'url', value: config.login_url ?? '', spellcheck: 'false', placeholder: defaults?.login_url ?? '' });
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
    async function restoreDefaults() {
      let defaults;
      try {
        defaults = await api.getConfigDefaults();
      } catch (err) {
        ctx.toast(errorMessage(err), { tone: 'danger' });
        return;
      }
      for (const [k, f] of Object.entries(fields)) {
        if (!PERSONAL_KEYS.has(k) && k in defaults) f.set(structuredClone(defaults[k]));
      }
      clearFieldErrors(errors);
      markDirty();
      ctx.toast('Standardwerte eingetragen. Zum Übernehmen „Speichern“ klicken.', { tone: 'neutral' });
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
      row('keychain_service', 'Schlüsselbund-Dienst', keychain, {
        stacked: true,
        description: withDefault('Wählt den Eintrag im System-Schlüsselbund. Änderungen gelten nach dem Speichern der Einstellungen.', defaults, 'keychain_service', (v) => `„${v}“`),
      }),
    );

    const advanced = h(
      'details',
      { class: 'card settings-card advanced' },
      h('summary', { class: 'card-head' }, h('h2', {}, h('span', { class: 'section-icon' }, icon('settings', { size: 16 })), 'Erweitert'), icon('chevronDown', { size: 16, className: 'chev' })),
      row('base_url', 'ILIAS-Adresse', baseUrl, { stacked: true, description: 'Nur ändern, wenn du ILIAS Sync mit einer anderen Hochschule nutzt. Standard: Universität zu Köln.' }),
      row('login_url', 'Login-Adresse', loginUrl, { stacked: true }),
      h(
        'div',
        { class: 'setting-row' },
        h(
          'div',
          { class: 'setting-text' },
          h('span', { class: 'setting-label' }, 'Standardwerte'),
          h('p', { class: 'setting-desc' }, 'Setzt Dateitypen, Ordnertiefe, Semester, Anmeldung und ILIAS-Adresse zurück. Ordner, Kurse und Zugangsdaten bleiben erhalten.'),
        ),
        h('div', { class: 'setting-control' }, button('Zurücksetzen', { variant: 'secondary', size: 'sm', onclick: () => restoreDefaults() })),
      ),
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
            onclick: async () => {
              await ctx.api.resetSetup().catch(() => {});
              ctx.navigate('einrichtung');
            },
          }),
        ),
      ),
      ...advancedTools(),
      h('p', { class: 'muted small version' }, `ILIAS Sync ${ctx.store.status?.version ?? ''}${ctx.api.mock ? ' · Demo-Modus' : ''}`),
    );

    // ---- Erweitert: Werkzeuge, die es sonst nur im Terminal gibt
    function advancedTools() {
      const browser = browserBlock(ctx);
      cleanups.push(browser.destroy);
      return [
        shellCommandCard(),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Browser-Komponente'), h('p', { class: 'setting-desc' }, 'ILIAS Sync nutzt ein eigenes Chromium für Anmeldung und Downloads.'), browser.el),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Speicherorte'), pathsList()),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Konfigurationsdatei'), yamlViewer(), importer()),
        h(
          'div',
          { class: 'setting-row' },
          h(
            'div',
            { class: 'setting-text' },
            h('span', { class: 'setting-label' }, 'Im Browser öffnen'),
            h('p', { class: 'setting-desc' }, 'Öffnet diese Oberfläche zusätzlich in deinem Standardbrowser.'),
          ),
          h('div', { class: 'setting-control' }, button('Im Browser öffnen', { icon: 'globe', variant: 'secondary', size: 'sm', onclick: () => openInBrowser(location.href) })),
        ),
      ];
    }

    function shellCommandCard() {
      const status = h('p', { class: 'setting-desc', 'aria-live': 'polite' }, 'Lade Status …');
      const path = h('p', { class: 'setting-desc mono browser-path', hidden: true });
      const line = h('pre', { class: 'code yaml-view', tabindex: '0' });
      const copy = button('Kopieren', {
        icon: 'copy', variant: 'ghost', size: 'sm',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(line.textContent);
            ctx.toast('PATH-Zeile kopiert.', { tone: 'success' });
          } catch {
            const range = document.createRange();
            range.selectNodeContents(line);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            ctx.toast('PATH-Zeile markiert. Kopiere sie mit dem Tastenkürzel.');
          }
        },
      });
      const hint = h('div', { hidden: true },
        h('p', { class: 'setting-desc' }, 'Falls der Befehl im Terminal fehlt, ergänze diese Zeile in ~/.zprofile (zsh) und öffne ein neues Terminal.'),
        line, copy,
      );
      const examples = h('p', { class: 'setting-desc', hidden: true },
        h('code', {}, 'ilias-sync --help'), ' · ', h('code', {}, 'ilias-sync run --dry-run'),
      );
      let installed = false;
      const change = button('Installieren', {
        variant: 'secondary', size: 'sm', hidden: true,
        onclick: async () => {
          change.disabled = true;
          try {
            render(await (installed ? api.uninstallShellCommand() : api.installShellCommand()));
          } catch (err) {
            ctx.toast(errorMessage(err), { tone: 'danger' });
          } finally {
            change.disabled = false;
          }
        },
      });
      function render(info) {
        installed = info.installed;
        status.textContent = info.supported ? (installed ? 'Installiert' : 'Nicht installiert') : info.instructions;
        path.textContent = info.path ?? '';
        path.hidden = !info.path;
        change.textContent = installed ? 'Entfernen' : 'Installieren';
        change.hidden = !info.supported;
        line.textContent = info.path_line ?? '';
        hint.hidden = !installed || !info.path_line;
        examples.hidden = !info.supported;
      }
      api.getShellCommand().then(render).catch((err) => { status.textContent = errorMessage(err); });
      return h('section', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Terminal-Befehl'),
        h('div', { class: 'browser-head' }, h('div', {}, status, path), change), hint, examples,
      );
    }

    function pathsList() {
      const labels = { config: ['Konfiguration', 'config.yaml mit allen Einstellungen'], data: ['Daten', 'Verlauf, Browser-Profil und Sitzung'], logs: ['Protokolle', 'sync.log für die Fehlersuche'] };
      if (!runtimePaths) return h('p', { class: 'muted small' }, 'Speicherorte konnten nicht geladen werden.');
      return h(
        'ul',
        { class: 'path-list' },
        Object.entries(labels).map(([key, [label, desc]]) => {
          const info = runtimePaths[key];
          if (!info) return null;
          return h(
            'li',
            { class: 'path-item' },
            h(
              'div',
              { class: 'path-text' },
              h('span', { class: 'setting-label' }, label, info.exists ? null : h('span', { class: 'badge badge-soft' }, 'noch nicht angelegt')),
              h('span', { class: 'setting-desc' }, desc),
              h('code', { class: 'path-value', title: info.path }, info.path),
            ),
            button(REVEAL_LABEL, {
              icon: 'reveal',
              variant: 'secondary',
              size: 'sm',
              'aria-label': `${label}: ${REVEAL_LABEL}`,
              onclick: async () => {
                try {
                  await api.revealPath(key);
                } catch (err) {
                  ctx.toast(errorMessage(err), { tone: 'danger' });
                }
              },
            }),
          );
        }),
      );
    }

    function yamlViewer() {
      const pre = h('pre', { class: 'code yaml-view', tabindex: '0', 'aria-label': 'Konfiguration als YAML' });
      const wrap = h('div', { class: 'yaml-wrap', hidden: true }, pre);
      const copyBtn = button('Kopieren', {
        icon: 'copy',
        variant: 'ghost',
        size: 'sm',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pre.textContent);
            ctx.toast('YAML in die Zwischenablage kopiert.', { tone: 'success', timeout: 2000 });
          } catch {
            const range = document.createRange();
            range.selectNodeContents(pre);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
            ctx.toast('Text markiert – mit ⌘C kopieren.', { tone: 'neutral' });
          }
        },
      });
      copyBtn.hidden = true;
      const toggle = button('Als YAML anzeigen', {
        icon: 'file',
        variant: 'secondary',
        size: 'sm',
        'aria-expanded': 'false',
        onclick: async () => {
          const open = wrap.hidden;
          if (open) {
            try {
              const res = await api.getConfigYaml();
              pre.textContent = res.yaml;
            } catch (err) {
              ctx.toast(errorMessage(err), { tone: 'danger' });
              return;
            }
          }
          wrap.hidden = !open;
          copyBtn.hidden = !open;
          toggle.setAttribute('aria-expanded', String(open));
          toggle.querySelector('.btn-label').textContent = open ? 'YAML ausblenden' : 'Als YAML anzeigen';
        },
      });
      return h(
        'div',
        { class: 'yaml-block' },
        h(
          'div',
          { class: 'setting-row' },
          h('div', { class: 'setting-text' }, h('span', { class: 'setting-label' }, 'Gespeicherte Einstellungen ansehen'), h('p', { class: 'setting-desc' }, 'Zeigt die wirksame Konfiguration (wie „ilias-sync config show“). Enthält keine Passwörter.')),
          h('div', { class: 'setting-control setting-control-row' }, copyBtn, toggle),
        ),
        wrap,
      );
    }

    function importer() {
      const errors = new Map();
      const id = nextId('import');
      const input = h('input', { id, class: 'input input-path', type: 'text', placeholder: '/Pfad/zur/alten/config.yaml', spellcheck: 'false', autocomplete: 'off' });
      const pick = button('Datei wählen …', {
        icon: 'folder',
        variant: 'secondary',
        size: 'sm',
        onclick: async () => {
          const path = await chooseFile(input.value);
          if (path) {
            input.value = path;
            ask();
          }
        },
      });
      pick.hidden = !hasNativeFilePicker();
      const onReady = () => (pick.hidden = !hasNativeFilePicker());
      window.addEventListener('pywebviewready', onReady);
      cleanups.push(() => window.removeEventListener('pywebviewready', onReady));
      const confirmBox = h('div', { class: 'confirm', hidden: true, role: 'alertdialog', 'aria-label': 'Konfiguration importieren?' });
      const importBtn = button('Importieren …', { icon: 'upload', variant: 'secondary', size: 'sm', onclick: () => ask() });

      function ask() {
        clearFieldErrors(errors);
        if (!input.value.trim()) {
          showFieldErrors(errors, { import: 'Bitte den Pfad zur alten config.yaml angeben.' });
          return;
        }
        confirmBox.hidden = false;
        confirmBox.replaceChildren(
          h('span', {}, 'Alle Einstellungen werden durch die Werte aus der Datei ersetzt. Zugangsdaten im Schlüsselbund bleiben erhalten.'),
          button('Abbrechen', { variant: 'secondary', size: 'sm', onclick: () => ((confirmBox.hidden = true), importBtn.focus()) }),
          button('Ersetzen', { variant: 'primary', size: 'sm', onclick: () => run() }),
        );
        confirmBox.querySelector('.btn-secondary').focus();
      }

      async function run() {
        confirmBox.hidden = true;
        try {
          await api.importConfig(input.value.trim());
          ctx.toast('Alte Konfiguration übernommen.', { tone: 'success' });
          await load();
        } catch (err) {
          const fields = err.fields ? { import: Object.values(err.fields).join(' ') } : { import: errorMessage(err) };
          showFieldErrors(errors, fields);
        }
      }
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ask();
        }
      });
      return h(
        'div',
        { class: 'import-block' },
        settingRow({
          label: 'Alte config.yaml importieren',
          description: 'Übernimmt Ordner, Kurse und Dateitypen aus einer früheren Installation (wie „ilias-sync config import“).',
          control: h('div', { class: 'path-field' }, input, pick, importBtn),
          forId: id,
          stacked: true,
          errorKey: 'import',
          errors,
        }),
        confirmBox,
      );
    }

    body.removeAttribute('aria-busy');
    body.replaceChildren(
      section(
        'Ordner',
        'folder',
        row('download_dir', 'Download-Ordner', dl.el, { stacked: true, description: withDefault('Hier legt ILIAS Sync die Kursmaterialien ab – pro Kurs ein Unterordner.', defaults, 'download_dir') }),
        row('local_download_dir', 'Zusätzliche lokale Kopie', local.el, {
          stacked: true,
          description: 'Optional. Neue Dateien werden zusätzlich hierhin kopiert, z. B. in einen iCloud- oder Nextcloud-Ordner.',
        }),
      ),
      section(
        'Kurse & Semester',
        'layers',
        row('auto_discover_current_semester', 'Kurse automatisch erkennen', autoDiscover, { description: withDefault('Findet alle Kurse, in denen du im aktuellen Semester Mitglied bist.', defaults, 'auto_discover_current_semester') }),
        row('semester_filter', 'Semester', semester, { description: withDefault('„auto“ wählt das laufende Semester. Oder fest, z. B. „WS26/27“ oder „SoSe27“.', defaults, 'semester_filter', (v) => `„${v}“`) }),
        row('include_configured_courses', 'Manuelle Kurse zusätzlich laden', includeConfigured, { description: withDefault('Lädt die unten eingetragenen Kurse auch bei automatischer Erkennung.', defaults, 'include_configured_courses') }),
        settingRow({ label: 'Manuelle Kurse', description: 'Kurse, die nicht automatisch gefunden werden – mit Link aus ILIAS („Permanenter Link“).', control: courses.el, stacked: true, errorKey: 'courses', errors }),
      ),
      section(
        'Downloads',
        'download',
        row('file_extensions', 'Dateitypen', exts.el, {
          stacked: true,
          description: withDefault('Nur Dateien mit diesen Endungen werden geladen.', defaults, 'file_extensions', (v) => `${v.length} gängige Typen (PDF, Office, Code, Bilder …)`),
        }),
        row('max_depth', 'Maximale Ordnertiefe', maxDepth, { description: withDefault('Wie tief Unterordner in ILIAS durchsucht werden (mindestens 1).', defaults, 'max_depth') }),
        row('overwrite', 'Geänderte Dateien überschreiben', overwrite, { description: withDefault('Aus: Vorhandene Dateien bleiben unverändert.', defaults, 'overwrite') }),
      ),
      section(
        'Anmeldung',
        'key',
        row('auto_login', 'Automatisch neu anmelden', autoLogin, { description: withDefault('Meldet sich mit den gespeicherten Zugangsdaten an, wenn die Sitzung abläuft.', defaults, 'auto_login') }),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'Zugangsdaten'), creds.el, credentialAdvanced),
        h('div', { class: 'subsection' }, h('h3', { class: 'subhead' }, 'ILIAS-Sitzung'), session.el),
      ),
      section(
        'Zeitplan',
        'calendar',
        scheduleBlock(ctx, schedule).el,
        row('notifications', 'Mitteilungen', notifications, { description: withDefault('Meldet neue Dateien oder eine erforderliche Anmeldung nach einem geplanten Lauf.', defaults, 'notifications') }),
        row('open_login_window_on_failure', 'Login-Fenster bei abgelaufener Sitzung öffnen', fallback, {
          description: withDefault('Öffnet bei einem geplanten Lauf das ILIAS-Login und versucht den Sync nach der Anmeldung erneut.', defaults, 'open_login_window_on_failure'),
        }),
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
