// Kleine DOM- und Formatierungshelfer ohne Abhängigkeiten.
import { icon } from './icons.js';

/**
 * Erzeugt ein DOM-Element.
 * h('button', {class: 'btn', onclick: fn, 'aria-label': 'x'}, 'Text', otherNode)
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** Ersetzt den Inhalt eines Elements. */
export function replaceChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/** Button mit optionalem Icon. */
export function button(label, { icon: iconName, variant = 'secondary', size, ...attrs } = {}) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', attrs.class ?? ''].filter(Boolean).join(' ');
  return h(
    'button',
    { type: 'button', ...attrs, class: cls },
    iconName ? icon(iconName, { size: size === 'lg' ? 18 : 16 }) : null,
    label ? h('span', { class: 'btn-label' }, label) : null,
  );
}

/** Icon-only-Button mit zugänglichem Namen und Tooltip. */
export function iconButton(iconName, label, attrs = {}) {
  return h(
    'button',
    { type: 'button', ...attrs, class: `btn btn-icon ${attrs.class ?? ''}`, 'aria-label': label, title: label },
    icon(iconName, { size: 16 }),
  );
}

// ---------------------------------------------------------------- Formatierung

const numberFmt = new Intl.NumberFormat('de-DE');
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long' });
const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

export const fmtNumber = (n) => numberFmt.format(n ?? 0);

export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(value) {
  const d = parseDate(value);
  return d ? dateTimeFmt.format(d) : '–';
}

export function fmtDate(value) {
  const d = parseDate(value);
  return d ? dateFmt.format(d) : '–';
}

export function fmtTime(value) {
  const d = parseDate(value);
  return d ? timeFmt.format(d) : '–';
}

/** „vor 3 Stunden“, „gestern“, „gerade eben“ … */
export function fmtRelative(value, now = Date.now()) {
  const d = parseDate(value);
  if (!d) return '–';
  const diffSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'gerade eben';
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / (86400 * 7)), 'week');
  return fmtDate(d);
}

/** Kurzer Tag für Listen: „Heute, 09:00“, „Gestern, 18:12“, „Montag, 09:00“, „12.11.2026“ */
export function fmtDayTime(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return '–';
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  const time = timeFmt.format(d);
  if (days === 0) return `Heute, ${time}`;
  if (days === 1) return `Gestern, ${time}`;
  if (days > 1 && days < 7) return `${weekdayFmt.format(d)}, ${time}`;
  return `${dateFmt.format(d)}, ${time}`;
}

export function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return '–';
  if (bytes < 1024) return `${fmtNumber(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const digits = value < 10 ? 1 : 0;
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[i]}`;
}

/** Dauer in Sekunden → „1 Min. 24 Sek.“ */
export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} Sek.`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m} Min. ${rest} Sek.` : `${m} Min.`;
  const hours = Math.floor(m / 60);
  return `${hours} Std. ${m % 60} Min.`;
}

/** Stoppuhr-Format „0:42“ / „1:05:10“ */
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export function runDurationSeconds(run, now = Date.now()) {
  const start = parseDate(run?.started_at);
  if (!start) return null;
  const end = parseDate(run.finished_at);
  return ((end ? end.getTime() : now) - start.getTime()) / 1000;
}

export const plural = (n, one, many) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------- Lauf-Ergebnisse

export const RESULT_META = {
  running: { tone: 'running', icon: 'sync', label: 'Läuft' },
  success: { tone: 'success', icon: 'checkCircle', label: 'Erfolgreich' },
  errors: { tone: 'warning', icon: 'warning', label: 'Mit Fehlern' },
  session_expired: { tone: 'danger', icon: 'lock', label: 'Sitzung abgelaufen' },
  offline: { tone: 'muted', icon: 'offline', label: 'Offline' },
  failed: { tone: 'danger', icon: 'error', label: 'Fehlgeschlagen' },
  cancelled: { tone: 'muted', icon: 'cancelled', label: 'Abgebrochen' },
};

export const TRIGGER_LABEL = { manual: 'manuell', schedule: 'automatisch', cli: 'Kommandozeile' };

export function resultMeta(result) {
  return RESULT_META[result] ?? { tone: 'muted', icon: 'info', label: result ?? 'Unbekannt' };
}

/** Kleines Ergebnis-Abzeichen. */
export function resultPill(result) {
  const meta = resultMeta(result);
  return h(
    'span',
    { class: `pill pill-${meta.tone}` },
    icon(meta.icon, { size: 13, className: result === 'running' ? 'spin' : '' }),
    meta.label,
  );
}

// ---------------------------------------------------------------- Sonstiges

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Lokale Präferenzen; robust gegen gesperrten Speicher. */
export const prefs = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`ilias-sync.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ilias-sync.${key}`, JSON.stringify(value));
    } catch {
      /* ignorieren */
    }
  },
};

/** Ordnerauswahl über das Desktop-Fenster (pywebview), falls verfügbar. */
export function hasNativeFolderPicker() {
  return Boolean(window.pywebview?.api?.choose_folder);
}

export async function chooseFolder(initial) {
  if (!hasNativeFolderPicker()) return null;
  try {
    return (await window.pywebview.api.choose_folder(initial ?? null)) || null;
  } catch {
    return null;
  }
}

/** Dateiauswahl (alte config.yaml) über das Desktop-Fenster, falls verfügbar. */
export function hasNativeFilePicker() {
  return Boolean(window.pywebview?.api?.choose_file);
}

export async function chooseFile(initial) {
  if (!hasNativeFilePicker()) return null;
  try {
    return (await window.pywebview.api.choose_file(initial ?? null)) || null;
  } catch {
    return null;
  }
}

/** Öffnet die Oberfläche im Standardbrowser (im Desktop-Fenster über pywebview). */
export async function openInBrowser(url = location.href) {
  if (window.pywebview?.api?.open_in_browser) {
    try {
      if (await window.pywebview.api.open_in_browser(url)) return true;
    } catch {
      /* Fallback unten */
    }
  }
  window.open(url, '_blank', 'noopener');
  return true;
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const REVEAL_LABEL = IS_MAC ? 'Im Finder zeigen' : 'Im Ordner zeigen';
