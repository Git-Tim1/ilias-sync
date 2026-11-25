// Inline-SVG-Icons (eigene, schlichte Strichgrafiken im Stil von macOS-Symbolen).
// Alle Icons nutzen currentColor und ein 24er-Raster.

const PATHS = {
  overview:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 7.5V12l3 2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.26.6.85 1 1.51 1.04H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>',
  sync:
    '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  flask:
    '<path d="M9 3h6"/><path d="M10 3v6L4.6 18.2A1.8 1.8 0 0 0 6.2 21h11.6a1.8 1.8 0 0 0 1.6-2.8L14 9V3"/><path d="M7.5 15h9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.8 2.8L16.2 9.5"/>',
  warning:
    '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4.5"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>',
  offline:
    '<path d="M2 8.8a15 15 0 0 1 4.2-2.6"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M5 12.5a10 10 0 0 1 5.2-2.7"/><path d="M15.3 10.3A10 10 0 0 1 19 12.5"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="M3 3l18 18"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3"/><path d="M16 7l3 3"/><path d="M18.5 4.5l2 2"/>',
  cancelled: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  folder:
    '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6a2 2 0 0 1 1.5.7L12 7.2h6.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
  folderOpen:
    '<path d="M3 17V7.5A2.5 2.5 0 0 1 5.5 5h3.6a2 2 0 0 1 1.5.7L12 7.2h5.5A2.5 2.5 0 0 1 20 9.7V11"/><path d="M3 17.6 5.2 12a1.6 1.6 0 0 1 1.5-1H21a1 1 0 0 1 .9 1.4l-2.2 5.9a2.3 2.3 0 0 1-2.1 1.5H5.2A2.2 2.2 0 0 1 3 17.6Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  reveal:
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  arrowDown: '<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7"/><path d="M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  download: '<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M4.5 19.5h15"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  layers: '<path d="M12 3 2.5 8 12 13l9.5-5Z"/><path d="M2.5 12.5 12 17.5l9.5-5"/><path d="M2.5 16.5 12 21.5l9.5-5"/>',
  logo:
    '<path d="M12 3.5 3 8l9 4.5L21 8Z"/><path d="M6.5 10v4.2c0 1.6 2.5 3.3 5.5 3.3s5.5-1.7 5.5-3.3V10"/><path d="M21 8v5.5"/>',
  // Dateityp-Symbole
  filePdf:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8.5 13.5h7"/><path d="M8.5 16.5h5"/>',
  fileSlides:
    '<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M12 17v3.5"/><path d="M8.5 20.5h7"/><path d="M8 13l2.8-3 2.4 2.2L16 9"/>',
  fileDoc:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7"/><path d="M8.5 15.5h7"/><path d="M8.5 18.5h4"/>',
  fileSheet:
    '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 9.5h16"/><path d="M4 15h16"/><path d="M10 9.5v11"/>',
  fileArchive:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M10 4v2"/><path d="M10 8v2"/><path d="M10 12v2"/><rect x="8.5" y="15" width="3" height="3.5" rx=".8"/>',
  fileImage:
    '<rect x="3.5" y="4" width="17" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.7"/><path d="M20.5 15.5 15.5 11 6 20"/>',
  fileVideo: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/>',
  fileCode:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M10 12.5 8 14.5l2 2"/><path d="M14 12.5l2 2-2 2"/>',
};

/**
 * Liefert ein SVG-Element für das Icon `name`.
 * @param {string} name
 * @param {{size?: number, className?: string, label?: string}} [opts]
 */
export function icon(name, opts = {}) {
  const size = opts.size ?? 18;
  const paths = PATHS[name] ?? PATHS.file;
  const wrapper = document.createElement('span');
  wrapper.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ` +
    `class="icon ${opts.className ?? ''}" ${opts.label ? `role="img" aria-label="${opts.label}"` : 'aria-hidden="true" focusable="false"'}>` +
    `${paths}</svg>`;
  return wrapper.firstElementChild;
}

/** Ordnet einer Dateiendung ein Icon und eine Typ-Kategorie zu. */
export function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: ['filePdf', 'PDF', 'pdf'],
    ppt: ['fileSlides', 'Präsentation', 'slides'],
    pptx: ['fileSlides', 'Präsentation', 'slides'],
    key: ['fileSlides', 'Präsentation', 'slides'],
    odp: ['fileSlides', 'Präsentation', 'slides'],
    doc: ['fileDoc', 'Dokument', 'doc'],
    docx: ['fileDoc', 'Dokument', 'doc'],
    odt: ['fileDoc', 'Dokument', 'doc'],
    txt: ['fileDoc', 'Dokument', 'doc'],
    md: ['fileDoc', 'Dokument', 'doc'],
    rtf: ['fileDoc', 'Dokument', 'doc'],
    xls: ['fileSheet', 'Tabelle', 'sheet'],
    xlsx: ['fileSheet', 'Tabelle', 'sheet'],
    csv: ['fileSheet', 'Tabelle', 'sheet'],
    ods: ['fileSheet', 'Tabelle', 'sheet'],
    zip: ['fileArchive', 'Archiv', 'archive'],
    rar: ['fileArchive', 'Archiv', 'archive'],
    '7z': ['fileArchive', 'Archiv', 'archive'],
    gz: ['fileArchive', 'Archiv', 'archive'],
    tar: ['fileArchive', 'Archiv', 'archive'],
    png: ['fileImage', 'Bild', 'image'],
    jpg: ['fileImage', 'Bild', 'image'],
    jpeg: ['fileImage', 'Bild', 'image'],
    gif: ['fileImage', 'Bild', 'image'],
    svg: ['fileImage', 'Bild', 'image'],
    mp4: ['fileVideo', 'Video', 'video'],
    mov: ['fileVideo', 'Video', 'video'],
    mkv: ['fileVideo', 'Video', 'video'],
    py: ['fileCode', 'Code', 'code'],
    java: ['fileCode', 'Code', 'code'],
    ipynb: ['fileCode', 'Code', 'code'],
    c: ['fileCode', 'Code', 'code'],
    cpp: ['fileCode', 'Code', 'code'],
    js: ['fileCode', 'Code', 'code'],
    sql: ['fileCode', 'Code', 'code'],
    hs: ['fileCode', 'Code', 'code'],
  };
  const [iconName, label, kind] = map[ext] ?? ['file', ext ? ext.toUpperCase() : 'Datei', 'other'];
  return { icon: iconName, label, kind, ext };
}
