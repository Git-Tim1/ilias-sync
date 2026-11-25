// Formularbausteine, die Einstellungen und Ersteinrichtung gemeinsam nutzen.
import { h, button, fmtRelative, hasNativeFolderPicker, chooseFolder } from '../util.js';
import { icon } from '../icons.js';
import { settingRow, switchInput, nextId, showFieldErrors, clearFieldErrors, LogView } from '../components.js';
import { errorMessage } from '../api.js';

// pywebview stellt seine JS-API ggf. erst nach dem Laden bereit.
window.addEventListener('pywebviewready', () => {
  for (const el of document.querySelectorAll('.js-folder-picker')) el.hidden = false;
});

/** Pfadeingabe mit optionaler nativer Ordnerauswahl und „Öffnen“. */
export function folderInput({ id = nextId('dir'), value = '', placeholder = '', which, ctx, optional = false }) {
  const input = h('input', {
    id,
    class: 'input input-path',
    type: 'text',
    value: value ?? '',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const pick = button('Auswählen …', {
    icon: 'folder',
    variant: 'secondary',
    size: 'sm',
    class: 'js-folder-picker',
    onclick: async () => {
      const path = await chooseFolder(input.value);
      if (path) {
        input.value = path;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },
  });
  pick.hidden = !hasNativeFolderPicker();
  const open =
    which && ctx
      ? button('Öffnen', {
          icon: 'folderOpen',
          variant: 'ghost',
          size: 'sm',
          title: optional ? 'Gespeicherten lokalen Ordner öffnen' : 'Gespeicherten Download-Ordner öffnen',
          onclick: () => ctx.actions.openFolder(which),
        })
      : null;
  const el = h('div', { class: 'path-field' }, input, pick, open);
  return { el, input, openButton: open };
}

// ------------------------------------------------------------------ Zugangsdaten

/**
 * Zugangsdaten: zeigt nur den maskierten Benutzernamen; das Passwort wird nie angezeigt.
 * @returns {{el: HTMLElement, save: () => Promise<boolean>, hasInput: () => boolean, refresh: () => Promise<void>}}
 */
export function credentialsBlock(ctx, { credentials, embedded = false, onChange } = {}) {
  let creds = credentials ?? { configured: false, username: null };
  const errors = new Map();
  const userId = nextId('user');
  const passId = nextId('pass');
  const username = h('input', {
    id: userId,
    class: 'input',
    type: 'text',
    autocomplete: 'username',
    spellcheck: 'false',
    autocapitalize: 'off',
    placeholder: 'Uni-Kennung, z. B. mmuster1',
  });
  const password = h('input', {
    id: passId,
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
    placeholder: '••••••••',
  });
  const reveal = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-icon input-addon',
      'aria-label': 'Passwort anzeigen',
      'aria-pressed': 'false',
      title: 'Passwort anzeigen',
      onclick: () => {
        const show = password.type === 'password';
        password.type = show ? 'text' : 'password';
        reveal.setAttribute('aria-pressed', String(show));
        reveal.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
      },
    },
    icon('reveal', { size: 15 }),
  );

  const statusLine = h('div', { class: 'cred-status' });
  const saveBtn = button('Speichern', { variant: 'primary', size: 'sm', onclick: () => save() });
  const deleteBtn = button('Löschen', { icon: 'trash', variant: 'danger-ghost', size: 'sm', onclick: () => askDelete() });
  const confirmBox = h('div', { class: 'confirm', hidden: true, role: 'alertdialog', 'aria-label': 'Zugangsdaten löschen?' });

  function renderStatus() {
    statusLine.replaceChildren(
      h('span', { class: `cred-icon ${creds.configured ? 'ok' : ''}` }, icon(creds.configured ? 'key' : 'lock', { size: 16 })),
      creds.configured
        ? h('span', {}, 'Gespeichert für ', h('strong', { class: 'mono' }, creds.username ?? '***'))
        : h('span', { class: 'muted' }, 'Keine Zugangsdaten gespeichert'),
    );
    deleteBtn.hidden = !creds.configured || embedded;
    saveBtn.querySelector('.btn-label').textContent = creds.configured ? 'Ersetzen' : 'Speichern';
  }

  function askDelete() {
    confirmBox.hidden = false;
    confirmBox.replaceChildren(
      h('span', {}, 'Zugangsdaten wirklich aus dem Schlüsselbund entfernen?'),
      button('Abbrechen', { variant: 'secondary', size: 'sm', onclick: () => (confirmBox.hidden = true) }),
      button('Entfernen', {
        variant: 'danger',
        size: 'sm',
        onclick: async () => {
          try {
            await ctx.api.deleteCredentials();
            creds = { configured: false, username: null };
            renderStatus();
            confirmBox.hidden = true;
            ctx.toast('Zugangsdaten entfernt.', { tone: 'neutral' });
            ctx.refreshStatus().catch(() => {});
            onChange?.(creds);
          } catch (err) {
            ctx.toast(errorMessage(err), { tone: 'danger' });
          }
        },
      }),
    );
    confirmBox.querySelector('.btn-secondary').focus();
  }

  const hasInput = () => Boolean(username.value.trim() || password.value);

  async function save() {
    clearFieldErrors(errors);
    if (!hasInput()) {
      showFieldErrors(errors, { username: 'Bitte Benutzernamen eingeben.', password: 'Bitte Passwort eingeben.' });
      return false;
    }
    saveBtn.disabled = true;
    try {
      const res = await ctx.api.putCredentials(username.value.trim(), password.value);
      creds = res && 'configured' in res ? res : await ctx.api.getCredentials();
      username.value = '';
      password.value = '';
      password.type = 'password';
      renderStatus();
      ctx.toast('Zugangsdaten im Schlüsselbund gespeichert.', { tone: 'success' });
      ctx.refreshStatus().catch(() => {});
      onChange?.(creds);
      return true;
    } catch (err) {
      if (err.fields) showFieldErrors(errors, err.fields);
      else ctx.toast(errorMessage(err), { tone: 'danger' });
      return false;
    } finally {
      saveBtn.disabled = false;
    }
  }

  for (const input of [username, password]) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !embedded) {
        ev.preventDefault();
        save();
      }
    });
  }

  renderStatus();
  const passField = h('div', { class: 'input-group' }, password, reveal);
  const el = h(
    'div',
    { class: 'cred-block' },
    statusLine,
    confirmBox,
    settingRow({ label: 'Benutzername', control: username, forId: userId, errorKey: 'username', errors, stacked: true }),
    settingRow({ label: 'Passwort', control: passField, forId: passId, errorKey: 'password', errors, stacked: true }),
    h('p', { class: 'hint' }, icon('lock', { size: 13 }), ' Wird nur im System-Schlüsselbund gespeichert und nie angezeigt oder protokolliert.'),
    embedded ? null : h('div', { class: 'row-actions' }, deleteBtn, h('span', { class: 'spacer' }), saveBtn),
  );
  password.setAttribute('aria-describedby', `${passId}-error`);
  return {
    el,
    save,
    hasInput,
    async refresh() {
      creds = await ctx.api.getCredentials();
      renderStatus();
    },
    get credentials() {
      return creds;
    },
  };
}

// ------------------------------------------------------------------ Sitzung

export function sessionBlock(ctx) {
  const line = h('div', { class: 'session-line', 'aria-live': 'polite' });
  const checkBtn = button('Sitzung prüfen', {
    variant: 'secondary',
    size: 'sm',
    onclick: async () => {
      checkBtn.disabled = true;
      await ctx.actions.checkSession();
      checkBtn.disabled = false;
    },
  });
  const loginBtn = button('Neu anmelden', { icon: 'user', variant: 'secondary', size: 'sm', onclick: () => ctx.actions.login() });
  const update = () => {
    const s = ctx.store.status?.session ?? { state: 'unknown' };
    const label = { valid: 'gültig', expired: 'abgelaufen', unknown: 'unbekannt', offline: 'ILIAS nicht erreichbar' }[s.state] ?? s.state;
    const tone = { valid: 'success', expired: 'danger' }[s.state] ?? 'muted';
    line.replaceChildren(
      h('span', { class: `dot dot-${tone}`, 'aria-hidden': 'true' }),
      h('span', {}, 'Sitzung: ', h('strong', {}, label)),
      s.checked_at ? h('span', { class: 'muted' }, ` · geprüft ${fmtRelative(s.checked_at)}`) : null,
    );
  };
  update();
  const off = ctx.store.on('status', update);
  const el = h('div', { class: 'session-block' }, line, h('div', { class: 'row-actions' }, checkBtn, loginBtn));
  return { el, destroy: off };
}

// ------------------------------------------------------------------ Zeitplan

export function scheduleBlock(ctx, schedule, { withSave = true } = {}) {
  let saved = { ...schedule };
  const errors = new Map();
  if (schedule && schedule.supported === false) {
    return {
      el: h(
        'div',
        { class: 'schedule-unsupported' },
        h('p', {}, 'Automatische Zeitpläne werden auf diesem System nicht direkt unterstützt. So richtest du sie selbst ein:'),
        h('pre', { class: 'code' }, schedule.instructions ?? 'Nutze die Aufgabenplanung deines Systems, um „ilias-sync sync“ täglich auszuführen.'),
      ),
      save: async () => true,
      value: () => schedule,
    };
  }
  const enabledId = nextId('sched');
  const timeId = nextId('time');
  const loginId = nextId('atlogin');
  const enabled = switchInput({ id: enabledId, checked: schedule.enabled });
  const time = h('input', { id: timeId, class: 'input input-time', type: 'time', value: schedule.time ?? '09:00', step: '60' });
  const atLogin = switchInput({ id: loginId, checked: schedule.run_at_login });
  const saveBtn = button('Zeitplan speichern', { variant: 'primary', size: 'sm', onclick: () => save() });

  const value = () => ({ enabled: enabled.checked, time: time.value || '09:00', run_at_login: atLogin.checked });
  const dirty = () => JSON.stringify(value()) !== JSON.stringify({ enabled: saved.enabled, time: saved.time, run_at_login: saved.run_at_login });
  const sync = () => {
    time.disabled = !enabled.checked;
    saveBtn.disabled = !dirty();
  };
  for (const el of [enabled, time, atLogin]) el.addEventListener('input', sync);
  for (const el of [enabled, atLogin]) el.addEventListener('change', sync);

  async function save() {
    clearFieldErrors(errors);
    saveBtn.disabled = true;
    try {
      const res = await ctx.api.putSchedule(value());
      saved = res && 'enabled' in res ? res : { ...saved, ...value() };
      if (withSave) ctx.toast('Zeitplan gespeichert.', { tone: 'success' });
      ctx.refreshStatus().catch(() => {});
      return true;
    } catch (err) {
      if (err.fields) showFieldErrors(errors, err.fields);
      else ctx.toast(errorMessage(err), { tone: 'danger' });
      return false;
    } finally {
      sync();
    }
  }

  const el = h(
    'div',
    { class: 'schedule-block' },
    settingRow({ label: 'Täglich automatisch synchronisieren', description: 'Läuft im Hintergrund, auch wenn dieses Fenster geschlossen ist.', control: enabled, forId: enabledId, errorKey: 'enabled', errors }),
    settingRow({ label: 'Uhrzeit', control: time, forId: timeId, errorKey: 'time', errors }),
    settingRow({ label: 'Beim Anmelden am Computer', description: 'Zusätzlich einmal synchronisieren, wenn du dich anmeldest.', control: atLogin, forId: loginId, errorKey: 'run_at_login', errors }),
    withSave ? h('div', { class: 'row-actions' }, h('span', { class: 'spacer' }), saveBtn) : null,
  );
  sync();
  return { el, save, value };
}

// ------------------------------------------------------------------ Browser-Komponente

/**
 * Status der Browser-Komponente (Playwright-Chromium) mit Installationsknopf und Live-Protokoll.
 * Entspricht `ilias-sync browser install`.
 */
export function browserBlock(ctx, { showLog = true } = {}) {
  const { store, actions } = ctx;
  const line = h('div', { class: 'browser-line', 'aria-live': 'polite' });
  const path = h('p', { class: 'setting-desc mono browser-path' });
  const installBtn = button('Installieren', { icon: 'download', variant: 'primary', size: 'sm', onclick: () => start() });
  const log = showLog ? new LogView({ label: 'Protokoll der Installation', height: '160px' }) : null;
  let logVisible = false;
  if (log) log.el.hidden = true;

  function start() {
    logVisible = true;
    log?.setLines([]);
    actions.installBrowser();
  }

  function update() {
    const b = store.browser;
    let tone = 'muted';
    let text = 'Wird geprüft …';
    if (b?.unavailable) text = 'Wird in dieser Version separat verwaltet';
    else if (b?.installing) {
      tone = 'running';
      text = 'Wird installiert … (einige Minuten, ca. 150 MB)';
    } else if (b?.installed) {
      tone = 'success';
      text = 'Installiert';
    } else if (b) {
      tone = 'danger';
      text = b.error ? `Installation fehlgeschlagen: ${b.error}` : 'Nicht installiert – ohne Chromium kann ILIAS Sync nicht synchronisieren';
    }
    line.replaceChildren(
      tone === 'running' ? icon('sync', { size: 14, className: 'spin' }) : h('span', { class: `dot dot-${tone}`, 'aria-hidden': 'true' }),
      h('span', {}, 'Chromium: ', h('strong', {}, text)),
    );
    path.textContent = b?.installed && b.executable ? b.executable : '';
    path.hidden = !path.textContent;
    installBtn.hidden = !b || b.unavailable;
    installBtn.disabled = Boolean(b?.installing);
    installBtn.querySelector('.btn-label').textContent = b?.installed ? 'Neu installieren' : b?.installing ? 'Installiere …' : 'Installieren';
    installBtn.className = installBtn.className.replace(/btn-(primary|secondary)/, b?.installed ? 'btn-secondary' : 'btn-primary');
    if (log) log.el.hidden = !(logVisible || b?.installing);
  }

  const offs = [store.on('browser', update)];
  if (log) offs.push(store.on('log', (l) => (logVisible || store.browser?.installing) && log.add([l])));
  update();
  if (!store.browser) actions.refreshBrowser();
  const el = h('div', { class: 'browser-block' }, h('div', { class: 'browser-head' }, h('div', {}, line, path), installBtn), log?.el);
  return {
    el,
    destroy() {
      offs.forEach((fn) => fn());
      log?.destroy();
    },
  };
}
