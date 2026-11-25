// Wiederverwendbare UI-Bausteine: Live-Log, Toasts, Hinweise, Schalter.
import { h, button, iconButton } from './util.js';
import { icon } from './icons.js';

const MAX_LOG_LINES = 1500;

function classifyLine(line) {
  if (/\b(ERROR|CRITICAL)\b|fehlgeschlagen|Fehler:/i.test(line)) return 'log-error';
  if (/\bWARN(ING)?\b|abgebrochen|abgelaufen/i.test(line)) return 'log-warn';
  if (/\bNeu:|Anmeldung erfolgreich|Fertig:/.test(line)) return 'log-ok';
  if (/\[dry-run\]/.test(line)) return 'log-dry';
  return '';
}

/**
 * Live-Log mit Autoscroll. Scrollt der Nutzer nach oben, pausiert das
 * Mitlaufen; ein Button springt wieder ans Ende.
 */
export class LogView {
  constructor({ label = 'Protokoll', height } = {}) {
    this.stick = true;
    this.pending = [];
    this.frame = 0;
    this.list = h('div', {
      class: 'log',
      role: 'log',
      'aria-label': label,
      'aria-live': 'off',
      tabindex: '0',
      style: height ? { height } : undefined,
    });
    this.jump = button('Neue Zeilen', {
      icon: 'arrowDown',
      variant: 'floating',
      size: 'sm',
      class: 'log-jump',
      onclick: () => this.scrollToEnd(true),
    });
    this.jump.hidden = true;
    this.empty = h('div', { class: 'log-empty' }, 'Noch keine Ausgaben.');
    this.el = h('div', { class: 'log-wrap' }, this.list, this.empty, this.jump);
    this.list.addEventListener('scroll', () => {
      const atEnd = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 12;
      this.stick = atEnd;
      if (atEnd) this.jump.hidden = true;
    });
  }

  setLines(lines) {
    this.list.replaceChildren();
    this.pending = [];
    this.add(lines);
  }

  add(lines) {
    this.pending.push(...lines);
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  flush() {
    this.frame = 0;
    if (!this.pending.length) {
      this.empty.hidden = this.list.childElementCount > 0;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const line of this.pending.splice(0)) {
      frag.appendChild(h('div', { class: `log-line ${classifyLine(line)}` }, line));
    }
    this.list.appendChild(frag);
    const overflow = this.list.childElementCount - MAX_LOG_LINES;
    for (let i = 0; i < overflow; i += 1) this.list.firstElementChild.remove();
    this.empty.hidden = true;
    if (this.stick) this.scrollToEnd();
    else this.jump.hidden = false;
  }

  scrollToEnd(focus = false) {
    this.list.scrollTop = this.list.scrollHeight;
    this.stick = true;
    this.jump.hidden = true;
    if (focus) this.list.focus({ preventScroll: true });
  }

  destroy() {
    cancelAnimationFrame(this.frame);
  }
}

// ------------------------------------------------------------------ Toasts

let toastRegion;

export function toast(message, { tone = 'neutral', timeout = 4200 } = {}) {
  toastRegion ??= document.getElementById('toasts');
  const iconName = { success: 'checkCircle', danger: 'error', warning: 'warning', neutral: 'info' }[tone] ?? 'info';
  const el = h(
    'div',
    { class: `toast toast-${tone}`, role: tone === 'danger' ? 'alert' : 'status' },
    icon(iconName, { size: 16 }),
    h('span', { class: 'toast-text' }, message),
  );
  const close = iconButton('close', 'Hinweis schließen', {
    class: 'toast-close',
    onclick: () => dismiss(),
  });
  el.appendChild(close);
  toastRegion.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-in'));
  let timer = setTimeout(dismiss, timeout);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => {
    timer = setTimeout(dismiss, 1800);
  });
  function dismiss() {
    clearTimeout(timer);
    el.classList.remove('toast-in');
    setTimeout(() => el.remove(), 220);
  }
}

// ------------------------------------------------------------------ aria-live

export function announce(message) {
  const region = document.getElementById('announcer');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 40);
}

// ------------------------------------------------------------------ Hinweise

export function notice({ tone = 'info', iconName = 'info', title, text, actions = [] }) {
  return h(
    'div',
    { class: `notice notice-${tone}` },
    h('div', { class: 'notice-icon' }, icon(iconName, { size: 20 })),
    h('div', { class: 'notice-body' }, h('strong', { class: 'notice-title' }, title), text ? h('p', {}, text) : null),
    actions.length ? h('div', { class: 'notice-actions' }, actions) : null,
  );
}

// ------------------------------------------------------------------ Formularbausteine

let uid = 0;
export const nextId = (prefix = 'f') => `${prefix}-${(uid += 1)}`;

/** Schalter (Checkbox mit role=switch). */
export function switchInput({ id = nextId('sw'), checked = false, onchange, label } = {}) {
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    id,
    checked,
    'aria-label': label,
    onchange,
  });
  return input;
}

/** Zeile im Stil der macOS-Systemeinstellungen: Beschriftung links, Steuerung rechts. */
export function settingRow({ label, description, control, forId, stacked = false, errorKey, errors }) {
  const errorEl = h('p', { class: 'field-error', id: forId ? `${forId}-error` : undefined, hidden: true });
  if (errorKey && errors) errors.set(errorKey, { el: errorEl, input: control });
  if (forId && control instanceof HTMLElement && control.matches?.('input,select,textarea')) {
    const describedBy = [description ? `${forId}-desc` : null, `${forId}-error`].filter(Boolean).join(' ');
    control.setAttribute('aria-describedby', describedBy);
  }
  return h(
    'div',
    { class: `setting-row${stacked ? ' stacked' : ''}` },
    h(
      'div',
      { class: 'setting-text' },
      h('label', { class: 'setting-label', for: forId }, label),
      description ? h('p', { class: 'setting-desc', id: forId ? `${forId}-desc` : undefined }, description) : null,
    ),
    h('div', { class: 'setting-control' }, control, errorEl),
  );
}

/** Zeigt feldgenaue Fehler (422) an. */
export function showFieldErrors(errors, fields = {}) {
  let first = null;
  for (const [key, { el, input }] of errors) {
    const msg = Object.entries(fields).find(([k]) => k === key || k.startsWith(`${key}.`) || k.startsWith(`${key}[`))?.[1];
    el.hidden = !msg;
    el.textContent = msg ?? '';
    const target = input?.matches?.('input,select,textarea') ? input : input?.querySelector?.('input,select,textarea');
    if (target) {
      if (msg) target.setAttribute('aria-invalid', 'true');
      else target.removeAttribute('aria-invalid');
    }
    if (msg && !first) first = target ?? el;
  }
  first?.focus?.();
  return Boolean(first);
}

export function clearFieldErrors(errors) {
  showFieldErrors(errors, {});
}

/** Chips-Eingabe für Dateiendungen. */
export function chipsInput({ id = nextId('chips'), values = [], suggestions = [], onchange }) {
  let items = [...values];
  const list = h('ul', { class: 'chips', 'aria-label': 'Ausgewählte Dateitypen' });
  const input = h('input', {
    id,
    class: 'input chips-input',
    type: 'text',
    placeholder: 'Endung hinzufügen …',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Dateiendung hinzufügen',
  });
  const suggest = h('div', { class: 'chips-suggest' });

  const normalize = (v) => v.trim().toLowerCase().replace(/^\.+/, '');
  const addValue = (raw) => {
    const parts = raw.split(/[\s,;]+/).map(normalize).filter(Boolean);
    let changed = false;
    for (const v of parts) {
      if (!items.includes(v)) {
        items.push(v);
        changed = true;
      }
    }
    if (changed) {
      render();
      onchange?.(items);
    }
  };
  const removeValue = (v) => {
    items = items.filter((x) => x !== v);
    render();
    onchange?.(items);
    input.focus();
  };

  function render() {
    list.replaceChildren(
      ...items.map((v) =>
        h(
          'li',
          { class: 'chip' },
          h('span', {}, `.${v}`),
          h(
            'button',
            { type: 'button', class: 'chip-remove', 'aria-label': `.${v} entfernen`, title: 'Entfernen', onclick: () => removeValue(v) },
            icon('close', { size: 12 }),
          ),
        ),
      ),
    );
    const missing = suggestions.filter((s) => !items.includes(s));
    suggest.replaceChildren(
      missing.length ? h('span', { class: 'chips-suggest-label' }, 'Vorschläge:') : null,
      ...missing.map((s) =>
        h('button', { type: 'button', class: 'chip chip-ghost', onclick: () => addValue(s) }, icon('plus', { size: 12 }), `.${s}`),
      ),
    );
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ',' || ev.key === ' ') {
      if (input.value.trim()) {
        ev.preventDefault();
        addValue(input.value);
        input.value = '';
      } else if (ev.key === 'Enter') ev.preventDefault();
    } else if (ev.key === 'Backspace' && !input.value && items.length) {
      removeValue(items[items.length - 1]);
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      addValue(input.value);
      input.value = '';
    }
  });

  render();
  const el = h('div', { class: 'chips-field' }, h('div', { class: 'chips-box', onclick: (e) => e.target === e.currentTarget && input.focus() }, list, input), suggest);
  return {
    el,
    input,
    get value() {
      return [...items];
    },
    set value(v) {
      items = [...v];
      render();
    },
  };
}
