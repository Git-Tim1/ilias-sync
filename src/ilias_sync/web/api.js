// API-Client für das lokale Backend (siehe docs/API.md).
// Mit `?mock=1` wird stattdessen die simulierte API aus mock.js geladen.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Anfrage fehlgeschlagen (HTTP ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error ?? 'http_error';
    this.fields = body?.fields ?? null;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor(cause) {
    super('Keine Verbindung zur ILIAS-Sync-App. Läuft der Hintergrunddienst noch?');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (err) {
    throw new NetworkError(err);
  }
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

/**
 * Öffnet den SSE-Strom und verbindet sich bei Abbrüchen selbst neu.
 * @param {{onLog?, onStatus?, onRunFinished?, onConnection?: (state: 'connecting'|'open'|'closed') => void}} handlers
 * @returns {() => void} Schließt die Verbindung endgültig.
 */
function connectEventStream(url, handlers) {
  let source = null;
  let closed = false;
  let retryMs = 1000;
  let retryTimer = null;

  const parse = (ev) => {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  };

  const open = () => {
    if (closed) return;
    handlers.onConnection?.('connecting');
    source = new EventSource(url);
    source.addEventListener('open', () => {
      retryMs = 1000;
      handlers.onConnection?.('open');
    });
    source.addEventListener('log', (ev) => {
      const data = parse(ev);
      if (data && typeof data.line === 'string') handlers.onLog?.(data.line);
    });
    source.addEventListener('status', (ev) => {
      const data = parse(ev);
      if (data) handlers.onStatus?.(data);
    });
    source.addEventListener('run_finished', (ev) => {
      const data = parse(ev);
      if (data) handlers.onRunFinished?.(data);
    });
    source.addEventListener('error', () => {
      if (closed) return;
      // Der Browser verbindet sich bei CONNECTING selbst neu; bei CLOSED übernehmen wir.
      if (source.readyState === EventSource.CLOSED) {
        handlers.onConnection?.('closed');
        source.close();
        retryTimer = setTimeout(open, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      } else {
        handlers.onConnection?.('connecting');
      }
    });
  };

  open();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    source?.close();
  };
}

export function createHttpApi() {
  const get = (p) => request('GET', p);
  const post = (p, b = {}) => request('POST', p, b);
  const put = (p, b) => request('PUT', p, b);
  return {
    mock: false,
    getStatus: () => get('api/status'),
    // Weitere Optionen (course, semester, max_depth, overwrite, …) wie in docs/API.md (SyncOptions).
    startSync: ({ dryRun = false, ...options } = {}) => post('api/sync', { dry_run: dryRun, ...options }),
    cancelSync: () => post('api/sync/cancel'),
    getRuns: (limit = 20) => get(`api/runs?limit=${limit}`),
    getRecentFiles: (limit = 50) => get(`api/files/recent?limit=${limit}`),
    openFile: (path) => post('api/files/open', { path }),
    revealFile: (path) => post('api/files/reveal', { path }),
    openFolder: (which) => post('api/folders/open', { which }),
    getLogs: (lines = 200) => get(`api/logs?lines=${lines}`),
    getConfig: () => get('api/config'),
    getConfigDefaults: () => get('api/config/defaults'),
    getSetupSuggestions: () => get('api/setup/suggestions'),
    completeSetup: () => post('api/setup/complete'),
    resetSetup: () => post('api/setup/reset'),
    putConfig: (partial) => put('api/config', partial),
    getConfigYaml: () => get('api/config/yaml'),
    importConfig: (path) => post('api/config/import', { path }),
    getPaths: () => get('api/paths'),
    revealPath: (which) => post('api/paths/reveal', { which }),
    getShellCommand: () => get('api/shell-command'),
    installShellCommand: () => post('api/shell-command/install'),
    uninstallShellCommand: () => post('api/shell-command/uninstall'),
    getBrowser: () => get('api/browser'),
    installBrowser: () => post('api/browser/install'),
    getCredentials: () => get('api/credentials'),
    putCredentials: (username, password) => put('api/credentials', { username, password }),
    deleteCredentials: () => request('DELETE', 'api/credentials'),
    checkSession: () => post('api/session/check'),
    login: () => post('api/session/login'),
    getSchedule: () => get('api/schedule'),
    putSchedule: (schedule) => put('api/schedule', schedule),
    connectEvents: (handlers) => connectEventStream('api/events', handlers),
  };
}

export function isMockMode() {
  const params = new URLSearchParams(location.search);
  return params.get('mock') === '1' || params.get('mock') === 'true';
}

export async function createApi() {
  if (isMockMode()) {
    const { createMockApi } = await import('./mock.js');
    return createMockApi(new URLSearchParams(location.search));
  }
  return createHttpApi();
}

/** Deutscher Fehlertext für Toasts. */
export function errorMessage(err) {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return err?.message || 'Unbekannter Fehler.';
}
