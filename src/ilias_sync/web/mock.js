// Mock-Backend für `index.html?mock=1` – läuft komplett ohne Server.
// Implementiert dieselbe Schnittstelle wie createHttpApi() in api.js und
// simuliert Läufe inklusive Log-Stream. Alle Daten sind erfunden.
//
// Optionale Parameter:
//   scenario=ok|errors|expired|offline|setup|running   (Standard: ok)
//   speed=<Faktor>                                      (Standard: 1)

import { ApiError } from './api.js';

const BASE = 'https://www.ilias.uni-koeln.de/ilias/';
const ROOT = '~/Documents/Uni/ILIAS';

const COURSES = [
  { name: '[WS26/27] Softwaretechnik', short: 'Softwaretechnik', id: 5512034, found: 38 },
  { name: '[WS26/27] Datenbanken und Informationssysteme', short: 'Datenbanken', id: 5512188, found: 31 },
  { name: '[WS26/27] Theoretische Informatik', short: 'Theoretische Informatik', id: 5509871, found: 24 },
  { name: '[WS26/27] Mathematik für Informatiker I', short: 'Mathematik I', id: 5507420, found: 27 },
  { name: '[WS26/27] Betriebssysteme und Rechnernetze', short: 'Betriebssysteme', id: 5513302, found: 19 },
  { name: '[WS26/27] Seminar: Maschinelles Lernen', short: 'Seminar ML', id: 5514455, found: 9 },
];

const courseUrl = (c) => `${BASE}goto.php/crs/${c.id}`;
const byShort = (s) => COURSES.find((c) => c.short === s);

// --------------------------------------------------------------- Zeitfunktionen

function isoLocal(date) {
  const pad = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** Zeitpunkt: vor `daysAgo` Tagen um hh:mm:ss (lokal). Liegt er in der Zukunft, einen Tag früher. */
function at(daysAgo, hh, mm, ss = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hh, mm, ss);
  if (d > now) d.setDate(d.getDate() - 1);
  return d;
}

const addSec = (d, s) => new Date(d.getTime() + s * 1000);
const runIdFor = (d) => isoLocal(d).slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const timeStamp = (d = new Date()) => isoLocal(d).slice(11, 19);

// --------------------------------------------------------------- Dateien

const FILE_SEED = [
  // [Kurs, Ordner, Name, Größe, Tage zurück, Stunde, Minute]
  ['Softwaretechnik', 'Vorlesungsfolien', 'VL07_Entwurfsmuster.pdf', 3_482_112, 0, 9, 1],
  ['Datenbanken', 'Übungen', 'Uebungsblatt_06_SQL.pdf', 412_880, 0, 9, 1],
  ['Seminar ML', 'Literatur', 'Vaswani_2017_Attention.pdf', 2_215_604, 0, 9, 2],
  ['Mathematik I', 'Übungsblätter', 'Hausaufgabe_07.pdf', 198_340, 1, 9, 2],
  ['Datenbanken', 'Vorlesungsfolien', 'Kapitel_4_Normalformen.pptx', 6_904_221, 1, 9, 1],
  ['Datenbanken', 'Übungen', 'sql_beispieldaten.zip', 1_288_012, 2, 18, 43],
  ['Softwaretechnik', 'Übungsblätter', 'Blatt_06_UML.pdf', 356_771, 2, 18, 43],
  ['Theoretische Informatik', 'Lösungen', 'Loesung_Blatt_05.pdf', 289_455, 4, 9, 2],
  ['Betriebssysteme', 'Vorlesungsfolien', 'BS_06_Prozesse_und_Threads.pdf', 4_120_009, 5, 9, 1],
  ['Betriebssysteme', 'Praktikum', 'praktikum_03_scheduler.py', 7_811, 5, 9, 1],
  ['Softwaretechnik', 'Material', 'Klassendiagramm_Bibliothek.png', 241_992, 5, 9, 2],
  ['Seminar ML', 'Organisation', 'Themenvergabe_WS2627.xlsx', 22_418, 6, 9, 1],
  ['Mathematik I', 'Skript', 'Skript_Lineare_Algebra_v3.pdf', 8_733_015, 6, 9, 1],
  ['Theoretische Informatik', 'Vorlesungsfolien', 'TI_09_Kontextfreie_Grammatiken.pdf', 1_902_345, 7, 9, 1],
  ['Betriebssysteme', 'Aufzeichnungen', 'Tutorium_03_Speicherverwaltung.mp4', 184_220_431, 7, 9, 3],
  ['Seminar ML', 'Organisation', 'Seminarplan.docx', 48_112, 8, 9, 1],
  ['Softwaretechnik', 'Projekt', 'Projektvorlage_Gradle.zip', 3_008_700, 9, 9, 2],
  ['Mathematik I', 'Übungsblätter', 'Hausaufgabe_06.pdf', 187_020, 9, 9, 2],
];

function makeFile([short, folder, name, size, daysAgo, hh, mm], idx = 0) {
  const course = byShort(short);
  return {
    path: `${ROOT}/${course.short}/${folder}/${name}`,
    name,
    course: course.short,
    folder,
    size,
    downloaded_at: isoLocal(at(daysAgo, hh, mm, 12 + idx)),
  };
}

// --------------------------------------------------------------- Läufe

function courseReports({ newFiles = [], errorCourse = null, errorMessage = null, onlyFirst = null } = {}) {
  const list = onlyFirst ? COURSES.slice(0, onlyFirst) : COURSES;
  return list.map((c) => {
    const downloaded = newFiles.filter((f) => f.course === c.short).length;
    const errors = c.short === errorCourse ? 1 : 0;
    return {
      name: c.name,
      short_name: c.short,
      url: courseUrl(c),
      found: c.found,
      downloaded,
      skipped: c.found - downloaded - errors,
      errors,
      error_message: errors ? errorMessage : null,
    };
  });
}

function totalsOf(courses) {
  return courses.reduce(
    (t, c) => ({
      found: t.found + c.found,
      downloaded: t.downloaded + c.downloaded,
      skipped: t.skipped + c.skipped,
      errors: t.errors + c.errors,
    }),
    { found: 0, downloaded: 0, skipped: 0, errors: 0 },
  );
}

function makeRun({ start, seconds, trigger = 'schedule', result = 'success', message = '', dryRun = false, courses = [], newFiles = [] }) {
  return {
    run_id: runIdFor(start),
    trigger,
    started_at: isoLocal(start),
    finished_at: isoLocal(addSec(start, seconds)),
    result,
    message,
    dry_run: dryRun,
    semester: 'WS26/27',
    totals: totalsOf(courses),
    courses,
    new_files: newFiles,
  };
}

function buildRuns(files) {
  const filesOn = (daysAgo, hh) =>
    files.filter((f) => {
      const d = new Date(f.downloaded_at);
      const ref = at(daysAgo, hh, 0);
      return d.toDateString() === ref.toDateString() && d.getHours() === hh;
    });

  const runs = [];
  const add = (cfg) => runs.push(makeRun(cfg));

  let nf = filesOn(0, 9);
  add({ start: at(0, 9, 0, 4), seconds: 97, courses: courseReports({ newFiles: nf }), newFiles: nf });

  nf = filesOn(1, 9);
  add({
    start: at(1, 9, 0, 3),
    seconds: 124,
    result: 'errors',
    message: '1 Datei konnte nicht geladen werden.',
    courses: courseReports({
      newFiles: nf,
      errorCourse: 'Theoretische Informatik',
      errorMessage: 'Download fehlgeschlagen: „Loesung_Blatt_06.pdf“ (HTTP 503 – Server vorübergehend nicht verfügbar)',
    }),
    newFiles: nf,
  });

  nf = filesOn(2, 18);
  add({ start: at(2, 18, 42, 10), seconds: 88, trigger: 'manual', courses: courseReports({ newFiles: nf }), newFiles: nf });

  add({
    start: at(3, 9, 0, 2),
    seconds: 14,
    result: 'session_expired',
    message: 'Die ILIAS-Sitzung ist abgelaufen und die automatische Anmeldung ist fehlgeschlagen. Bitte neu anmelden.',
  });

  nf = filesOn(4, 9);
  add({ start: at(4, 9, 0, 5), seconds: 102, courses: courseReports({ newFiles: nf }), newFiles: nf });

  add({
    start: at(4, 7, 45, 0),
    seconds: 6,
    trigger: 'cli',
    result: 'offline',
    message: 'www.ilias.uni-koeln.de ist nicht erreichbar. Besteht eine Internetverbindung?',
  });

  nf = filesOn(5, 9);
  add({ start: at(5, 9, 0, 3), seconds: 131, courses: courseReports({ newFiles: nf }), newFiles: nf });

  add({
    start: at(5, 20, 14, 0),
    seconds: 41,
    trigger: 'manual',
    dryRun: true,
    courses: courseReports({ newFiles: [] }),
  });

  add({
    start: at(6, 12, 30, 0),
    seconds: 23,
    trigger: 'manual',
    result: 'cancelled',
    message: 'Vom Benutzer abgebrochen.',
    courses: courseReports({ onlyFirst: 2 }),
  });

  nf = filesOn(6, 9);
  add({ start: at(6, 9, 0, 2), seconds: 115, courses: courseReports({ newFiles: nf }), newFiles: nf });

  nf = filesOn(7, 9);
  add({ start: at(7, 9, 0, 6), seconds: 119, courses: courseReports({ newFiles: nf }), newFiles: nf });

  add({
    start: at(8, 9, 0, 1),
    seconds: 3,
    result: 'failed',
    message: 'Chromium konnte nicht gestartet werden. Bitte „playwright install chromium“ ausführen.',
  });

  return runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

// --------------------------------------------------------------- Mock-API

export function createMockApi(params = new URLSearchParams()) {
  const scenario = params.get('scenario') || 'ok';
  const speed = Math.max(0.1, Number(params.get('speed')) || 1);

  const db = {
    config: {
      base_url: BASE,
      login_url: `${BASE}login.php?client_id=uk&cmd=force_login&lang=de`,
      download_dir: `${ROOT}`,
      local_download_dir: '~/Library/Mobile Documents/com~apple~CloudDocs/Uni',
      auto_discover_current_semester: true,
      semester_filter: 'auto',
      include_configured_courses: false,
      courses: {
        'Brückenkurs Programmieren': `${BASE}goto.php/crs/4980012`,
      },
      file_extensions: ['pdf', 'pptx', 'docx', 'xlsx', 'zip', 'py', 'ipynb', 'png', 'mp4'],
      max_depth: 10,
      overwrite: false,
      auto_login: true,
      keychain_service: 'ilias-koeln-sync',
      open_login_window_on_failure: true,
      notifications: true,
    },
    credentials: { configured: true, username: 'mm***r' },
    schedule: { supported: true, enabled: true, time: '09:00', run_at_login: true },
    session: { state: 'valid', checked_at: isoLocal(at(0, 9, 0, 1)) },
    files: FILE_SEED.map(makeFile).sort((a, b) => b.downloaded_at.localeCompare(a.downloaded_at)),
    runs: [],
    current: null,
    logs: [],
  };
  db.runs = buildRuns(db.files);

  // Szenarien: der jüngste Lauf wird ersetzt
  const latestStart = at(0, 9, 0, 4);
  if (scenario === 'expired') {
    db.runs[0] = makeRun({
      start: latestStart,
      seconds: 12,
      result: 'session_expired',
      message: 'Die ILIAS-Sitzung ist abgelaufen und die automatische Anmeldung ist fehlgeschlagen. Bitte neu anmelden.',
    });
    db.session = { state: 'expired', checked_at: isoLocal(addSec(latestStart, 10)) };
  } else if (scenario === 'offline') {
    db.runs[0] = makeRun({
      start: latestStart,
      seconds: 5,
      result: 'offline',
      message: 'www.ilias.uni-koeln.de ist nicht erreichbar. Besteht eine Internetverbindung?',
    });
    db.session = { state: 'unknown', checked_at: null };
  } else if (scenario === 'errors') {
    db.runs[0] = { ...db.runs[1], run_id: runIdFor(latestStart), started_at: isoLocal(latestStart), finished_at: isoLocal(addSec(latestStart, 124)) };
  } else if (scenario === 'setup') {
    db.runs = [];
    db.files = [];
    db.credentials = { configured: false, username: null };
    db.schedule = { supported: true, enabled: false, time: '09:00', run_at_login: false };
    db.session = { state: 'unknown', checked_at: null };
    db.config.download_dir = '~/Documents/Uni/ILIAS';
    db.config.local_download_dir = null;
    db.config.courses = {};
  }

  db.logs = [
    `${timeStamp(latestStart)} INFO  Starte Synchronisierung (automatisch)`,
    `${timeStamp(addSec(latestStart, 2))} INFO  Sitzung gültig`,
    `${timeStamp(addSec(latestStart, 3))} INFO  Suche ILIAS-Kurse für Semester: WS26/27`,
    `${timeStamp(addSec(latestStart, 6))} INFO  ${COURSES.length} Kurse gefunden`,
  ];

  const listeners = new Set();
  const emit = (type, data) => {
    for (const l of listeners) {
      const fn = { log: l.onLog, status: l.onStatus, run_finished: l.onRunFinished }[type];
      try {
        // Gleiche Form wie die HTTP-API: onLog erhält den Text, die anderen das Objekt.
        fn?.(type === 'log' ? data.line : structuredClone(data));
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  };
  const log = (text, level = 'INFO ') => {
    const line = `${timeStamp()} ${level} ${text}`;
    db.logs.push(line);
    if (db.logs.length > 2000) db.logs.splice(0, db.logs.length - 2000);
    emit('log', { line });
  };

  const status = () => ({
    running: Boolean(db.current),
    current: db.current,
    last_run: db.runs[0] ?? null,
    session: db.session,
    credentials_configured: db.credentials.configured,
    schedule: db.schedule,
    version: '0.1.0',
  });
  const emitStatus = () => emit('status', status());

  const delay = (ms = 120 + Math.random() * 140) => new Promise((r) => setTimeout(r, ms));
  const respond = async (value) => {
    await delay();
    return structuredClone(value);
  };

  // ------------------------------------------------------------ simulierter Lauf

  let cancelRequested = false;

  function plannedNewFiles() {
    return [
      ['Softwaretechnik', 'Vorlesungsfolien', 'VL08_Softwaretests.pdf', 2_841_766],
      ['Mathematik I', 'Übungsblätter', 'Hausaufgabe_08.pdf', 204_118],
      ['Seminar ML', 'Literatur', 'He_2016_Deep_Residual_Learning.pdf', 802_415],
    ];
  }

  async function simulateRun({ dryRun, trigger }) {
    const start = new Date();
    cancelRequested = false;
    db.current = {
      run_id: runIdFor(start),
      trigger,
      started_at: isoLocal(start),
      finished_at: null,
      result: 'running',
      message: '',
      dry_run: dryRun,
      semester: 'WS26/27',
      totals: { found: 0, downloaded: 0, skipped: 0, errors: 0 },
      courses: [],
      new_files: [],
      // Nicht im Vertrag (Wunsch, siehe Bericht): optionaler Fortschritt.
      progress: { courses_done: 0, courses_total: COURSES.length, current_course: null },
    };
    const step = (ms) => new Promise((r) => setTimeout(r, ms / speed));
    const planned = dryRun ? [] : plannedNewFiles();
    const dryPlanned = plannedNewFiles();

    emitStatus();
    log(`Starte ${dryRun ? 'Probelauf' : 'Synchronisierung'} (${trigger === 'manual' ? 'manuell' : 'automatisch'})`);
    await step(500);
    log('Prüfe ILIAS-Sitzung …');
    await step(600);
    log('Sitzung gültig');
    await step(400);
    log('Suche ILIAS-Kurse für Semester: WS26/27');
    await step(700);
    log(`${COURSES.length} Kurse gefunden`);
    emitStatus();

    for (const [index, c] of COURSES.entries()) {
      if (cancelRequested) break;
      db.current.progress = { courses_done: index, courses_total: COURSES.length, current_course: c.short };
      emitStatus();
      log(`Synchronisiere Kurs: ${c.name}`);
      await step(350);
      log(`Öffne: ${courseUrl(c)}`);
      await step(450);
      const mine = (dryRun ? dryPlanned : planned).filter((p) => p[0] === c.short);
      log(`${c.found} Download-Kandidaten, ${c.found - mine.length} bereits vorhanden`);
      await step(400);
      for (const [, folder, name, size] of mine) {
        if (dryRun) {
          log(`[dry-run] Download: ${folder}/${name} -> ${ROOT}/${c.short}/${folder}/${name}`);
        } else {
          log(`Lade: ${folder}/${name}`);
          await step(700);
          const file = {
            path: `${ROOT}/${c.short}/${folder}/${name}`,
            name,
            course: c.short,
            folder,
            size,
            downloaded_at: isoLocal(new Date()),
          };
          db.current.new_files.push(file);
          log(`Neu: ${folder}/${name} (${(size / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB)`);
        }
        await step(250);
      }
      const downloaded = dryRun ? 0 : mine.length;
      db.current.courses.push({
        name: c.name,
        short_name: c.short,
        url: courseUrl(c),
        found: c.found,
        downloaded,
        skipped: c.found - downloaded,
        errors: 0,
        error_message: null,
      });
      db.current.totals = totalsOf(db.current.courses);
      db.current.progress = { courses_done: index + 1, courses_total: COURSES.length, current_course: c.short };
      emitStatus();
      await step(300);
    }

    const finished = db.current;
    finished.finished_at = isoLocal(new Date());
    delete finished.progress;
    if (cancelRequested) {
      finished.result = 'cancelled';
      finished.message = 'Vom Benutzer abgebrochen.';
      log('Lauf abgebrochen.', 'WARN ');
    } else {
      finished.result = 'success';
      log(
        `Fertig: ${finished.totals.found} gefunden, ${finished.totals.downloaded} neu, ` +
          `${finished.totals.skipped} übersprungen, ${finished.totals.errors} Fehler`,
      );
    }
    db.runs.unshift(finished);
    if (!dryRun) db.files = [...finished.new_files.slice().reverse(), ...db.files];
    db.current = null;
    db.session = { state: 'valid', checked_at: isoLocal(new Date()) };
    emit('run_finished', finished);
    emitStatus();
  }

  // ------------------------------------------------------------ Validierung

  function validateConfig(partial) {
    const fields = {};
    if ('download_dir' in partial) {
      const v = String(partial.download_dir ?? '').trim();
      if (!v) fields.download_dir = 'Bitte einen Download-Ordner angeben.';
      else if (!/^(\/|~)/.test(v)) fields.download_dir = 'Bitte einen absoluten Pfad angeben (beginnt mit / oder ~).';
    }
    if ('local_download_dir' in partial && partial.local_download_dir) {
      if (!/^(\/|~)/.test(partial.local_download_dir)) fields.local_download_dir = 'Bitte einen absoluten Pfad angeben.';
    }
    if ('max_depth' in partial) {
      const n = partial.max_depth;
      if (!Number.isInteger(n) || n < 1) fields.max_depth = 'Bitte eine ganze Zahl ab 1 angeben.';
    }
    if ('file_extensions' in partial) {
      const bad = (partial.file_extensions ?? []).filter((e) => !/^[a-z0-9]{1,10}$/.test(e));
      if (!partial.file_extensions?.length) fields.file_extensions = 'Mindestens ein Dateityp ist nötig.';
      else if (bad.length) fields.file_extensions = `Ungültige Endung: ${bad.join(', ')}`;
    }
    if ('semester_filter' in partial) {
      const v = String(partial.semester_filter ?? '').trim();
      if (v && v !== 'auto' && !/^(WS\d{2}\/\d{2}|SS\d{2}|SoSe\s?\d{2}|Sommersemester\s?20\d{2}|WiSe\s?\d{2}\/\d{2})$/i.test(v))
        fields.semester_filter = 'Format: „auto“, „WS26/27“ oder „SoSe27“.';
    }
    if ('courses' in partial) {
      const bad = Object.entries(partial.courses ?? {}).filter(([n, u]) => !n.trim() || !/^https?:\/\//.test(u));
      if (bad.length) fields.courses = 'Jeder Kurs braucht einen Namen und eine vollständige URL (https://…).';
    }
    for (const key of ['base_url', 'login_url']) {
      if (key in partial && !/^https?:\/\//.test(partial[key] ?? '')) fields[key] = 'Bitte eine vollständige URL angeben.';
    }
    return fields;
  }

  // ------------------------------------------------------------ Öffentliche API

  const api = {
    mock: true,
    scenario,
    getStatus: () => respond(status()),
    async startSync({ dryRun = false } = {}) {
      await delay();
      if (db.current) throw new ApiError(409, { error: 'already_running', message: 'Es läuft bereits eine Synchronisierung.' });
      if (db.session.state === 'expired' && !db.config.auto_login) {
        throw new ApiError(409, { error: 'session_expired', message: 'Die Sitzung ist abgelaufen. Bitte zuerst neu anmelden.' });
      }
      const runId = runIdFor(new Date());
      simulateRun({ dryRun, trigger: 'manual' });
      return { run_id: runId };
    },
    async cancelSync() {
      await delay();
      if (db.current) {
        cancelRequested = true;
        log('Abbruch angefordert – beende nach aktuellem Schritt …', 'WARN ');
      }
      return { cancelled: Boolean(db.current) };
    },
    getRuns: (limit = 20) => respond(db.runs.slice(0, limit)),
    getRecentFiles: (limit = 50) => respond(db.files.slice(0, limit)),
    openFile: (path) => respond({ opened: path }),
    revealFile: (path) => respond({ revealed: path }),
    openFolder: (which) => respond({ opened: which }),
    getLogs: (lines = 200) => respond({ lines: db.logs.slice(-lines) }),
    getConfig: () => respond(db.config),
    async putConfig(partial) {
      await delay();
      const fields = validateConfig(partial);
      if (Object.keys(fields).length) {
        throw new ApiError(422, { error: 'invalid_config', message: 'Einige Einstellungen sind ungültig.', fields });
      }
      db.config = { ...db.config, ...structuredClone(partial) };
      return structuredClone(db.config);
    },
    getCredentials: () => respond(db.credentials),
    async putCredentials(username, password) {
      await delay(300);
      const fields = {};
      if (!username?.trim()) fields.username = 'Bitte den Benutzernamen angeben.';
      if (!password) fields.password = 'Bitte das Passwort angeben.';
      if (Object.keys(fields).length) throw new ApiError(422, { error: 'invalid_credentials', message: 'Angaben unvollständig.', fields });
      const u = username.trim();
      db.credentials = { configured: true, username: u.length > 3 ? `${u.slice(0, 2)}***${u.slice(-1)}` : '***' };
      emitStatus();
      return structuredClone(db.credentials);
    },
    async deleteCredentials() {
      await delay();
      db.credentials = { configured: false, username: null };
      emitStatus();
      return structuredClone(db.credentials);
    },
    async checkSession() {
      await delay(900);
      const state = scenario === 'offline' ? 'offline' : db.session.state === 'expired' ? 'expired' : 'valid';
      if (state !== 'offline') db.session = { state, checked_at: isoLocal(new Date()) };
      emitStatus();
      return { state };
    },
    async login() {
      await delay();
      log('Öffne Anmeldefenster (Chromium) …');
      setTimeout(() => log('Warte auf Anmeldung bei ILIAS …'), 900 / speed);
      setTimeout(() => {
        db.session = { state: 'valid', checked_at: isoLocal(new Date()) };
        log('Anmeldung erfolgreich, Sitzung gespeichert.');
        emitStatus();
      }, 2600 / speed);
      return { started: true };
    },
    getSchedule: () => respond(db.schedule),
    async putSchedule(schedule) {
      await delay();
      if (schedule.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
        throw new ApiError(422, { error: 'invalid_schedule', message: 'Ungültige Uhrzeit.', fields: { time: 'Format HH:MM' } });
      }
      db.schedule = { ...db.schedule, ...schedule, supported: true };
      emitStatus();
      return structuredClone(db.schedule);
    },
    connectEvents(handlers) {
      listeners.add(handlers);
      handlers.onConnection?.('connecting');
      setTimeout(() => handlers.onConnection?.('open'), 60);
      return () => listeners.delete(handlers);
    },
  };

  if (scenario === 'running') setTimeout(() => api.startSync({ dryRun: false }), 300);
  return api;
}
