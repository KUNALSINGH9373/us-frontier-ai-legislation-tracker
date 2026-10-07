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
      els.push(h('text', { key: 'a' + cur, x: x(cur) + 4, y: TOP - 16, style: { fill: isJan ? 'var(--ink)' : 'var(--ink-3)', fontSize: 'calc(11.5px*var(--fs))', fontWeight: isJan ? 800 : 600 } }, isJan ? String(dt.getUTCFullYear()) : MONTHS[dt.getUTCMonth()]));
    }
    cur = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
  }
  // rows
  let y = TOP; const lbl = [];
  groups.forEach((g) => {
    els.push(h('g', { key: 'b' + g.s },
      h('rect', { x: 0, y: y + 3, width: W, height: BAND - 6, rx: 8, style: { fill: 'var(--surface-2)' } }),
      h('text', { x: 12, y: y + BAND / 2 + 4.5, style: { fill: 'var(--ink)', fontSize: 'calc(13px*var(--fs))', fontWeight: 800 } }, g.name),
      h('text', { x: W - 12, y: y + BAND / 2 + 4.5, textAnchor: 'end', style: { fill: 'var(--ink-3)', fontSize: 'calc(11.5px*var(--fs))', fontWeight: 650 } }, g.ids.length + (g.ids.length === 1 ? ' entry' : ' entries'))));
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
          h('text', { x: LW - 12, y: cy + 4.5, textAnchor: 'end', style: { fill: 'var(--ink)', fontSize: 'calc(12.5px*var(--fs))', fontWeight: 650, cursor: 'pointer' } },
            h('tspan', { style: { fill: 'var(--ink-3)', fontWeight: 600, fontSize: 'calc(11px*var(--fs))' } }, tag), trunc(x0.short, ctx.mob ? (tag ? 14 : 19) : (tag ? 25 : 31)))),
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
    h('text', { x: Math.min(asofX, W - 56), y: TOP - 39.5, textAnchor: 'middle', style: { fill: 'var(--bg)', fontSize: 'calc(10.5px*var(--fs))', fontWeight: 800 } }, 'Data as of ' + L.fmt(L.ASOF).replace(/ 20(\d\d)$/, ' ’$1')));

  const labelText = (r, anchorX) => h('a', { href: '#/bill/' + r.id, tabIndex: -1 },
    h('title', null, r.x0.title),
    h('text', { x: anchorX, y: r.cy + 4.5, textAnchor: 'end', style: { fill: 'var(--ink)', fontSize: 'calc(12.5px*var(--fs))', fontWeight: 650, cursor: 'pointer' } },
      h('tspan', { style: { fill: 'var(--ink-3)', fontWeight: 600, fontSize: 'calc(11px*var(--fs))' } }, r.tag), trunc(r.x0.short, ctx.mob ? (r.tag ? 14 : 19) : (r.tag ? 25 : 31))));
  const overlay = h('svg', { key: 'ov', width: LW, height: H, viewBox: `0 0 ${LW} ${H}`, 'aria-hidden': true, style: { position: 'sticky', left: 0, zIndex: 3, display: 'block', flex: 'none', background: 'var(--surface)', borderRight: '1px solid var(--line)', fontFamily: 'inherit' } },
    h('rect', { x: 0, y: 0, width: LW, height: H, style: { fill: 'var(--surface)' } }),
    ...lbl.map((r, k) => r.band
      ? h('g', { key: k }, h('rect', { x: 0, y: r.y + 3, width: LW, height: BAND - 6, style: { fill: 'var(--surface-2)' } }), h('text', { x: 10, y: r.y + BAND / 2 + 4.5, style: { fill: 'var(--ink)', fontSize: 'calc(11.5px*var(--fs))', fontWeight: 800 } }, trunc(r.name, 20)))
      : h('g', { key: k }, r.sel ? h('rect', { x: 0, y: r.y, width: LW, height: ROW, style: { fill: 'var(--accent-soft)' } }) : (r.i % 2 ? h('rect', { x: 0, y: r.y, width: LW, height: ROW, style: { fill: 'var(--b-fill)' } }) : null), labelText(r, LW - 10))));
  const nEntries = byId.size, nLaw = new Set(shown.filter((e) => kindOf(e) === 'law' && +e.d <= ASOF).map((e) => e.id)).size;
  const nSched = shown.filter((e) => +e.d > ASOF).length, outside = all.filter((e) => !off.has(kindOf(e)) && (+e.d < from || +e.d > to)).length;
  const counts = {}; inRange.forEach((e) => { const k = kindOf(e); counts[k] = (counts[k] || 0) + 1; });
  const selEv = ctx.sel ? D.tev.find((e) => e.id + '|' + e.date + '|' + e.type + '|' + e.column === ctx.sel) : null;

  const pill = (on) => ({ height: 'calc(44px*var(--hs))', padding: '0 14px', borderRadius: 'min(999px,var(--r))', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--line-2)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? 'var(--bg)' : 'var(--ink)', fontWeight: 700, fontSize: 'calc(14px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' });
  const stat = (n, l) => h('div', { style: { display: 'flex', flexDirection: 'column' } }, h('strong', { style: { fontSize: 'calc(26px*var(--fs))', letterSpacing: '-.02em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' } }, n), h('span', { style: { fontSize: 'calc(13px*var(--fs))', color: 'var(--ink-3)', fontWeight: 650 } }, l));

  return h('div', null,
    h('div', { role: 'group', 'aria-label': 'Time range', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...Object.keys(RANGES).map((k) => h('button', { key: k, onClick: () => ctx.setRange(k), 'aria-pressed': ctx.range === k, style: pill(ctx.range === k) }, RANGES[k].l))),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '14px 32px', padding: '16px 20px', borderRadius: 'min(18px,var(--r))', background: 'var(--surface)', border: '1px solid var(--line)', marginBottom: 14 } },
      stat(shown.length, 'events shown'), stat(nEntries, 'entries'), stat(nLaw, 'became or are law'), stat(nSched, 'scheduled ahead'),
      outside ? h('span', { style: { alignSelf: 'center', fontSize: 'calc(13.5px*var(--fs))', color: 'var(--ink-3)', fontWeight: 600 } }, outside + (outside === 1 ? ' event' : ' events') + ' outside this range') : null),
    h('div', { role: 'group', 'aria-label': 'Event kinds', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...EV_ORDER.map((k) => { const on = !off.has(k); return h('button', { key: k, onClick: () => ctx.toggleKind(k), 'aria-pressed': on, style: { ...pill(false), height: 'calc(44px*var(--hs))', padding: '0 12px', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'calc(13.5px*var(--fs))', opacity: on ? 1 : 0.5, background: 'var(--surface)', color: 'var(--ink)', borderColor: on ? 'var(--line-2)' : 'var(--line)' } },
        h('span', { 'aria-hidden': true, style: { color: EV_KINDS[k].c, fontSize: 'calc(15px*var(--fs))', width: 16, textAlign: 'center' } }, EV_KINDS[k].g), EV_KINDS[k].l, h('span', { style: { color: 'var(--ink-3)', fontVariantNumeric: 'tabular-nums' } }, counts[k] || 0)); })),
    h('p', { style: { margin: '0 0 12px', fontSize: 'calc(14px*var(--fs))', color: 'var(--ink-3)' } }, 'One row per entry, newest activity first. Hollow marks are scheduled dates after the data cut-off. Tap or focus a mark to read the tracker’s own sentence.'),
    shown.length === 0 ? h('div', { role: 'status', style: { padding: 32, borderRadius: 'min(20px,var(--r))', border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No dated events match these filters and this range.') :
      h('div', { tabIndex: -1, ref: (el) => { if (el && el.dataset.rng !== ctx.range + (ctx.mob ? 'm' : 'd')) { el.dataset.rng = ctx.range + (ctx.mob ? 'm' : 'd'); if (asofX != null && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, asofX - (LW + (el.clientWidth - LW) * 0.7)); else el.scrollLeft = 0; } }, style: { overflowX: 'auto', borderRadius: 'min(18px,var(--r))', border: '1px solid var(--line)', background: 'var(--surface)' } },
        h('div', { style: { display: 'flex', width: W } }, overlay,
          h('svg', { viewBox: `${LW} 0 ${W - LW} ${H}`, role: 'group', 'aria-label': `Lifecycle chart: ${nEntries} entries, ${shown.length} dated events`, style: { display: 'block', width: W - LW, height: 'auto', fontFamily: 'inherit' } }, ...els, asofEl))),
    h('div', { 'aria-live': 'polite', style: { position: 'sticky', bottom: ctx.mob ? 84 : 14, zIndex: 5, marginTop: 14 } },
      selEv ? (() => { const e = selEv, x0 = D.byId[e.id], kd = kindOf(e), fut = +e.d > ASOF; return h('div', { style: { padding: '14px 16px', borderRadius: 'min(16px,var(--r))', background: 'var(--surface)', border: '1px solid var(--line-2)', boxShadow: 'var(--shadow-2)', display: 'flex', flexDirection: 'column', gap: 6 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 'calc(13.5px*var(--fs))', fontWeight: 700, color: 'var(--ink-3)' } },
          h('span', { 'aria-hidden': true, style: { color: EV_KINDS[kd].c, fontSize: 'calc(16px*var(--fs))' } }, EV_KINDS[kd].g), h('span', { style: { color: 'var(--ink)' } }, EV_KINDS[kd].l),
          h('span', null, (e.precision === 'month' ? L.fmtMonth(e.d) : L.fmt(e.d))), fut ? h('span', { style: { padding: '1px 8px', borderRadius: 'min(999px,var(--r))', border: '1px dashed var(--st-pending)', color: 'var(--ink)', fontSize: 'calc(12px*var(--fs))', fontWeight: 800 } }, 'Scheduled') : null,
          e.inferredYear ? h('span', { style: { fontWeight: 600 } }, '· year read from the same cell') : null, e.precision === 'month' ? h('span', { style: { fontWeight: 600 } }, '· month only') : null),
        h('a', { href: '#/bill/' + e.id, style: { fontSize: 'calc(16.5px*var(--fs))', fontWeight: 750, color: 'var(--ink)', textDecoration: 'none' } }, x0.short),
        h('blockquote', { style: { margin: 0, paddingLeft: 10, borderLeft: '2px solid var(--line-2)', fontSize: 'calc(14.5px*var(--fs))', color: 'var(--ink-2)' } }, '“' + e.clause.replace(/\\([\\[\]*_|])/g, '$1') + '”'),
        h('span', { style: { fontSize: 'calc(12.5px*var(--fs))', color: 'var(--ink-3)' } }, 'From the tracker’s “' + e.column + '” column. Event kind is read from the wording and may need a check.'));
      })() : h('div', { style: { padding: '12px 16px', borderRadius: 'min(16px,var(--r))', background: 'var(--surface-2)', color: 'var(--ink-3)', fontSize: 'calc(14px*var(--fs))' } }, 'Select a mark to see what happened and the exact sentence it was read from.')));
}

/* ---------- relationship network ---------- */
export const LENSES = {
  all: { l: 'Everything', d: 'Every relationship the tracker states.', types: null, start: 'SB53' },
  family: { l: 'Who copied whom', d: 'Drafting families, replacements and amendments.', types: ['template', 'succession'], start: 'SB53' },
  fedstate: { l: 'Washington vs. the states', d: 'Federal pressure, executive orders and lawsuits.', types: ['fedstate', 'executive', 'litigation'], start: null },
  assurance: { l: 'Who checks the checkers', d: 'Auditor and verifier laws and what they build on.', types: ['assurance'], start: 'SB813' },
  people: { l: 'Sponsors and backers', d: 'Who sponsors, supports and opposes.', types: ['actor'], start: null }
};
export const TYPE_COLOR = { template: 'var(--accent)', succession: 'var(--st-pending)', fedstate: 'var(--st-enacted)', executive: 'var(--st-executive)', litigation: 'var(--st-litigation)', assurance: 'var(--st-auditor)', actor: 'var(--st-stalled)' };

// Edges of a lens (after the type toggles), and the best starting points: most-linked items first.
export function lensGraph(D, lensK, off) {
  const lens = LENSES[lensK] || LENSES.all, offs = new Set(off || []);
  const edges = D.edges.filter((e) => (!lens.types || lens.types.includes(e.type)) && !offs.has(e.type));
  const deg = {}; edges.forEach((e) => { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; });
  const hubs = Object.keys(deg).sort((a, b) => deg[b] - deg[a]);
  return { lens, edges, deg, hubs };
}
export const netFocus = (D, lensK, off, c) => { const g = lensGraph(D, lensK, off); return c && g.deg[c] ? c : (g.lens.start && g.deg[g.lens.start] ? g.lens.start : g.hubs[0] || c); };

// ctx: { L, D, lens, scope:'near'|'all', off:[], focus:key, hover:key, select(key), hoverSet(key|null), setLens(k), setScope(s), toggleType(t) }
export function network(ctx) {
  const { D } = ctx, R = D.rel, lens = LENSES[ctx.lens] || LENSES.all, off = new Set(ctx.off);
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
      h('text', { x: p.x + 14, y: p.y + 17, style: { fill: 'var(--ink)', fontSize: 'calc(12.5px*var(--fs))', fontWeight: 750 } }, h('title', null, n.name + ' · ' + n.sub), trunc(n.name, nameN)),
      h('text', { x: p.x + 14, y: p.y + 31, style: { fill: 'var(--ink-3)', fontSize: 'calc(10.5px*var(--fs))', fontWeight: 600 } }, n.x ? h('tspan', { style: { fill: col } }, ctx.L.ST[n.x.status].g + ' ') : null, trunc(n.sub, subN)));
  });
  const heads = cols.map((c, ci) => h('text', { key: 'h' + ci, x: PAD + ci * (NW + GAP), y: 20, style: { fill: 'var(--ink-3)', fontSize: 'calc(11.5px*var(--fs))', fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' } }, trunc(R.columns[colIdx[ci]] || '', Math.max(10, Math.floor((NW + GAP - 16) / 7.6)))));
  const defs = h('defs', null, ...Object.keys(R.types).map((t) => h('marker', { key: t, id: 'arr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, h('path', { d: 'M0 1L9 5L0 9Z', style: { fill: TYPE_COLOR[t] } }))));

  const pill = (on) => ({ minHeight: 'calc(44px*var(--hs))', padding: '0 16px', borderRadius: 'min(999px,var(--r))', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--line-2)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? 'var(--bg)' : 'var(--ink)', fontWeight: 700, fontSize: 'calc(14.5px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' });
  const big = ctx.lens === 'all' || ctx.scope === 'all';
  return h('div', null,
    h('div', { role: 'group', 'aria-label': 'Relationship views', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 } },
      ...Object.keys(LENSES).map((k) => h('button', { key: k, onClick: () => ctx.setLens(k), 'aria-pressed': ctx.lens === k, style: pill(ctx.lens === k) }, LENSES[k].l))),
    h('p', { style: { margin: '0 0 12px', fontSize: 'calc(15px*var(--fs))', color: 'var(--ink-2)' } }, h('strong', { style: { color: 'var(--ink)' } }, lens.d + ' '), `Showing ${edges.length} of ${D.edges.length} links across ${nodes.length} items. Tap a box to follow its links.`),
    ctx.lens === 'all' ? null : h('div', { role: 'group', 'aria-label': 'Start from', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 } },
      h('span', { style: { fontSize: 'calc(12.5px*var(--fs))', fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 4 } }, 'Start from'),
      ...G.hubs.slice(0, 6).map((k) => h('button', { key: k, onClick: () => ctx.select(k), 'aria-pressed': k === ctx.focus, style: { minHeight: 'calc(44px*var(--hs))', padding: '0 14px', borderRadius: 'min(999px,var(--r))', border: '1px solid ' + (k === ctx.focus ? 'var(--accent)' : 'var(--line-2)'), background: k === ctx.focus ? 'var(--accent-soft)' : 'var(--surface)', color: 'var(--ink)', fontWeight: 700, fontSize: 'calc(13.5px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' } }, trunc(nameOf(k), 26))),
      h('button', { onClick: () => ctx.setScope(ctx.scope === 'all' ? 'near' : 'all'), 'aria-pressed': ctx.scope === 'all', style: { minHeight: 'calc(44px*var(--hs))', padding: '0 14px', borderRadius: 'min(999px,var(--r))', border: '1px dashed var(--line-2)', background: ctx.scope === 'all' ? 'var(--ink)' : 'transparent', color: ctx.scope === 'all' ? 'var(--bg)' : 'var(--ink-2)', fontWeight: 700, fontSize: 'calc(13.5px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' } }, ctx.scope === 'all' ? 'Show only this item’s links' : 'Show the whole group')),
    h('div', { role: 'group', 'aria-label': 'Link types', style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 } },
      ...Object.keys(R.types).filter((t) => !lens.types || lens.types.includes(t)).map((t) => { const on = !off.has(t); return h('button', { key: t, onClick: () => ctx.toggleType(t), 'aria-pressed': on, style: { minHeight: 'calc(44px*var(--hs))', padding: '0 12px', borderRadius: 'min(999px,var(--r))', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontWeight: 650, fontSize: 'calc(13.5px*var(--fs))', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, opacity: on ? 1 : 0.5, fontFamily: 'inherit' } },
        h('span', { 'aria-hidden': true, style: { width: 22, height: 3, borderRadius: 2, background: TYPE_COLOR[t] } }), R.types[t].name, h('span', { style: { opacity: .65, fontVariantNumeric: 'tabular-nums' } }, String(D.edges.filter((e) => e.type === t).length))); })),
    nodes.length === 0 ? h('div', { role: 'status', style: { padding: 32, borderRadius: 'min(20px,var(--r))', border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No links to show. Turn a link type back on.') :
      h('div', { style: { overflow: 'auto', maxHeight: big ? 760 : 'none', borderRadius: 'min(18px,var(--r))', border: '1px solid var(--line)', background: 'var(--surface)' } },
        h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `Relationship network: ${nodes.length} items and ${edges.length} links`, style: { display: 'block', width: '100%', maxWidth: big ? 'none' : W * 1.05, minWidth: big ? 1500 : W, height: 'auto', fontFamily: 'inherit' } }, defs, ...heads, ...paths, ...nodeEls)),
    ctx.avail && W > ctx.avail && !big ? h('p', { style: { margin: '8px 0 0', fontSize: 'calc(13px*var(--fs))', fontWeight: 700, color: 'var(--ink-2)' } }, '↔ Scroll sideways to see every column.') : null,
    h('p', { style: { margin: '10px 0 0', fontSize: 'calc(13px*var(--fs))', color: 'var(--ink-3)' } }, 'Arrows point from the earlier or acting item to the later or affected one. Dashed lines are links the tracker itself marks as unproven. Dashed boxes are people and groups.'));
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
  const chk = (x) => h('label', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 'calc(44px*var(--hs))', height: 'calc(44px*var(--hs))', margin: '-10px -10px -10px -12px', cursor: 'pointer' } }, h('input', { type: 'checkbox', checked: sel.has(x.id), disabled: !sel.has(x.id) && full, onChange: () => ctx.toggle(x.id), 'aria-label': 'Select ' + x.short + ' to compare', style: { width: 22, height: 22, minHeight: 0, margin: 0, accentColor: 'var(--accent-ink)', cursor: 'pointer' } }));
  const status = (x) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 'calc(13.5px*var(--fs))', whiteSpace: 'nowrap' } }, h('span', { 'aria-hidden': true, style: { color: `var(--st-${x.status})` } }, L.ST[x.status].g), L.ST[x.status].l);
  const conf = (x) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 650, fontSize: 'calc(13.5px*var(--fs))', whiteSpace: 'nowrap' } },
    h('span', { 'aria-hidden': true, style: { display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 14 } }, ...[1, 2, 3, 4, 5].map((i) => h('span', { key: i, style: { width: 3, height: 6 + i * 2, borderRadius: 1, background: i <= (x.conf ? L.CONF[x.conf].n : 0) ? 'var(--ink)' : 'var(--line-2)' } }))), x.conf ? L.CONF[x.conf].l : 'Not rated');
  const bar = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 } },
    h('p', { 'aria-live': 'polite', style: { margin: 0, fontSize: 'calc(14px*var(--fs))', fontWeight: 600, color: 'var(--ink-3)' } }, `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}. ${sel.size ? sel.size + ' selected for comparison.' : 'Tick up to three to compare them.'}`),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      sel.size >= 2 ? h('button', { onClick: ctx.compare, style: { height: 'calc(44px*var(--hs))', padding: '0 18px', borderRadius: 'min(999px,var(--r))', border: 0, background: 'var(--accent-ink)', color: 'var(--on-accent)', fontWeight: 750, fontSize: 'calc(14.5px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' } }, `Compare ${sel.size} selected`) : null,
      h('button', { onClick: ctx.download, style: { height: 'calc(44px*var(--hs))', padding: '0 18px', borderRadius: 'min(999px,var(--r))', border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink)', fontWeight: 750, fontSize: 'calc(14.5px*var(--fs))', cursor: 'pointer', fontFamily: 'inherit' } }, `Download CSV (${rows.length})`)));
  if (!rows.length) return h('div', null, bar, h('div', { role: 'status', style: { padding: 32, borderRadius: 'min(20px,var(--r))', border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'No entries match these filters.'));

  const sortSel = h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 'calc(13.5px*var(--fs))', fontWeight: 700, color: 'var(--ink-3)', marginBottom: 12 } }, 'Sort by',
    h('select', { value: ctx.sort, onChange: (e) => ctx.setSort(e.target.value, true), style: { height: 'calc(44px*var(--hs))', padding: '0 10px', borderRadius: 'min(12px,var(--r))', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', fontSize: 'calc(15px*var(--fs))', fontWeight: 600 } }, ...TABLE_COLS.map((c) => h('option', { key: c.k, value: c.k }, c.l + (c.k === 'latest' ? ' (newest first)' : '')))));
  if (ctx.compact) return h('div', null, bar, sortSel, h('ul', { style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 10 } },
    ...rows.map((x) => h('li', { key: x.id, style: { display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 'min(16px,var(--r))', background: 'var(--surface)', border: '1px solid var(--line)' } },
      h('div', { style: { paddingTop: 2 } }, chk(x)),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('a', { href: '#/bill/' + x.id, style: { display: 'inline-flex', alignItems: 'center', minHeight: 'calc(44px*var(--hs))', margin: '-8px 0', fontWeight: 750, fontSize: 'calc(16px*var(--fs))', color: 'var(--ink)', textDecoration: 'none' } }, x.short),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center' } }, status(x), conf(x)),
        h('span', { style: { fontSize: 'calc(13px*var(--fs))', color: 'var(--ink-3)', fontWeight: 600 } }, x.juris + ' · ' + L.TYPES[x.type] + ' · ' + x.kdLabel))))));

  const th = (c) => { const on = ctx.sort === c.k; return h('th', { key: c.k, scope: 'col', 'aria-sort': on ? (ctx.dir === 'asc' ? 'ascending' : 'descending') : 'none', style: { textAlign: 'left', padding: 0, position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } },
    h('button', { onClick: () => ctx.setSort(c.k), style: { width: '100%', minHeight: 'calc(44px*var(--hs))', padding: '0 8px', border: 0, background: 'transparent', color: on ? 'var(--ink)' : 'var(--ink-2)', font: 'inherit', fontWeight: 800, fontSize: 'calc(12.5px*var(--fs))', letterSpacing: '.04em', textTransform: 'uppercase', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 } }, c.l, h('span', { 'aria-hidden': true, style: { opacity: on ? 1 : 0.35 } }, on ? (ctx.dir === 'asc' ? '▲' : '▼') : '↕'))); };
  const td = { padding: '10px 8px', borderTop: '1px solid var(--line)', verticalAlign: 'top', fontSize: 'calc(14px*var(--fs))' };
  return h('div', null, bar,
    h('div', { tabIndex: 0, role: 'region', 'aria-label': 'Entries table, scrollable', style: { borderRadius: 'min(18px,var(--r))', border: '1px solid var(--line)', background: 'var(--surface)', overflow: 'auto', maxHeight: 'max(420px, calc(100vh - 150px))' } },
      h('table', { style: { width: '100%', borderCollapse: 'separate', borderSpacing: 0, minWidth: 800 } },
        h('caption', { style: visuallyHidden }, 'All tracker entries. Sortable columns.'),
        h('thead', null, h('tr', null, h('th', { scope: 'col', style: { width: 48, position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } }, h('span', { style: visuallyHidden }, 'Select')), ...TABLE_COLS.filter((c) => c.k !== 'type').map(th), h('th', { scope: 'col', style: { textAlign: 'left', padding: '0 8px', fontSize: 'calc(12.5px*var(--fs))', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-2)', position: 'sticky', top: 0, background: 'var(--surface-2)', zIndex: 2 } }, 'Source'))),
        h('tbody', null, ...rows.map((x) => h('tr', { key: x.id, style: { background: sel.has(x.id) ? 'var(--accent-soft)' : 'transparent' } },
          h('td', { style: { ...td, paddingRight: 0 } }, chk(x)),
          h('td', { style: { ...td, minWidth: 250 } }, h('a', { href: '#/bill/' + x.id, title: x.title, style: { display: 'inline-flex', alignItems: 'center', minHeight: 'calc(44px*var(--hs))', margin: '-10px 0 -6px', fontWeight: 750, color: 'var(--ink)', textDecoration: 'none' } }, x.short), h('div', { style: { fontSize: 'calc(12.5px*var(--fs))', color: 'var(--ink-3)', marginTop: 2 } }, x.sec + ' · ' + L.TYPES[x.type])),
          h('td', { style: td }, x.juris), h('td', { style: td }, status(x)), h('td', { style: td }, conf(x)),
          h('td', { style: { ...td, fontVariantNumeric: 'tabular-nums', minWidth: 100 } }, x.kdLabel),
          h('td', { style: { ...td, maxWidth: 150, fontSize: 'calc(13px*var(--fs))', color: 'var(--ink-2)' } }, x.srcLinks[0] ? h('a', { href: x.srcLinks[0].u, target: '_blank', rel: 'noopener noreferrer', style: { display: 'inline-flex', alignItems: 'center', minHeight: 'calc(44px*var(--hs))', margin: '-10px 0' } }, trunc(x.source || x.srcLinks[0].t, 24)) : trunc(x.source || '—', 24)))))))
  );
}

/* ---------- focused relationship view ---------- */
// Everything connected to one item, walked outwards step by step. People and groups are shown on the cards
// but are not walked through unless asked, because a sponsor or company links otherwise unrelated bills.
const FOCUS_TYPE_ORDER = ['template', 'succession', 'fedstate', 'executive', 'litigation', 'assurance', 'actor'];
const FOCUS_TYPE_SHORT = { template: 'Drafting family', succession: 'Predecessor or amendment', fedstate: 'Federal–state', executive: 'Executive action', litigation: 'Litigation', assurance: 'Auditor layer', actor: 'People and groups' };

// opts: { people: bool, depth: number|null }
export function focusData(D, focus, opts) {
  const R = D.rel, isActor = (k) => !!R.actors[k];
  const adj = {}; D.edges.forEach((e) => { (adj[e.from] = adj[e.from] || []).push(e); (adj[e.to] = adj[e.to] || []).push(e); });
  const walk = (people, limit) => {
    const step = { [focus]: 0 }, via = {}, q = [focus];
    while (q.length) {
      const k = q.shift();
      if (limit != null && step[k] >= limit) continue;
      if (k !== focus && isActor(k) && !people) continue;
      (adj[k] || []).forEach((e) => { const o = e.from === k ? e.to : e.from; if (step[o] != null) return; if (isActor(o) && !people) return; step[o] = step[k] + 1; via[o] = { from: k, e }; q.push(o); });
    }
    return { step, via };
  };
  const { step, via } = walk(!!opts.people, opts.depth);
  const reach = walk(!!opts.people, null).step;
  const keys = Object.keys(step);
  const maxStep = Math.max(0, ...Object.values(step));
  const rows = [];
  for (let s = 0; s <= maxStep; s++) {
    const inRow = keys.filter((k) => step[k] === s);
    const groups = s === 0 ? [{ type: null, keys: inRow }] : FOCUS_TYPE_ORDER.map((t) => ({ type: t, keys: inRow.filter((k) => via[k].e.type === t) })).filter((g) => g.keys.length);
    rows.push({ step: s, n: inRow.length, groups });
  }
  const people = {}; if (!opts.people) keys.forEach((k) => { people[k] = [...new Set((adj[k] || []).filter((e) => e.type === 'actor').map((e) => (e.from === k ? e.to : e.from)).filter(isActor))]; });
  return { focus, step, via, rows, people, n: keys.length - 1, reachN: Object.keys(reach).length - 1, reachSteps: Math.max(0, ...Object.values(reach)) };
}

// What the linked item is, seen from the item it hangs off. `out` = the edge runs from the parent to the child.
const ROLE = {
  template: { out: 'Copied its framework', in: 'Its template' },
  succession: { out: 'Successor or revival', in: 'Earlier version' },
  fedstate: { out: 'State law it targets', in: 'Federal move targeting it' },
  executive: { out: 'Follows from this order', in: 'Order behind it' },
  litigation: { out: 'Resulting case or step', in: 'What led to this case' },
  assurance: { out: 'Auditor or verifier link', in: 'Auditor or verifier link' },
  actor: null
};
const roleOf = (e, parent) => {
  const out = e.from === parent;
  if (e.type === 'template' && e.dashed) return out ? 'Similar framework · not proven copied' : 'Similar to · not proven copied';
  const r = ROLE[e.type] ? ROLE[e.type][out ? 'out' : 'in'] : e.label;
  return r + (e.dashed ? ' · unproven' : '');
};

/* ---------- relationship canvas ---------- */
// A pan-and-zoom canvas. The start item sits in the middle with its links around it. Clicking a linked item
// fans its own links out around it (it becomes a local hub); clicking it again folds them back.
const NW = 164, NH = 56, RW = 204, RH = 66;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let CanvasClass = null;
function canvasClass() {
  if (CanvasClass) return CanvasClass;
  CanvasClass = class RelCanvas extends React.Component {
    constructor(p) {
      super(p); this.wrap = React.createRef(); this.ptrs = new Map(); this.fitted = false;
      this.rm = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.state = { ...this.initial(p), cam: { x: 0, y: 0, s: 1 }, w: 0, h: 0, sel: null, hover: null };
    }
    initial(p) { const nodes = { [p.root]: { x: 0, y: 0, hub: null } }; this.fan(nodes, p.root, p); return { nodes, open: { [p.root]: true } }; }
    others(k, p = this.props) { return [...new Set((p.adj[k] || []).map((a) => a.o))]; }
    hidden(k, nodes = this.state.nodes) { return this.others(k).filter((o) => !nodes[o]).length; }
    // place k's not-yet-shown links around k, opening away from k's own hub
    fan(nodes, k, p = this.props) {
      const kids = this.others(k, p).filter((o) => !nodes[o]); if (!kids.length) return [];
      const c = nodes[k], hub = c.hub ? nodes[c.hub] : null, n = kids.length, root = !hub;
      const dir = hub ? Math.atan2(c.y - hub.y, c.x - hub.x) : -Math.PI / 2;
      const span = root ? 2 * Math.PI : Math.min(1.6 * Math.PI, Math.max(Math.PI / 2.2, n * 0.5));
      const r = root ? Math.max(180, n * 19) : Math.max(200, (n * 110) / span), tall = !!(p.ctx && p.ctx.narrow), fx = tall ? 0.42 : 1.35, fy = tall ? 1.15 : 0.8;
      kids.forEach((o, i) => {
        const a = root ? dir + (i * 2 * Math.PI) / n : n === 1 ? dir : dir - span / 2 + (i * span) / (n - 1);
        nodes[o] = { x: c.x + Math.cos(a) * r * fx, y: c.y + Math.sin(a) * r * fy, hub: k };
      });
      // nudge the new nodes off anything they overlap
      for (let it = 0; it < 80; it++) {
        let moved = false;
        kids.forEach((o) => {
          const a = nodes[o];
          Object.keys(nodes).forEach((q) => {
            if (q === o) return; const b = nodes[q], dx = a.x - b.x, dy = a.y - b.y, ox = NW + 22 - Math.abs(dx), oy = NH + 18 - Math.abs(dy);
            if (ox > 0 && oy > 0) { moved = true; if (ox / (NW + 22) < oy / (NH + 18)) a.x += (dx >= 0 ? 1 : -1) * (ox / 2 + 1); else a.y += (dy >= 0 ? 1 : -1) * (oy / 2 + 1); }
          });
        });
        if (!moved) break;
      }
      return kids;
    }
    componentDidMount() {
      const el = this.wrap.current;
      this.onWheel = (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = el.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022)); };
      el.addEventListener('wheel', this.onWheel, { passive: false });
      this.measure(); if (window.ResizeObserver) { this.ro = new ResizeObserver(() => this.measure()); this.ro.observe(el); }
    }
    componentWillUnmount() { cancelAnimationFrame(this.raf); clearTimeout(this.snap); if (this.ro) this.ro.disconnect(); if (this.wrap.current) this.wrap.current.removeEventListener('wheel', this.onWheel); }
    componentDidUpdate(pp) {
      if (pp.root !== this.props.root || pp.adj !== this.props.adj) { this.setState({ ...this.initial(this.props), sel: null, hover: null }, () => this.fit(true)); }
    }
    measure() { const el = this.wrap.current; if (!el) return; const w = el.clientWidth, h = el.clientHeight; if (w !== this.state.w || h !== this.state.h) this.setState({ w, h }, () => { if (!this.fitted) { this.fitted = true; this.fit(false); } }); }
    bbox(keys) { const ns = this.state.nodes; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; keys.forEach((k) => { const n = ns[k]; if (!n) return; x0 = Math.min(x0, n.x - RW / 2); x1 = Math.max(x1, n.x + RW / 2); y0 = Math.min(y0, n.y - RH / 2); y1 = Math.max(y1, n.y + RH / 2); }); return { x0, y0, x1, y1 }; }
    camFor(b, maxS, right = 0, bottom = 0) { const h = this.state.h - bottom, w = this.state.w - right, pad = 36, s = clamp(Math.min((w - pad * 2) / (b.x1 - b.x0), (h - pad * 2) / (b.y1 - b.y0)), 0.3, maxS); return { s, x: w / 2 - ((b.x0 + b.x1) / 2) * s, y: h / 2 - ((b.y0 + b.y1) / 2) * s }; }
    fit(anim) { if (!this.state.w) return; this.go(this.camFor(this.bbox(Object.keys(this.state.nodes)), 1.1), anim); }
    // keep a freshly opened cluster in view without jumping when it already is
    reveal(keys) {
      // on wide canvases the details panel covers the right 344px, so keep the cluster left of it
      const { cam, w, h } = this.state, b = this.bbox(keys), m = 20, bottom = w >= 640 ? 120 : Math.round(h * 0.45);
      const inView = b.x0 * cam.s + cam.x >= m + 44 && b.x1 * cam.s + cam.x <= w - m && b.y0 * cam.s + cam.y >= m && b.y1 * cam.s + cam.y <= h - bottom - m;
      if (!inView) this.go(this.camFor(b, cam.s, 0, bottom), true);
    }
    go(to, anim) {
      cancelAnimationFrame(this.raf); clearTimeout(this.snap);
      if (!anim || this.rm) { this.setState({ cam: to }); return; }
      const from = this.state.cam, t0 = performance.now(), D = 380;
      const step = (t) => { const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3); this.setState({ cam: { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, s: from.s + (to.s - from.s) * e } }); if (p < 1) this.raf = requestAnimationFrame(step); };
      this.raf = requestAnimationFrame(step);
      clearTimeout(this.snap); this.snap = setTimeout(() => { cancelAnimationFrame(this.raf); this.setState({ cam: to }); }, D + 80); // if frames are paused (background tab), land anyway
    }
    zoomAt(px, py, f) { cancelAnimationFrame(this.raf); clearTimeout(this.snap); const c = this.state.cam, s = clamp(c.s * f, 0.3, 2); this.setState({ cam: { s, x: px - (px - c.x) * (s / c.s), y: py - (py - c.y) * (s / c.s) } }); }
    zoomBy(f) { this.zoomAt(this.state.w / 2, this.state.h / 2, f); }
    // pointer: drag to pan, two fingers to pinch
    down = (e) => { if (e.button !== undefined && e.button !== 0) return; this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.moved = 0; this.cap = e.pointerId; };
    move = (e) => {
      if (!this.ptrs.has(e.pointerId)) return; const prev = this.ptrs.get(e.pointerId); this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.ptrs.size === 2) { const [a, b] = [...this.ptrs.values()], r = this.wrap.current.getBoundingClientRect(); const d = Math.hypot(a.x - b.x, a.y - b.y), pd = this.pd || d; this.pd = d; this.moved += 10; this.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pd); return; }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y; this.moved += Math.abs(dx) + Math.abs(dy);
      if (this.moved > 4) { if (this.cap != null && this.wrap.current.setPointerCapture) { try { this.wrap.current.setPointerCapture(this.cap); } catch (er) {} this.cap = null; } cancelAnimationFrame(this.raf); const c = this.state.cam; this.setState({ cam: { ...c, x: c.x + dx, y: c.y + dy }, dragging: true }); }
    };
    up = (e) => { this.ptrs.delete(e.pointerId); if (this.ptrs.size < 2) this.pd = 0; if (!this.ptrs.size) setTimeout(() => { this.moved = 0; if (this.state.dragging) this.setState({ dragging: false }); }, 0); };
    // click on a node: open or fold its links, and show its details
    tap(k) {
      if (this.moved > 4) return;
      const root = k === this.props.root, nodes = { ...this.state.nodes }, open = { ...this.state.open };
      if (root) { this.setState({ sel: k }); return; }
      if (open[k]) {
        const drop = (h) => Object.keys(nodes).forEach((q) => { if (nodes[q] && nodes[q].hub === h && q !== this.props.root) { drop(q); delete nodes[q]; delete open[q]; } });
        drop(k); delete open[k]; this.setState({ nodes, open, sel: k });
      } else {
        const kids = this.fan(nodes, k); if (kids.length) open[k] = true;
        this.setState({ nodes, open, sel: k }, () => { if (kids.length) this.reveal([k, ...kids]); });
      }
    }
    render() {
      const { ctx, root, adj } = this.props, { L, D } = ctx, R = D.rel, { nodes, open, cam, w, sel, hover, dragging } = this.state;
      const nameOf = (k) => R.actors[k] || R.short[k] || k, keys = Object.keys(nodes), focus = hover || sel;
      const seen = new Set(), edges = [];
      keys.forEach((a) => (adj[a] || []).forEach(({ o, e }) => { if (!nodes[o]) return; const id = a < o ? a + '|' + o : o + '|' + a; if (seen.has(id)) return; seen.add(id); edges.push({ a, b: o, e }); }));
      // a link that brought a node in (node to its hub) is drawn firmly; links between two already-shown nodes are faint until one end is in focus
      const line = (x) => { const A = nodes[x.a], B = nodes[x.b], on = focus && (x.a === focus || x.b === focus), tree = A.hub === x.b || B.hub === x.a; return h('line', { key: x.a + x.b, x1: A.x, y1: A.y, x2: B.x, y2: B.y, style: { stroke: TYPE_COLOR[x.e.type], strokeWidth: on ? 2.6 : tree ? 1.8 : 1.2, strokeDasharray: x.e.dashed ? '6 5' : undefined, opacity: focus ? (on ? 1 : 0.12) : tree ? 0.75 : 0.22, transition: 'opacity .15s' } }); };
      const tags = hover ? edges.filter((x) => (x.a === hover || x.b === hover) && (nodes[x.a].hub === x.b || nodes[x.b].hub === x.a)).map((x) => { const focus = hover, other = x.a === focus ? x.b : x.a, A = nodes[focus], B = nodes[other], mx = A.x + (B.x - A.x) * 0.55, my = A.y + (B.y - A.y) * 0.55;
        return h('span', { key: 't' + other, 'aria-hidden': true, style: { position: 'absolute', left: mx, top: my, transform: 'translate(-50%,-50%)', whiteSpace: 'nowrap', padding: '2px 7px', borderRadius: 999, background: 'var(--surface)', border: `1px solid ${TYPE_COLOR[x.e.type]}`, color: 'var(--ink-2)', fontSize: 11, fontWeight: 650, pointerEvents: 'none', zIndex: 2 } }, roleOf(x.e, focus)); }) : [];
      const node = (k) => {
        const n = nodes[k], isRoot = k === root, id = D.keyToId[k], x = id ? D.byId[id] : null, actor = !!R.actors[k], more = this.hidden(k), isOpen = !!open[k] && !isRoot;
        const col = x ? `var(--st-${x.status})` : 'var(--ink-3)', on = focus === k || sel === k, near = focus && !on && edges.some((y) => (y.a === focus && y.b === k) || (y.b === focus && y.a === k)), dim = focus && !on && !near;
        const W = isRoot ? RW : NW, H = isRoot ? RH : NH, meta = x ? [L.ST[x.status].g + ' ' + L.ST[x.status].l, x.st || x.juris].filter(Boolean).join(' · ') : actor ? 'Person or group' : '';
        const badge = isOpen ? '−' : more ? String(more) : '';
        return h('button', { key: k, type: 'button', 'data-fk': k, 'aria-expanded': !isRoot && (more || isOpen) ? isOpen : undefined, 'aria-current': isRoot ? 'true' : undefined,
          'aria-label': `${nameOf(k)}. ${meta}.${isRoot ? ' Start item.' : ''}${isOpen ? ' Links shown; press to fold them.' : more ? ` ${more} more ${more === 1 ? 'link' : 'links'}; press to show ${more === 1 ? 'it' : 'them'}.` : ''}`,
          onClick: () => this.tap(k), onMouseEnter: () => this.setState({ hover: k }), onMouseLeave: () => this.setState({ hover: null }), onFocus: () => this.setState({ hover: k }), onBlur: () => this.setState({ hover: null }),
          style: { position: 'absolute', left: n.x - W / 2, top: n.y - H / 2, width: W, height: H, zIndex: on ? 4 : 3, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1, padding: '0 14px 0 14px', textAlign: 'left', font: 'inherit', color: 'var(--ink)', background: isRoot ? 'var(--accent-soft)' : 'var(--surface)', border: `${isRoot || on ? 2 : 1}px ${actor ? 'dashed' : 'solid'} ${isRoot || on ? 'var(--accent)' : 'var(--line-2)'}`, borderRadius: 10, boxShadow: on ? 'var(--shadow-3)' : 'var(--shadow-1)', cursor: dragging ? 'grabbing' : 'pointer', opacity: dim ? 0.4 : 1, transition: 'opacity .15s, box-shadow .15s' } },
          h('span', { 'aria-hidden': true, style: { position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: col } }),
          meta ? h('span', { style: { fontSize: 11, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, meta) : null,
          h('span', { style: { fontSize: isRoot ? 15 : 13.5, fontWeight: 650, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, nameOf(k)),
          badge ? h('span', { 'aria-hidden': true, style: { position: 'absolute', top: -9, right: -9, minWidth: 22, height: 22, padding: '0 6px', borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 11.5, fontWeight: 750, fontVariantNumeric: 'tabular-nums', background: isOpen ? 'var(--surface)' : 'var(--accent-ink)', color: isOpen ? 'var(--ink)' : 'var(--on-accent)', border: '2px solid var(--surface)', boxShadow: '0 0 0 1px var(--line-2)' } }, badge) : null);
      };
      // details for the selected node
      const panel = (() => {
        if (!sel || !nodes[sel]) return null;
        const k = sel, n = nodes[k], id = D.keyToId[k], x = id ? D.byId[id] : null, more = this.hidden(k), isRoot = k === root, total = this.others(k).length;
        const link = n.hub ? (adj[k] || []).find((a) => a.o === n.hub) : null;
        const ppl = [...new Set((ctx.allAdj[k] || []).filter((a) => R.actors[a.o]).map((a) => nameOf(a.o)))];
        const narrow = w < 640, b = { height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink)', fontWeight: 650, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' };
        const sm = { fontSize: 12.5, color: 'var(--ink-3)' };
        return h('aside', { 'aria-label': 'Details', onPointerDown: (e) => e.stopPropagation(), style: { position: 'absolute', zIndex: 10, left: 10, right: 10, bottom: 10, maxHeight: narrow ? '55%' : 150, overflow: 'auto', padding: '12px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--line-2)', boxShadow: 'var(--shadow-3)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', cursor: 'auto' } },
          h('div', { style: { flex: '1 1 200px', minWidth: 0 } },
            x ? h('div', { style: sm }, h('span', { style: { color: `var(--st-${x.status})` } }, L.ST[x.status].g + ' '), [L.ST[x.status].l, x.juris].filter(Boolean).join(' · ')) : null,
            h('div', { 'data-serif': '', style: { fontSize: 17, lineHeight: 1.25 } }, nameOf(k)),
            h('div', { style: sm }, `Linked to ${total} ${total === 1 ? 'item' : 'items'}${more ? `, ${more} not shown` : ''}` + (ppl.length ? ` · People: ${ppl.slice(0, 2).join(', ')}${ppl.length > 2 ? ` +${ppl.length - 2}` : ''}` : ''))),
          link ? h('div', { title: link.e.quote ? '“' + link.e.quote + '”' : undefined, style: { flex: '2 1 280px', minWidth: 0, paddingLeft: 12, borderLeft: `3px solid ${TYPE_COLOR[link.e.type]}` } },
            h('div', { style: { fontSize: 12.5, fontWeight: 700, color: 'var(--ink)' } }, `${roleOf(link.e, n.hub)} — ${nameOf(n.hub)}`),
            h('div', { style: { fontSize: 13, color: 'var(--ink-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, link.e.label)) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
            !isRoot && (more || open[k]) ? h('button', { type: 'button', 'data-chip': '', onClick: () => this.tap(k), style: b }, open[k] ? 'Fold its links' : `Show ${more} more`) : null,
            !isRoot ? h('button', { type: 'button', 'data-chip': '', onClick: () => ctx.select(k), style: b }, 'Make this the centre') : null,
            x ? h('a', { href: '#/bill/' + x.id, style: { ...b, background: 'var(--accent-ink)', color: 'var(--on-accent)', border: 0 } }, 'Open entry →') : null,
            h('button', { type: 'button', 'data-chip': '', onClick: () => this.setState({ sel: null }), 'aria-label': 'Close details', style: { ...b, width: 34, padding: 0, justifyContent: 'center' } }, '✕')));
      })();
      const tool = { width: 34, height: 34, display: 'grid', placeItems: 'center', border: 0, borderBottom: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 0 };
      return h('div', { ref: this.wrap, role: 'region', 'aria-label': `Relationship canvas starting from ${nameOf(root)}. Drag to move, Ctrl and scroll or pinch to zoom.`,
        onPointerDown: this.down, onPointerMove: this.move, onPointerUp: this.up, onPointerCancel: this.up,
        style: { position: 'relative', height: ctx.height, overflow: 'hidden', touchAction: 'none', userSelect: 'none', cursor: dragging ? 'grabbing' : 'grab', borderRadius: 'var(--r)', border: '1px solid var(--line)', background: 'var(--surface-2)', backgroundImage: 'radial-gradient(var(--line-2) 1px, transparent 1px)', backgroundSize: `${22 * cam.s}px ${22 * cam.s}px`, backgroundPosition: `${cam.x}px ${cam.y}px` } },
        h('div', { style: { position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `translate(${cam.x}px,${cam.y}px) scale(${cam.s})` } },
          h('svg', { 'aria-hidden': true, width: 1, height: 1, style: { position: 'absolute', left: 0, top: 0, overflow: 'visible' } }, ...edges.map(line)),
          ...tags, ...keys.map(node)),
        h('div', { role: 'group', 'aria-label': 'Zoom', onPointerDown: (e) => e.stopPropagation(), style: { position: 'absolute', left: 12, top: 12, zIndex: 9, display: 'flex', flexDirection: 'column', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--line-2)', boxShadow: 'var(--shadow-1)' } },
          h('button', { type: 'button', 'data-chip': '', onClick: () => this.zoomBy(1.25), 'aria-label': 'Zoom in', style: tool }, '+'),
          h('button', { type: 'button', 'data-chip': '', onClick: () => this.zoomBy(0.8), 'aria-label': 'Zoom out', style: tool }, '−'),
          h('button', { type: 'button', 'data-chip': '', onClick: () => this.fit(true), 'aria-label': 'Fit everything in view', title: 'Fit', style: { ...tool, borderBottom: 0, fontSize: 13 } }, '⤢')),
        w >= 640 && !sel ? h('p', { 'aria-hidden': true, style: { position: 'absolute', left: 12, bottom: 12, zIndex: 9, margin: 0, padding: '4px 8px', borderRadius: 6, background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 11.5, color: 'var(--ink-3)', pointerEvents: 'none' } }, 'Drag to move · Ctrl + scroll to zoom · Click a node to open or fold its links') : null,
        panel);
    }
  };
  return CanvasClass;
}

// ctx: { L, D, focus, people, select(k), setPeople(bool), narrow }
export function focusView(ctx) {
  const { D } = ctx, R = D.rel, nameOf = (k) => R.actors[k] || R.short[k] || k;
  const key = ctx.people ? 'p' : 'n';
  D._adj = D._adj || {};
  if (!D._adj.all) { const a = {}; D.edges.forEach((e) => { (a[e.from] = a[e.from] || []).push({ o: e.to, e }); (a[e.to] = a[e.to] || []).push({ o: e.from, e }); }); D._adj.all = a; }
  if (!D._adj[key]) { const a = {}; Object.entries(D._adj.all).forEach(([k, list]) => { if (!ctx.people && R.actors[k]) return; a[k] = ctx.people ? list : list.filter((x) => !R.actors[x.o]); }); D._adj[key] = a; }
  const adj = D._adj[key], data = focusData(D, ctx.focus, { people: ctx.people, depth: null });
  const direct = new Set((adj[ctx.focus] || []).map((x) => x.o)).size;
  const label = { fontSize: 'calc(12.5px*var(--fs))', fontWeight: 650, color: 'var(--ink-3)' };
  const opts = Object.keys(D._adj.all).filter((k) => ctx.people || !R.actors[k] || k === ctx.focus).sort((a, b) => (!!R.actors[a] - !!R.actors[b]) || nameOf(a).localeCompare(nameOf(b)));
  return h('div', null,
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'flex-end', marginBottom: 10 } },
      h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, ...label, flex: '1 1 260px', minWidth: 0, maxWidth: 440 } }, 'Start from',
        h('select', { value: ctx.focus, onChange: (e) => ctx.select(e.target.value), style: { height: 'calc(40px*var(--hs))', padding: '0 10px', borderRadius: 'var(--r)', border: '1px solid var(--line-2)', background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', fontSize: 'calc(14.5px*var(--fs))', fontWeight: 600, maxWidth: '100%' } },
          ...opts.map((k) => h('option', { key: k, value: k }, nameOf(k) + (R.actors[k] ? ' (person or group)' : ''))))),
      h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 'calc(40px*var(--hs))', fontSize: 'calc(13.5px*var(--fs))', fontWeight: 600, color: 'var(--ink-2)', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: !!ctx.people, onChange: (e) => ctx.setPeople(e.target.checked), style: { width: 16, height: 16, accentColor: 'var(--accent-ink)', margin: 0 } }), 'Show people and groups')),
    h('p', { style: { margin: '0 0 14px', fontSize: 'calc(13.5px*var(--fs))', color: 'var(--ink-2)', maxWidth: 780 } },
      h('strong', { style: { color: 'var(--ink)' } }, nameOf(ctx.focus)), ` links directly to ${direct} ${direct === 1 ? 'item' : 'items'}, and through them to ${data.n} in all. The number on a node is how many more links it has: ${ctx.narrow ? 'tap' : 'click'} it to open them around it, and again to fold them.`),
    direct === 0 ? h('div', { role: 'status', style: { padding: 28, borderRadius: 'var(--r)', border: '1px dashed var(--line-2)', textAlign: 'center', color: 'var(--ink-2)' } }, 'Nothing else in the tracker links to this item.') :
      h(canvasClass(), { ctx: { ...ctx, allAdj: D._adj.all, height: ctx.narrow ? '70vh' : 'min(72vh, 700px)' }, root: ctx.focus, adj }),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12, fontSize: 'calc(12.5px*var(--fs))', color: 'var(--ink-3)' } },
      ...FOCUS_TYPE_ORDER.filter((t) => t !== 'actor' || ctx.people).map((t) => h('span', { key: t, style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h('span', { 'aria-hidden': true, style: { width: 16, height: 3, borderRadius: 2, background: TYPE_COLOR[t] } }), FOCUS_TYPE_SHORT[t])),
      h('span', null, 'Dashed: link the tracker marks as unproven, or a person or group.')));
}
