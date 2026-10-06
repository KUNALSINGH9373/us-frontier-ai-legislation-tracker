// Explore views built from data: lifecycle lanes (Timeline), relationship network (Relationships) and the
// sortable table with CSV export (Table). Each function returns a React element for the page to embed.
// Nothing here is hardcoded to an entry: it reads events.json, relationships.json and entries.json via the data model.
const h = (...a) => React.createElement(...a);

/* ---------- shared ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 864e5;
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };

/* ---------- lifecycle lanes ---------- */
// The tracker's eight event types, folded into six kinds a reader can learn at a glance. Shape + colour, never colour alone.
export const EV_KINDS = {
  introduced: { l: 'Introduced or published', g: '●', c: 'var(--accent)' },
  process: { l: 'Vote, committee or referral', g: '◆', c: 'var(--st-pending)' },
  law: { l: 'Signed or in effect', g: '■', c: 'var(--st-enacted)' },
  ended: { l: 'Vetoed, failed or withdrawn', g: '✕', c: 'var(--st-failed)' },
  litigation: { l: 'Court action', g: '▲', c: 'var(--st-litigation)' },
  check: { l: 'Search stamp or deadline', g: '◇', c: 'var(--st-stalled)' }
};
export const EV_ORDER = ['introduced', 'process', 'law', 'ended', 'litigation', 'check'];
const KIND_OF = {
  'Introduced / published': 'introduced', 'Passed / advanced': 'process', 'Referred / stalled / hearing': 'process',
  'Signed / enacted': 'law', 'Effective': 'law', 'Vetoed / failed / rescinded': 'ended', 'Litigation': 'litigation',
  'Search date / deadline / scheduled': 'check'
};
export const kindOf = (e) => KIND_OF[e.type] || 'check';
export const RANGES = {
  recent: { l: '2025–2026', from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 11, 31) },
  y26: { l: '2026', from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 11, 31) },
  next: { l: 'Coming up', from: null, to: Date.UTC(2029, 11, 31) },
  all: { l: 'All dates', from: Date.UTC(2023, 0, 1), to: Date.UTC(2029, 11, 31) }
};

function marker(kind, cx, cy, future, key) {
  const k = EV_KINDS[kind], r = kind === 'check' ? 4 : 6;
  const st = future ? { fill: 'var(--bg)', stroke: k.c, strokeWidth: 2 } : { fill: k.c, stroke: 'var(--bg)', strokeWidth: 1.5 };
  if (kind === 'introduced') return h('circle', { key, cx, cy, r, style: st });
  if (kind === 'law') return h('rect', { key, x: cx - r + 0.5, y: cy - r + 0.5, width: 2 * r - 1, height: 2 * r - 1, rx: 1.5, style: st });
  if (kind === 'process') return h('path', { key, d: `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy}L${cx} ${cy + r + 1}L${cx - r - 1} ${cy}Z`, style: st });
  if (kind === 'litigation') return h('path', { key, d: `M${cx} ${cy - r - 1}L${cx + r + 1} ${cy + r}L${cx - r - 1} ${cy + r}Z`, style: st });
  if (kind === 'ended') return h('path', { key, d: `M${cx - r} ${cy - r}L${cx + r} ${cy + r}M${cx + r} ${cy - r}L${cx - r} ${cy + r}`, style: { fill: 'none', stroke: k.c, strokeWidth: 2.6, strokeLinecap: 'round' } });
  return h('circle', { key, cx, cy, r, style: { fill: 'none', stroke: k.c, strokeWidth: 1.8 } });
}

// ctx: { L, D, ids:Set, range, kindOff:[], sel:key, select(key), setRange(k), toggleKind(k), mob }
export function lanes(ctx) {
  const { L, D } = ctx, ASOF = +L.ASOF;
  const R = RANGES[ctx.range] || RANGES.recent;
  const from = R.from == null ? ASOF - 14 * DAY : R.from, to = R.to;
  const off = new Set(ctx.kindOff);
  const all = D.tev.filter((e) => ctx.ids.has(e.id));
  const inRange = all.filter((e) => +e.d >= from && +e.d <= to);
  const shown = inRange.filter((e) => !off.has(kindOf(e)));
  const byId = new Map();
  shown.forEach((e) => { (byId.get(e.id) || byId.set(e.id, []).get(e.id)).push(e); });
  const order = Object.keys(L.SEC);
  const groups = order.map((s) => ({ s, name: L.SEC[s], ids: [...byId.keys()].filter((id) => D.byId[id].section === s) })).filter((g) => g.ids.length);
  groups.forEach((g) => g.ids.sort((a, b) => Math.max(...byId.get(b).map((e) => +e.d)) - Math.max(...byId.get(a).map((e) => +e.d))));

  const W = 1000, LW = ctx.mob ? 150 : 232, PR = 22, ROW = 30, BAND = 32, TOP = 56, BOT = 12;
  let H = TOP + BOT; groups.forEach((g) => { H += BAND + g.ids.length * ROW; });
  const x = (t) => LW + ((t - from) / (to - from)) * (W - LW - PR);
  const els = [];

  // axis + grid
  const spanM = (to - from) / (30.4 * DAY), step = spanM <= 14 ? 1 : spanM <= 40 ? 3 : spanM <= 80 ? 6 : 12;
  const d0 = new Date(from); let cur = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1);
  for (; cur <= to; ) {
    const dt = new Date(cur), isJan = dt.getUTCMonth() === 0;
    if (cur >= from && (dt.getUTCMonth() % step === 0)) {
      els.push(h('line', { key: 'g' + cur, x1: x(cur), x2: x(cur), y1: TOP - 10, y2: H - BOT, style: { stroke: isJan ? 'var(--line-2)' : 'var(--line)', strokeWidth: 1 } }));
      els.push(h('text', { key: 'a' + cur, x: x(cur) + 4, y: TOP - 16, style: { fill: isJan ? 'var(--ink)' : 'var(--ink-3)', fontSize: 11.5, fontWeight: isJan ? 800 : 600 } }, isJan ? String(dt.getUTCFullYear()) : MONTHS[dt.getUTCMonth()]));
    }
    cur = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
  }
  // rows
  let y = TOP; const lbl = [];
  groups.forEach((g) => {
    els.push(h('g', { key: 'b' + g.s },
      h('rect', { x: 0, y: y + 3, width: W, height: BAND - 6, rx: 8, style: { fill: 'var(--surface-2)' } }),
      h('text', { x: 12, y: y + BAND / 2 + 4.5, style: { fill: 'var(--ink)', fontSize: 13, fontWeight: 800 } }, g.name),
      h('text', { x: W - 12, y: y + BAND / 2 + 4.5, textAnchor: 'end', style: { fill: 'var(--ink-3)', fontSize: 11.5, fontWeight: 650 } }, g.ids.length + (g.ids.length === 1 ? ' entry' : ' entries'))));
    lbl.push({ band: true, y, name: g.name });
    y += BAND;
    g.ids.forEach((id, i) => {
      const x0 = D.byId[id], evs = byId.get(id).slice().sort((a, b) => a.d - b.d), cy = y + ROW / 2;
      const tag = x0.st && !new RegExp('^' + x0.st + '\\b').test(x0.short) ? x0.st + ' · ' : '';
      const sel = ctx.sel && ctx.sel.startsWith(id + '|');
      lbl.push({ y, cy, i, id, x0, tag, sel });
      els.push(h('g', { key: 'r' + id },
        sel ? h('rect', { x: 0, y, width: W, height: ROW, style: { fill: 'var(--accent-soft)' } }) : (i % 2 ? h('rect', { x: 0, y, width: W, height: ROW, style: { fill: 'var(--b-fill)' } }) : null),
        h('a', { href: '#/bill/' + id },
          h('title', null, x0.title),
          h('text', { x: LW - 12, y: cy + 4.5, textAnchor: 'end', style: { fill: 'var(--ink)', fontSize: 12.5, fontWeight: 650, cursor: 'pointer' } },
            h('tspan', { style: { fill: 'var(--ink-3)', fontWeight: 600, fontSize: 11 } }, tag), trunc(x0.short, ctx.mob ? (tag ? 14 : 19) : (tag ? 25 : 31)))),
        evs.length > 1 ? h('line', { x1: Math.max(x(+evs[0].d), LW), x2: Math.min(x(+evs[evs.length - 1].d), W - PR), y1: cy, y2: cy, style: { stroke: 'var(--line-2)', strokeWidth: 2.2, strokeLinecap: 'round' } }) : null,
        ...evs.map((e) => {
          const kd = kindOf(e), key = e.id + '|' + e.date + '|' + e.type + '|' + e.column, future = +e.d > ASOF, on = ctx.sel === key;
          const act = () => ctx.select(key);
          return h('g', {
            key, tabIndex: 0, role: 'button', 'aria-pressed': on, 'aria-label': `${L.fmt(e.d)}, ${EV_KINDS[kd].l}${future ? ', scheduled' : ''}: ${x0.short}`,
            onClick: act, onFocus: act, onMouseEnter: act, onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); } },
            style: { cursor: 'pointer', outline: 'none', opacity: e.precision === 'month' ? 0.7 : 1 }
          },
            h('circle', { cx: x(+e.d), cy, r: 13, style: { fill: 'transparent' } }),
            on ? h('circle', { cx: x(+e.d), cy, r: 11, style: { fill: 'none', stroke: 'var(--ink)', strokeWidth: 2 } }) : null,
            marker(kd, x(+e.d), cy, future, 'm'));
        })));
      y += ROW;
    });
  });
  // data-as-of line
  const asofX = ASOF >= from && ASOF <= to ? x(ASOF) : null;
  const asofEl = asofX == null ? null : h('g', { key: 'asof', style: { pointerEvents: 'none' } },
    h('line', { x1: asofX, x2: asofX, y1: TOP - 10, y2: H - BOT, style: { stroke: 'var(--ink)', strokeWidth: 1.6, strokeDasharray: '5 4' } }),
    h('rect', { x: Math.min(asofX - 52, W - 108), y: TOP - 52, width: 104, height: 18, rx: 9, style: { fill: 'var(--ink)' } }),
    h('text', { x: Math.min(asofX, W - 56), y: TOP - 39.5, textAnchor: 'middle', style: { fill: 'var(--bg)', fontSize: 10.5, fontWeight: 800 } }, 'Data as of ' + L.fmt(L.ASOF).replace(/ 20(\d\d)$/, ' ’$1')));

  const labelText = (r, anchorX) => h('a', { href: '#/bill/' + r.id, tabIndex: -1 },
    h('title', null, r.x0.title),
    h('text', { x: anchorX, y: r.cy + 4.5, textAnchor: 'end', style: { fill: 'var(--ink)', fontSize: 12.5, fontWeight: 650, cursor: 'pointer' } },
      h('tspan', { style: { fill: 'var(--ink-3)', fontWeight: 600, fontSize: 11 } }, r.tag), trunc(r.x0.short, ctx.mob ? (r.tag ? 14 : 19) : (r.tag ? 25 : 31))));
  const overlay = h('svg', { key: 'ov', width: LW, height: H, viewBox: `0 0 ${LW} ${H}`, 'aria-hidden': true, style: { position: 'sticky', left: 0, zIndex: 3, display: 'block', flex: 'none', background: 'var(--surface)', borderRight: '1px solid var(--line)', fontFamily: 'inherit' } },
    h('rect', { x: 0, y: 0, width: LW, height: H, style: { fill: 'var(--surface)' } }),
    ...lbl.map((r, k) => r.band
      ? h('g', { key: k }, h('rect', { x: 0, y: r.y + 3, width: LW, height: BAND - 6, style: { fill: 'var(--surface-2)' } }), h('text', { x: 10, y: r.y + BAND / 2 + 4.5, style: { fill: 'var(--ink)', fontSize: 11.5, fontWeight: 800 } }, trunc(r.name, 20)))
      : h('g', { key: k }, r.sel ? h('rect', { x: 0, y: r.y, width: LW, height: ROW, style: { fill: 'var(--accent-soft)' } }) : (r.i % 2 ? h('rect', { x: 0, y: r.y, width: LW, height: ROW, style: { fill: 'var(--b-fill)' } }) : null), labelText(r, LW - 10))));
  const nEntries = byId.size, nLaw = new Set(shown.filter((e) => kindOf(e) === 'law' && +e.d <= ASOF).map((e) => e.id)).size;
  const nSched = shown.filter((e) => +e.d > ASOF).length, outside = all.filter((e) => !off.has(kindOf(e)) && (+e.d < from || +e.d > to)).length;
  const counts = {}; inRange.forEach((e) => { const k = kindOf(e); counts[k] = (counts[k] || 0) + 1; });
  const selEv = ctx.sel ? D.tev.find((e) => e.id + '|' + e.date + '|' + e.type + '|' + e.column === ctx.sel) : null;

  const pill = (on) => ({ height: 44, padding: '0 14px', borderRadius: 999, border: '1px solid ' + (on ? 'var(--ink)' : 'var(--line-2)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? 'var(--bg)' : 'var(--ink)', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' });
  const stat = (n, l) => h('div', { style: { display: 'flex', flexDirection: 'column' } }, h('strong', { style: { fontSize: 26, letterSpacing: '-.02em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' } }, n), h('span', { style: { fontSize: 13, color: 'var(--ink-3)', fontWeight: 650 } }, l));

  return h('div', null,
    h('div', { role: 'group', 'aria-label': 'Time range', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...Object.keys(RANGES).map((k) => h('button', { key: k, onClick: () => ctx.setRange(k), 'aria-pressed': ctx.range === k, style: pill(ctx.range === k) }, RANGES[k].l))),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '14px 32px', padding: '16px 20px', borderRadius: 18, background: 'var(--surface)', border: '1px solid var(--line)', marginBottom: 14 } },
      stat(shown.length, 'events shown'), stat(nEntries, 'entries'), stat(nLaw, 'became or are law'), stat(nSched, 'scheduled ahead'),
      outside ? h('span', { style: { alignSelf: 'center', fontSize: 13.5, color: 'var(--ink-3)', fontWeight: 600 } }, outside + (outside === 1 ? ' event' : ' events') + ' outside this range') : null),
    h('div', { role: 'group', 'aria-label': 'Event kinds', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...EV_ORDER.map((k) => { const on = !off.has(k); return h('button', { key: k, onClick: () => ctx.toggleKind(k), 'aria-pressed': on, style: { ...pill(false), height: 44, padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, opacity: on ? 1 : 0.5, background: 'var(--surface)', color: 'var(--ink)', borderColor: on ? 'var(--line-2)' : 'var(--line)' } },
        h('span', { 'aria-hidden': true, style: { color: EV_KINDS[k].c, fontSize: 15, width: 16, textAlign: 'center' } }, EV_KINDS[k].g), EV_KINDS[k].l, h('span', { style: { color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' } }, counts[k] || 0)); })),
    h('p', { style: { margin: '0 0 12px', fontSize: 14, color: 'var(--ink-3)' } }, 'One row per entry, newest activity first. Hollow marks are scheduled dates after the data cut-off. Tap or focus a mark to read the tracker’s own sentence.'),
    shown.length === 0 ? h('div', { role: 'status', style: { padding: 32, borderRadius: 20, border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No dated events match these filters and this range.') :
      h('div', { tabIndex: -1, ref: (el) => { if (el && el.dataset.rng !== ctx.range + (ctx.mob ? 'm' : 'd')) { el.dataset.rng = ctx.range + (ctx.mob ? 'm' : 'd'); if (asofX != null && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, asofX - (LW + (el.clientWidth - LW) * 0.7)); else el.scrollLeft = 0; } }, style: { overflowX: 'auto', borderRadius: 18, border: '1px solid var(--line)', background: 'var(--surface)' } },
        h('div', { style: { display: 'flex', width: W } }, overlay,
          h('svg', { viewBox: `${LW} 0 ${W - LW} ${H}`, role: 'group', 'aria-label': `Lifecycle chart: ${nEntries} entries, ${shown.length} dated events`, style: { display: 'block', width: W - LW, height: 'auto', fontFamily: 'inherit' } }, ...els, asofEl))),
    h('div', { 'aria-live': 'polite', style: { position: 'sticky', bottom: ctx.mob ? 84 : 14, zIndex: 5, marginTop: 14 } },
      selEv ? (() => { const e = selEv, x0 = D.byId[e.id], kd = kindOf(e), fut = +e.d > ASOF; return h('div', { style: { padding: '14px 16px', borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line-2)', boxShadow: 'var(--shadow-2)', display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 13.5, fontWeight: 700, color: 'var(--ink-3)' } },
          h('span', { 'aria-hidden': true, style: { color: EV_KINDS[kd].c, fontSize: 16 } }, EV_KINDS[kd].g), h('span', { style: { color: 'var(--ink)' } }, EV_KINDS[kd].l),
          h('span', null, (e.precision === 'month' ? L.fmtMonth(e.d) : L.fmt(e.d))), fut ? h('span', { style: { padding: '1px 8px', borderRadius: 999, border: '1px dashed var(--st-pending)', color: 'var(--ink)', fontSize: 12, fontWeight: 800 } }, 'Scheduled') : null,
          e.inferredYear ? h('span', { style: { fontWeight: 600 } }, '· year read from the same cell') : null, e.precision === 'month' ? h('span', { style: { fontWeight: 600 } }, '· month only') : null),
        h('a', { href: '#/bill/' + e.id, style: { fontSize: 16.5, fontWeight: 750, color: 'var(--ink)', textDecoration: 'none' } }, x0.short),
        h('blockquote', { style: { margin: 0, paddingLeft: 10, borderLeft: '2px solid var(--line-2)', fontSize: 14.5, color: 'var(--ink-2)' } }, '“' + e.clause.replace(/\\([\\[\]*_|])/g, '$1') + '”'),
        h('span', { style: { fontSize: 12.5, color: 'var(--ink-3)' } }, 'From the tracker’s “' + e.column + '” column. Event kind is read from the wording and may need a check.'));
      })() : h('div', { style: { padding: '12px 16px', borderRadius: 16, background: 'var(--surface-2)', color: 'var(--ink-3)', fontSize: 14 } }, 'Select a mark to see what happened and the exact sentence it was read from.')));
}

/* ---------- relationship network ---------- */
export const LENSES = {
  family: { l: 'Who copied whom', d: 'Drafting families, replacements and amendments.', types: ['template', 'succession'], start: 'SB53' },
  fedstate: { l: 'Washington vs. the states', d: 'Federal pressure, executive orders and lawsuits.', types: ['fedstate', 'executive', 'litigation'], start: null },
  assurance: { l: 'Who checks the checkers', d: 'Auditor and verifier laws and what they build on.', types: ['assurance'], start: 'SB813' },
  people: { l: 'Sponsors and backers', d: 'Who sponsors, supports and opposes.', types: ['actor'], start: null },
  all: { l: 'Everything', d: 'Every relationship the tracker states.', types: null, start: 'SB53' }
};
export const TYPE_COLOR = { template: 'var(--accent)', succession: 'var(--st-pending)', fedstate: 'var(--st-enacted)', executive: 'var(--st-executive)', litigation: 'var(--st-litigation)', assurance: 'var(--st-auditor)', actor: 'var(--st-stalled)' };

// Edges of a lens (after the type toggles), and the best starting points: most-linked items first.
export function lensGraph(D, lensK, off) {
  const lens = LENSES[lensK] || LENSES.family, offs = new Set(off || []);
  const edges = D.edges.filter((e) => (!lens.types || lens.types.includes(e.type)) && !offs.has(e.type));
  const deg = {}; edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  const hubs = Object.keys(deg).sort((a, b) => deg[b] - deg[a]);
  return { lens, edges, deg, hubs };
}
export const netFocus = (D, lensK, off, c) => { const g = lensGraph(D, lensK, off); return c && g.deg[c] ? c : (g.lens.start && g.deg[g.lens.start] ? g.lens.start : g.hubs[0] || c); };

// ctx: { L, D, lens, scope:'near'|'all', off:[], focus:key, hover:key, select(key), hoverSet(key|null), setLens(k), setScope(s), toggleType(t) }
export function network(ctx) {
  const { D } = ctx, R = D.rel, lens = LENSES[ctx.lens] || LENSES.family, off = new Set(ctx.off);
  const nameOf = (k) => R.actors[k] || R.short[k] || k;
  const types = Object.keys(R.types).filter((t) => (!lens.types || lens.types.includes(t)) && !off.has(t));
  const G = lensGraph(D, ctx.lens, ctx.off), whole = ctx.lens === 'all' || ctx.scope === 'all';
  const near = new Set([ctx.focus]); G.edges.forEach((e) => { if (e.from === ctx.focus || e.to === ctx.focus) { near.add(e.from); near.add(e.to); } });
  const edges = whole ? G.edges : G.edges.filter((e) => near.has(e.from) && near.has(e.to));
  const keys = new Set(); edges.forEach((e) => { keys.add(e.from); keys.add(e.to); });
  const info = (k) => { const id = D.keyToId[k], x = id ? D.byId[id] : null; return { k, name: nameOf(k), col: R.columnOf[k] != null ? R.columnOf[k] : 0, x, sub: x ? (x.st ? x.st + ' · ' : x.juris + ' · ') + ctx.L.ST[x.status].l : 'Person or group' }; };
  const nodes = [...keys].map(info);
  const colIdx = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
  const cols = colIdx.map((c) => nodes.filter((n) => n.col === c));
  const pos = {}; cols.forEach((c) => c.forEach((n, i) => { pos[n.k] = i; }));
  const nb = {}; edges.forEach((e) => { (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); });
  for (let it = 0; it < 6; it++) cols.forEach((c) => { c.forEach((n) => { const ns = (nb[n.k] || []).filter((k) => pos[k] != null); n.b = ns.length ? ns.reduce((s, k) => s + pos[k], 0) / ns.length : pos[n.k]; }); c.sort((a, b) => a.b - b.b); c.forEach((n, i) => { pos[n.k] = i; }); });

  const NH = 40, VG = 12, PAD = 20, HEAD = 34, bigView = ctx.lens === 'all' || ctx.scope === 'all', nc = Math.max(1, cols.length);
  // Fit the available width: shrink the gaps first, then the boxes; only the dense views fall back to sideways scrolling.
  let NW = 184, GAP = bigView ? 96 : 118;
  if (!bigView && ctx.avail && nc > 1) {
    const need = () => PAD * 2 + nc * NW + (nc - 1) * GAP;
    if (need() > ctx.avail) GAP = Math.max(44, GAP - (need() - ctx.avail) / (nc - 1));
    if (need() > ctx.avail) NW = Math.max(124, NW - (need() - ctx.avail) / nc);
  }
  const nameN = Math.max(14, Math.floor(NW / 7.4)), subN = Math.max(18, Math.floor(NW / 6));
  const tallest = Math.max(1, ...cols.map((c) => c.length));
  const W = PAD * 2 + cols.length * NW + Math.max(0, cols.length - 1) * GAP, H = HEAD + PAD + tallest * (NH + VG);
  // vertically centre each column
  const P = {}; cols.forEach((c, ci) => { const off0 = ((tallest - c.length) * (NH + VG)) / 2; c.forEach((n, i) => { P[n.k] = { x: PAD + ci * (NW + GAP), y: HEAD + off0 + i * (NH + VG), ci }; }); });

  const focus = ctx.hover || ctx.focus, fk = focus && P[focus] ? focus : null;
  const touch = (e) => fk && (e.from === fk || e.to === fk);
  const lit = new Set(fk ? [fk] : []); if (fk) edges.forEach((e) => { if (touch(e)) { lit.add(e.from); lit.add(e.to); } });

  const paths = edges.map((e, i) => {
    const a = P[e.from], b = P[e.to]; let d;
    if (a.ci === b.ci) { const xr = a.x + NW, y1 = a.y + NH / 2, y2 = b.y + NH / 2, bow = 38 + Math.min(40, Math.abs(y2 - y1) / 6); d = `M${xr} ${y1}C${xr + bow} ${y1} ${xr + bow} ${y2} ${xr + 2} ${y2}`; }
    else { const fwd = a.ci < b.ci, p = fwd ? a : b, q = fwd ? b : a, x1 = p.x + NW, x2 = q.x - 3, y1 = (fwd ? a : b).y + NH / 2, y2 = (fwd ? b : a).y + NH / 2, m = (x2 - x1) / 2; d = `M${x1} ${y1}C${x1 + m} ${y1} ${x2 - m} ${y2} ${x2} ${y2}`; if (!fwd) d = `M${a.x - 3} ${a.y + NH / 2}C${a.x - m} ${a.y + NH / 2} ${b.x + NW + m} ${b.y + NH / 2} ${b.x + NW} ${b.y + NH / 2}`; }
    const hot = fk && touch(e), dim = fk && !hot;
    return h('path', { key: 'e' + i, d, fill: 'none', markerEnd: `url(#arr-${e.type})`, style: { stroke: TYPE_COLOR[e.type], strokeWidth: hot ? 2.8 : 1.6, strokeDasharray: e.dashed ? '6 5' : undefined, opacity: dim ? 0.07 : hot ? 1 : 0.55, transition: 'opacity .18s' } });
  });
  const nodeEls = nodes.map((n) => {
    const p = P[n.k], dim = fk && !lit.has(n.k), on = n.k === ctx.focus, act = () => ctx.select(n.k);
    const col = n.x ? `var(--st-${n.x.status})` : 'var(--ink-3)';
    return h('g', {
      key: n.k, tabIndex: 0, role: 'button', 'aria-pressed': on, 'aria-label': `${n.name}. ${n.sub}. Show its links.`,
      onClick: act, onFocus: () => ctx.hoverSet(n.k), onBlur: () => ctx.hoverSet(null), onMouseEnter: () => ctx.hoverSet(n.k), onMouseLeave: () => ctx.hoverSet(null),
      onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act(); } },
      style: { cursor: 'pointer', outline: 'none', opacity: dim ? 0.3 : 1, transition: 'opacity .18s' }
    },
      h('rect', { x: p.x, y: p.y, width: NW, height: NH, rx: n.x ? 10 : 20, style: { fill: 'var(--surface)', stroke: on ? 'var(--ink)' : 'var(--line-2)', strokeWidth: on ? 2.4 : 1.2, strokeDasharray: n.x ? undefined : '3 3' } }),
      n.x ? h('rect', { x: p.x, y: p.y + 6, width: 4, height: NH - 12, rx: 2, style: { fill: col } }) : null,
      h('text', { x: p.x + 14, y: p.y + 17, style: { fill: 'var(--ink)', fontSize: 12.5, fontWeight: 750 } }, h('title', null, n.name + ' · ' + n.sub), trunc(n.name, nameN)),
      h('text', { x: p.x + 14, y: p.y + 31, style: { fill: 'var(--ink-3)', fontSize: 10.5, fontWeight: 600 } }, n.x ? h('tspan', { style: { fill: col } }, ctx.L.ST[n.x.status].g + ' ') : null, trunc(n.sub, subN)));
  });
  const heads = cols.map((c, ci) => h('text', { key: 'h' + ci, x: PAD + ci * (NW + GAP), y: 20, style: { fill: 'var(--ink-3)', fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' } }, trunc(R.columns[colIdx[ci]] || '', Math.max(10, Math.floor((NW + GAP - 16) / 7.6)))));
  const defs = h('defs', null, ...Object.keys(R.types).map((t) => h('marker', { key: t, id: 'arr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, h('path', { d: 'M0 1L9 5L0 9Z', style: { fill: TYPE_COLOR[t] } }))));

  const pill = (on) => ({ minHeight: 44, padding: '0 16px', borderRadius: 999, border: '1px solid ' + (on ? 'var(--ink)' : 'var(--line-2)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? 'var(--bg)' : 'var(--ink)', fontWeight: 700, fontSize: 14.5, cursor: 'pointer', fontFamily: 'inherit' });
  const big = ctx.lens === 'all' || ctx.scope === 'all';
  return h('div', null,
    h('div', { role: 'group', 'aria-label': 'Relationship views', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
      ...Object.keys(LENSES).map((k) => h('button', { key: k, onClick: () => ctx.setLens(k), 'aria-pressed': ctx.lens === k, style: pill(ctx.lens === k) }, LENSES[k].l))),
    h('p', { style: { margin: '0 0 12px', fontSize: 15, color: 'var(--ink-2)' } }, h('strong', { style: { color: 'var(--ink)' } }, lens.d + ' '), `${nodes.length} items, ${edges.length} links. Tap a box to follow its links.`),
    ctx.lens === 'all' ? null : h('div', { role: 'group', 'aria-label': 'Start from', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 } },
      h('span', { style: { fontSize: 12.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 4 } }, 'Start from'),
      ...G.hubs.slice(0, 6).map((k) => h('button', { key: k, onClick: () => ctx.select(k), 'aria-pressed': k === ctx.focus, style: { minHeight: 44, padding: '0 14px', borderRadius: 999, border: '1px solid ' + (k === ctx.focus ? 'var(--accent)' : 'var(--line-2)'), background: k === ctx.focus ? 'var(--accent-soft)' : 'var(--surface)', color: 'var(--ink)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' } }, trunc(nameOf(k), 26))),
      h('button', { onClick: () => ctx.setScope(ctx.scope === 'all' ? 'near' : 'all'), 'aria-pressed': ctx.scope === 'all', style: { minHeight: 44, padding: '0 14px', borderRadius: 999, border: '1px dashed var(--line-2)', background: ctx.scope === 'all' ? 'var(--ink)' : 'transparent', color: ctx.scope === 'all' ? 'var(--bg)' : 'var(--ink-2)', fontWeight: 700, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit' } }, ctx.scope === 'all' ? 'Show only this item’s links' : 'Show the whole group')),
    h('div', { role: 'group', 'aria-label': 'Link types', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...Object.keys(R.types).filter((t) => !lens.types || lens.types.includes(t)).map((t) => { const on = !off.has(t); return h('button', { key: t, onClick: () => ctx.toggleType(t), 'aria-pressed': on, style: { minHeight: 44, padding: '0 12px', borderRadius: 999, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontWeight: 650, fontSize: 13.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: on ? 1 : 0.5, fontFamily: 'inherit' } },
        h('span', { 'aria-hidden': true, style: { width: 22, height: 3, borderRadius: 2, background: TYPE_COLOR[t] } }), R.types[t].name); })),
    nodes.length === 0 ? h('div', { role: 'status', style: { padding: 32, borderRadius: 20, border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No links to show. Turn a link type back on.') :
      h('div', { style: { overflow: 'auto', maxHeight: big ? 760 : 'none', borderRadius: 18, border: '1px solid var(--line)', background: 'var(--surface)' } },
        h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `Relationship network: ${nodes.length} items and ${edges.length} links`, style: { display: 'block', width: '100%', maxWidth: big ? 'none' : W * 1.05, minWidth: big ? 1500 : W, height: 'auto', fontFamily: 'inherit' } }, defs, ...heads, ...paths, ...nodeEls)),
    ctx.avail && W > ctx.avail && !big ? h('p', { style: { margin: '8px 0 0', fontSize: 13, fontWeight: 700, color: 'var(--ink-2)' } }, '↔ Scroll sideways to see every column.') : null,
    h('p', { style: { margin: '10px 0 0', fontSize: 13, color: 'var(--ink-3)' } }, 'Arrows point from the earlier or acting item to the later or affected one. Dashed lines are links the tracker itself marks as unproven. Dashed boxes are people and groups.'));
}

/* ---------- table + CSV ---------- */
export const TABLE_COLS = [
  { k: 'title', l: 'Entry', v: (x) => x.short.toLowerCase() },
  { k: 'where', l: 'Where', v: (x) => x.juris.toLowerCase() },
  { k: 'status', l: 'Status', v: (x, L) => L.STATUS_ORDER.indexOf(x.status) },
  { k: 'type', l: 'Type', v: (x, L) => L.TYPES[x.type] },
  { k: 'conf', l: 'Confidence', v: (x, L) => (x.conf ? L.CONF[x.conf].n : 0) },
  { k: 'latest', l: 'Latest step', v: (x) => (x.kd ? +x.kd.d : 0) }
];
export function sortRows(rows, L, key, dir) {
  const c = TABLE_COLS.find((t) => t.k === key) || TABLE_COLS[5], m = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => { const va = c.v(a, L), vb = c.v(b, L); return (va < vb ? -1 : va > vb ? 1 : a.id - b.id) * m; });
}
export function toCsv(rows, L) {
  const head = ['Entry number', 'Title', 'Short name', 'Level', 'Where', 'Status', 'Type', 'Section', 'Confidence', 'Latest step', 'Sponsor', 'Who it covers', 'Source', 'Source links', 'Tracker page'];
  const q = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\s+/g, ' ').trim() + '"';
  const base = location.href.split('#')[0];
  const lines = rows.map((x) => [x.id, x.title, x.short, x.level, x.juris, L.ST[x.status].l, L.TYPES[x.type], x.sec, x.conf ? L.CONF[x.conf].l : 'Not rated', x.kdLabel, x.sponsor, x.thresholds, x.source, x.srcLinks.map((l) => l.u).join(' '), base + '#/bill/' + x.id].map(q).join(','));
  return '﻿' + [head.map(q).join(','), ...lines].join('\r\n');
}

// ctx: { L, rows, sort, dir, setSort(k), sel:[ids], toggle(id), compact (cards below 1024px), download(), compare() }
export function table(ctx) {
  const { L } = ctx, rows = sortRows(ctx.rows, L, ctx.sort, ctx.dir), sel = new Set(ctx.sel), full = sel.size >= 3;
  const chk = (x) => h('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, margin: '-10px -10px -10px -12px', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: sel.has(x.id), disabled: !sel.has(x.id) && full, onChange: () => ctx.toggle(x.id), 'aria-label': 'Select ' + x.short + ' to compare', style: { width: 22, height: 22, minHeight: 0, margin: 0, accentColor: 'var(--accent-ink)', cursor: 'pointer' } }));
  const status = (x) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap' } }, h('span', { 'aria-hidden': true, style: { color: `var(--st-${x.status})` } }, L.ST[x.status].g), L.ST[x.status].l);
  const conf = (x) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 650, fontSize: 13.5, whiteSpace: 'nowrap' } },
    h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 } }, ...[1, 2, 3, 4, 5].map((i) => h('span', { key: i, style: { width: 3, height: 6 + i * 2, borderRadius: 1, background: i <= (x.conf ? L.CONF[x.conf].n : 0) ? 'var(--ink)' : 'var(--line-2)' } }))), x.conf ? L.CONF[x.conf].l : 'Not rated');
  const bar = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
    h('p', { 'aria-live': 'polite', style: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink-3)' } }, `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}. ${sel.size ? sel.size + ' selected for comparison.' : 'Tick up to three to compare them.'}`),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      sel.size >= 2 ? h('button', { onClick: ctx.compare, style: { height: 44, padding: '0 18px', borderRadius: 999, border: 0, background: 'var(--accent-ink)', color: 'var(--on-accent)', fontWeight: 750, fontSize: 14.5, cursor: 'pointer', fontFamily: 'inherit' } }, `Compare ${sel.size} selected`) : null,
      h('button', { onClick: ctx.download, style: { height: 44, padding: '0 18px', borderRadius: 999, border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink)', fontWeight: 750, fontSize: 14.5, cursor: 'pointer', fontFamily: 'inherit' } }, `Download CSV (${rows.length})`)));
  if (!rows.length) return h('div', null, bar, h('div', { role: 'status', style: { padding: 32, borderRadius: 20, border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No entries match these filters.'));

  const sortSel = h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, color: 'var(--ink-3)', marginBottom: 12 } }, 'Sort by',
    h('select', { value: ctx.sort, onChange: (e) => ctx.setSort(e.target.value, true), style: { height: 44, padding: '0 10px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', fontSize: 15, fontWeight: 600 } }, ...TABLE_COLS.map((c) => h('option', { key: c.k, value: c.k }, c.l + (c.k === 'latest' ? ' (newest first)' : '')))));
  if (ctx.compact) return h('div', null, bar, sortSel, h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 10 } },
    ...rows.map((x) => h('li', { key: x.id, style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)' } },
      h('div', { style: { paddingTop: 2 } }, chk(x)),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('a', { href: '#/bill/' + x.id, style: { display: 'inline-flex', alignItems: 'center', minHeight: 44, margin: '-8px 0', fontWeight: 750, fontSize: 16, color: 'var(--ink)', textDecoration: 'none' } }, x.short),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center' } }, status(x), conf(x)),
        h('span', { style: { fontSize: 13, color: 'var(--ink-3)', fontWeight: 600 } }, x.juris + ' · ' + L.TYPES[x.type] + ' · ' + x.kdLabel))))));

  const th = (c) => { const on = ctx.sort === c.k; return h('th', { key: c.k, scope: 'col', 'aria-sort': on ? (ctx.dir === 'asc' ? 'ascending' : 'descending') : 'none', style: { textAlign: 'left', padding: 0, position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } },
    h('button', { onClick: () => ctx.setSort(c.k), style: { width: '100%', minHeight: 44, padding: '0 8px', border: 0, background: 'transparent', color: on ? 'var(--ink)' : 'var(--ink-2)', font: 'inherit', fontWeight: 800, fontSize: 12.5, letterSpacing: '.04em', textTransform: 'uppercase', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 } }, c.l, h('span', { 'aria-hidden': true, style: { opacity: on ? 1 : 0.35 } }, on ? (ctx.dir === 'asc' ? '▲' : '▼') : '↕'))); };
  const td = { padding: '10px 8px', borderTop: '1px solid var(--line)', verticalAlign: 'top', fontSize: 14 };
  return h('div', null, bar,
    h('div', { tabIndex: 0, role: 'region', 'aria-label': 'Entries table, scrollable', style: { borderRadius: 18, border: '1px solid var(--line)', background: 'var(--surface)', overflow: 'auto', maxHeight: 'max(420px, calc(100vh - 150px))' } },
      h('table', { style: { width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 800 } },
        h('caption', { style: visuallyHidden }, 'All tracker entries. Sortable columns.'),
        h('thead', null, h('tr', null, h('th', { scope: 'col', style: { width: 48, position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } }, h('span', { style: visuallyHidden }, 'Select')), ...TABLE_COLS.filter((c) => c.k !== 'type').map(th), h('th', { scope: 'col', style: { textAlign: 'left', padding: '0 8px', fontSize: 12.5, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-2)', position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } }, 'Source'))),
        h('tbody', null, ...rows.map((x) => h('tr', { key: x.id, style: { background: sel.has(x.id) ? 'var(--accent-soft)' : 'transparent' } },
          h('td', { style: { ...td, paddingRight: 0 } }, chk(x)),
          h('td', { style: { ...td, minWidth: 250 } }, h('a', { href: '#/bill/' + x.id, title: x.title, style: { display: 'inline-flex', alignItems: 'center', minHeight: 44, margin: '-10px 0 -6px', fontWeight: 750, color: 'var(--ink)', textDecoration: 'none' } }, x.short), h('div', { style: { fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2 } }, x.sec + ' · ' + L.TYPES[x.type])),
          h('td', { style: td }, x.juris), h('td', { style: td }, status(x)), h('td', { style: td }, conf(x)),
          h('td', { style: { ...td, fontVariantNumeric: 'tabular-nums', minWidth: 100 } }, x.kdLabel),
          h('td', { style: { ...td, maxWidth: 150, fontSize: 13, color: 'var(--ink-2)' } }, x.srcLinks[0] ? h('a', { href: x.srcLinks[0].u, target: '_blank', rel: 'noopener noreferrer', style: { display: 'inline-flex', alignItems: 'center', minHeight: 44, margin: '-10px 0' } }, trunc(x.source || x.srcLinks[0].t, 24)) : trunc(x.source || '—', 24)))))))
  );
}
