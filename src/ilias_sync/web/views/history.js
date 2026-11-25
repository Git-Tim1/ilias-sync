// Verlauf: Liste der Läufe mit aufklappbaren Kursdetails.
import { h, button, fmtDayTime, fmtDateTime, fmtDuration, fmtNumber, fmtBytes, plural, runDurationSeconds, TRIGGER_LABEL, resultPill, resultMeta } from '../util.js';
import { icon, fileKind } from '../icons.js';

const FILTERS = [
  ['all', 'Alle'],
  ['problems', 'Nur Probleme'],
  ['new', 'Mit neuen Dateien'],
];

export function mount(root, ctx) {
  const { store, actions } = ctx;
  const cleanups = [];
  const expanded = new Set();
  let filter = 'all';

  const list = h('div', { class: 'run-list', 'aria-busy': 'true' });
  const caption = h('span', { class: 'card-caption', 'aria-live': 'polite' });
  const segmented = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': 'Läufe filtern' },
    FILTERS.map(([value, label]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: 'segment',
          'aria-checked': String(value === filter),
          dataset: { value },
          onclick: () => setFilter(value),
          onkeydown: (ev) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
            ev.preventDefault();
            const idx = FILTERS.findIndex(([v]) => v === filter);
            const next = FILTERS[(idx + (ev.key === 'ArrowRight' ? 1 : FILTERS.length - 1)) % FILTERS.length][0];
            setFilter(next);
            segmented.querySelector(`[data-value="${next}"]`).focus();
          },
          tabindex: value === filter ? '0' : '-1',
        },
        label,
      ),
    ),
  );
  const reload = button('Aktualisieren', { icon: 'sync', variant: 'ghost', size: 'sm', onclick: () => load() });

  root.append(
    h('header', { class: 'page-header' }, h('h1', {}, 'Verlauf'), h('div', { class: 'page-actions' }, reload)),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, segmented, caption), list),
  );

  function setFilter(value) {
    filter = value;
    for (const btn of segmented.children) {
      const on = btn.dataset.value === value;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    render();
  }

  function visibleRuns() {
    const runs = [...(store.runs ?? [])];
    const cur = store.status?.running ? store.status.current : null;
    if (cur && !runs.some((r) => r.run_id === cur.run_id)) runs.unshift(cur);
    return runs.filter((r) => {
      if (filter === 'problems') return !['success', 'running'].includes(r.result);
      if (filter === 'new') return (r.totals?.downloaded ?? 0) > 0;
      return true;
    });
  }

  function render() {
    if (!store.runs) return;
    list.removeAttribute('aria-busy');
    const runs = visibleRuns();
    caption.textContent = plural(runs.length, 'Lauf', 'Läufe');
    if (!runs.length) {
      list.replaceChildren(h('p', { class: 'empty' }, store.runs.length ? 'Keine Läufe für diesen Filter.' : 'Noch keine Läufe. Starte in der Übersicht die erste Synchronisierung.'));
      return;
    }
    list.replaceChildren(...runs.map(renderRun));
  }

  function renderRun(run) {
    const t = run.totals ?? {};
    const meta = resultMeta(run.result);
    const details = h('details', { class: 'run', dataset: { tone: meta.tone, runId: run.run_id } });
    details.open = expanded.has(run.run_id);
    details.addEventListener('toggle', () => {
      if (details.open) expanded.add(run.run_id);
      else expanded.delete(run.run_id);
    });
    const duration = run.result === 'running' ? 'läuft …' : fmtDuration(runDurationSeconds(run));
    const summary = h(
      'summary',
      { class: 'run-summary' },
      h('span', { class: 'run-chevron' }, icon('chevronRight', { size: 14 })),
      h('span', { class: 'run-result' }, resultPill(run.result)),
      h(
        'span',
        { class: 'run-when' },
        h('time', { datetime: run.started_at, title: fmtDateTime(run.started_at) }, fmtDayTime(run.started_at)),
        h(
          'span',
          { class: 'run-tags' },
          h('span', { class: 'tag' }, TRIGGER_LABEL[run.trigger] ?? run.trigger),
          run.dry_run ? h('span', { class: 'tag tag-accent' }, 'Probelauf') : null,
        ),
      ),
      h('span', { class: 'run-duration tabular', title: 'Dauer' }, icon('clock', { size: 13 }), duration),
      h(
        'span',
        { class: 'run-counts' },
        h('span', { class: `count${t.downloaded ? ' count-new' : ''}` }, h('b', { class: 'tabular' }, fmtNumber(t.downloaded ?? 0)), ' neu'),
        h('span', { class: 'count' }, h('b', { class: 'tabular' }, fmtNumber(t.skipped ?? 0)), ' vorhanden'),
        h('span', { class: `count${t.errors ? ' count-error' : ' muted'}` }, h('b', { class: 'tabular' }, fmtNumber(t.errors ?? 0)), ' Fehler'),
      ),
    );
    details.append(summary, renderDetails(run));
    return details;
  }

  function renderDetails(run) {
    const body = h('div', { class: 'run-body' });
    if (run.message) {
      body.append(h('p', { class: `run-message tone-${resultMeta(run.result).tone}` }, icon(resultMeta(run.result).icon, { size: 15 }), h('span', {}, run.message)));
    }
    const facts = h(
      'dl',
      { class: 'facts' },
      h('div', {}, h('dt', {}, 'Gestartet'), h('dd', {}, fmtDateTime(run.started_at))),
      h('div', {}, h('dt', {}, 'Beendet'), h('dd', {}, run.finished_at ? fmtDateTime(run.finished_at) : '–')),
      h('div', {}, h('dt', {}, 'Semester'), h('dd', {}, run.semester ?? '–')),
      h('div', {}, h('dt', {}, 'Gefunden'), h('dd', { class: 'tabular' }, fmtNumber(run.totals?.found ?? 0))),
    );
    body.append(facts);

    if (run.courses?.length) {
      const table = h(
        'table',
        { class: 'table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', { scope: 'col' }, 'Kurs'), ...['Gefunden', 'Neu', 'Vorhanden', 'Fehler'].map((l) => h('th', { scope: 'col', class: 'num' }, l))),
        ),
        h(
          'tbody',
          {},
          run.courses.map((c) => [
            h(
              'tr',
              { class: c.errors ? 'has-error' : '' },
              h(
                'td',
                {},
                c.url
                  ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: `${c.name} in ILIAS öffnen` }, c.short_name || c.name)
                  : c.short_name || c.name,
              ),
              h('td', { class: 'num tabular' }, fmtNumber(c.found)),
              h('td', { class: `num tabular${c.downloaded ? ' count-new' : ''}` }, fmtNumber(c.downloaded)),
              h('td', { class: 'num tabular' }, fmtNumber(c.skipped)),
              h('td', { class: `num tabular${c.errors ? ' count-error' : ''}` }, fmtNumber(c.errors)),
            ),
            c.error_message
              ? h('tr', { class: 'error-row' }, h('td', { colspan: '5' }, icon('warning', { size: 13 }), ' ', c.error_message))
              : null,
          ]),
        ),
      );
      body.append(h('div', { class: 'table-wrap' }, table));
    } else if (run.result !== 'running') {
      body.append(h('p', { class: 'muted small' }, 'In diesem Lauf wurden keine Kurse verarbeitet.'));
    }

    if (run.new_files?.length) {
      body.append(
        h('h3', { class: 'subhead' }, `Neue Dateien (${fmtNumber(run.new_files.length)})`),
        h(
          'ul',
          { class: 'mini-files' },
          run.new_files.map((f) => {
            const k = fileKind(f.name);
            return h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'link-button', onclick: () => actions.openFile(f.path), title: 'Datei öffnen' },
                h('span', { class: `file-icon sm kind-${k.kind}` }, icon(k.icon, { size: 15 })),
                h('span', { class: 'mini-name' }, f.name),
              ),
              h('span', { class: 'muted small' }, [f.course, f.folder].filter(Boolean).join(' · '), ' · ', fmtBytes(f.size)),
            );
          }),
        ),
      );
    }
    return body;
  }

  async function load() {
    try {
      await ctx.refreshRuns(50);
    } catch (err) {
      list.replaceChildren(h('p', { class: 'empty' }, `Verlauf konnte nicht geladen werden: ${err.message}`));
    }
  }

  cleanups.push(
    store.on('runs', render),
    store.on('status', () => {
      const cur = store.status?.running ? store.status.current : null;
      if (!cur || !store.runs) return;
      // Nur die Zeile des laufenden Laufs ersetzen, Rest (inkl. Fokus) bleibt stehen.
      const existing = [...list.querySelectorAll('details.run')].find((d) => d.dataset.runId === cur.run_id);
      if (existing) existing.replaceWith(renderRun(cur));
      else render();
    }),
  );
  render();
  load();
  return { unmount: () => cleanups.forEach((fn) => fn()) };
}
