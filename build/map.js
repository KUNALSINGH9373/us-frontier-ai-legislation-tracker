// Map tab. Reads window.MAP (nodes, edges, types, columns) and draws a layered
// relationship map: HTML node cards over an SVG edge layer. Click a node to
// focus on it and its neighbours; click an edge for the tracker clause it comes
// from. No library.
(function(){
  var M = window.MAP; if (!M) return;
  var root = document.getElementById('sec-map'); if (!root) return;
  var $ = function(s, el){ return (el||root).querySelector(s); };
  var wrap = $('.map-wrap'), stage = $('.map-stage'), svg = $('.map-svg'), layer = $('.map-nodes'), tip = $('.map-tip'), panel = $('.map-panel');
  var W = 212, GAP = 12, COLGAP = 78, PAD = 16, HEAD = 34;
  var LENSES = { all: null, lineage: ['template','succession','assurance'], fedstate: ['fedstate','executive','litigation'], actors: ['actor'] };
  var lens = 'all', enabled = {}; Object.keys(M.types).forEach(function(t){ enabled[t] = true; });
  var focus = null, selected = null, pinned = null, year = 'all', fit = true;
  var byId = {}; M.nodes.forEach(function(n){ byId[n.id] = n; });
  var svgNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent){ var n = document.createElementNS(svgNS, name); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
  function yearOk(n){ if (year === 'all' || n.kind === 'actor') return true; return (n.years||[]).indexOf(year) >= 0; }

  // ---- controls ----
  var lensBox = $('.map-lenses'); [].slice.call(lensBox.querySelectorAll('button')).forEach(function(b){ b.addEventListener('click', function(){ lens = b.dataset.lens; [].slice.call(lensBox.querySelectorAll('button')).forEach(function(x){ x.setAttribute('aria-pressed', x===b?'true':'false'); }); render(); }); });
  var legend = $('.map-legend'); Object.keys(M.types).forEach(function(t){ var b = document.createElement('button'); b.type='button'; b.className='lg'; b.setAttribute('aria-pressed','true'); var sw = document.createElement('i'); sw.style.background = M.types[t].color; b.appendChild(sw); b.appendChild(document.createTextNode(M.types[t].name)); b.addEventListener('click', function(){ enabled[t] = !enabled[t]; b.setAttribute('aria-pressed', enabled[t]?'true':'false'); render(); }); legend.appendChild(b); });
  $('#map-full').addEventListener('click', function(){ focus = null; selected = null; pinned = null; render(); });
  $('#map-fit').addEventListener('click', function(){ fit = !fit; $('#map-fit').setAttribute('aria-pressed', fit?'true':'false'); render(); });
  var tblBtn = $('#map-table-toggle'), tbl = $('.map-table'); tblBtn.addEventListener('click', function(){ var open = tbl.hidden; tbl.hidden = !open; tblBtn.setAttribute('aria-expanded', open?'true':'false'); tblBtn.textContent = open ? 'Hide edge table' : 'Show all relationships as a table'; });
  var search = $('#map-q'); search.addEventListener('change', function(){ var v = search.value.trim().toLowerCase(); if (!v) return; var hit = M.nodes.filter(function(n){ return (n.short+' '+(n.title||'')).toLowerCase().indexOf(v) !== -1; })[0]; if (hit){ selected = hit.id; pinned = null; render(); } });
  search.addEventListener('keydown', function(e){ if (e.key==='Enter'){ e.preventDefault(); search.dispatchEvent(new Event('change')); } });

  // ---- data for current view ----
  function activeTypes(){ var lt = LENSES[lens]; return Object.keys(M.types).filter(function(t){ return enabled[t] && (!lt || lt.indexOf(t) >= 0); }); }
  function view(){
    var types = activeTypes();
    var edges = M.edges.filter(function(e){ return types.indexOf(e.type) >= 0; });
    var nodes;
    if (focus){ var keep = {}; keep[focus] = 1; edges.forEach(function(e){ if (e.from === focus || e.to === focus){ keep[e.from] = 1; keep[e.to] = 1; } }); edges = edges.filter(function(e){ return e.from === focus || e.to === focus; }); nodes = M.nodes.filter(function(n){ return keep[n.id]; }); }
    else if (lens === 'all'){ nodes = M.nodes.slice(); }
    else { var used = {}; edges.forEach(function(e){ used[e.from] = 1; used[e.to] = 1; }); nodes = M.nodes.filter(function(n){ return used[n.id]; }); }
    return { nodes: nodes, edges: edges };
  }

  // ---- layout ----
  function layout(v){
    var cols = M.columns.map(function(){ return []; });
    v.nodes.forEach(function(n){ cols[n.col].push(n); });
    var pos = {}; cols.forEach(function(c){ c.forEach(function(n, i){ pos[n.id] = i; }); });
    var nb = {}; v.edges.forEach(function(e){ (nb[e.from] = nb[e.from] || []).push(e.to); (nb[e.to] = nb[e.to] || []).push(e.from); });
    for (var it = 0; it < 6; it++){
      cols.forEach(function(c){
        c.forEach(function(n){ var ns = (nb[n.id]||[]).filter(function(id){ return pos[id] !== undefined; }); n._b = ns.length ? ns.reduce(function(s, id){ return s + pos[id]; }, 0)/ns.length : pos[n.id]; });
        c.sort(function(a, b){ return a._b - b._b || a.order - b.order; });
        c.forEach(function(n, i){ pos[n.id] = i; });
      });
    }
    // measure heights
    layer.innerHTML = '';
    var cards = {};
    v.nodes.forEach(function(n){ var d = document.createElement('div'); d.className = 'map-node kind-' + n.kind + (yearOk(n) ? '' : ' offyear') + (n.id === selected || n.id === focus ? ' focus' : ''); d.dataset.id = n.id; d.style.width = W + 'px';
      var t = document.createElement('div'); t.className = 'nt'; t.textContent = n.short; d.appendChild(t);
      var s = document.createElement('div'); s.className = 'ns'; s.textContent = n.kind === 'actor' ? 'Actor' : (n.section ? 'Section ' + n.section + (n.juris ? ' · ' + n.juris : '') : ''); if (n.status){ var st = document.createElement('b'); st.textContent = ' ' + n.status; s.appendChild(st); } d.appendChild(s);
      d.setAttribute('tabindex', '0'); d.setAttribute('role', 'button'); d.setAttribute('aria-label', n.short + '. Focus on this node.');
      layer.appendChild(d); cards[n.id] = d; });
    var heights = {}; v.nodes.forEach(function(n){ heights[n.id] = cards[n.id].offsetHeight; });
    var colH = cols.map(function(c){ return c.reduce(function(s, n){ return s + heights[n.id] + GAP; }, 0) - GAP; });
    var H = Math.max.apply(null, colH.concat([200])) + HEAD + PAD*2;
    // empty columns collapse (focus mode and narrow lenses), so the drawing uses only the columns in play
    var slot = {}, k = 0; cols.forEach(function(c, ci){ if (c.length){ slot[ci] = k++; } });
    var xy = {};
    cols.forEach(function(c, ci){ var y = HEAD + PAD + (H - HEAD - PAD*2 - colH[ci]) / 2; c.forEach(function(n){ var x = PAD + slot[ci] * (W + COLGAP); xy[n.id] = { x: x, y: y, h: heights[n.id] }; cards[n.id].style.left = x + 'px'; cards[n.id].style.top = y + 'px'; y += heights[n.id] + GAP; }); });
    var totalW = PAD*2 + k * W + Math.max(0, k - 1) * COLGAP;
    return { xy: xy, cards: cards, W: totalW, H: H, cols: cols, slot: slot };
  }

  // ---- draw ----
  function render(){
    var v = view();
    var L = layout(v);
    stage.style.width = L.W + 'px'; stage.style.height = L.H + 'px';
    svg.setAttribute('viewBox', '0 0 ' + L.W + ' ' + L.H); svg.setAttribute('width', L.W); svg.setAttribute('height', L.H); svg.innerHTML = '';
    var defs = el('defs', {}, svg); Object.keys(M.types).forEach(function(t){ var mk = el('marker', { id: 'arr-' + t, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs); el('path', { d: 'M0 0 L10 5 L0 10 z', fill: M.types[t].color }, mk); });
    // column headers
    M.columns.forEach(function(name, ci){ if (L.slot[ci] === undefined) return; var x = PAD + L.slot[ci] * (W + COLGAP); var g = el('g', { class: 'colhead' }, svg); el('rect', { x: x, y: PAD - 6, width: W, height: 24, rx: 6, class: 'colbg' }, g); var tx = el('text', { x: x + W/2, y: PAD + 10, class: 'coltx', 'text-anchor': 'middle' }, g); tx.textContent = name; });
    // edges
    var edgeEls = [];
    v.edges.forEach(function(e, i){ var a = L.xy[e.from], b = L.xy[e.to]; if (!a || !b) return; var ca = L.slot[byId[e.from].col], cb = L.slot[byId[e.to].col]; var x1, x2, y1 = a.y + a.h/2, y2 = b.y + b.h/2, d;
      if (cb > ca){ x1 = a.x + W; x2 = b.x; var mx = (x1 + x2)/2; d = 'M'+x1+' '+y1+' C'+mx+' '+y1+' '+mx+' '+y2+' '+x2+' '+y2; }
      else if (cb < ca){ x1 = a.x; x2 = b.x + W; var mx2 = (x1 + x2)/2; d = 'M'+x1+' '+y1+' C'+mx2+' '+y1+' '+mx2+' '+y2+' '+x2+' '+y2; }
      else { x1 = a.x + W; x2 = b.x + W; var off = 60 + Math.abs(y2 - y1) * 0.08; d = 'M'+x1+' '+y1+' C'+(x1+off)+' '+y1+' '+(x2+off)+' '+y2+' '+x2+' '+y2; }
      var p = el('path', { d: d, class: 'edge' + (e.dashed ? ' dashed' : '') + (lens === 'all' && !focus && e.type === 'actor' ? ' faint' : ''), stroke: M.types[e.type].color, 'marker-end': 'url(#arr-' + e.type + ')', 'data-i': i }, svg);
      var hit = el('path', { d: d, class: 'edgehit', 'data-i': i }, svg);
      hit.addEventListener('pointermove', function(ev){ if (pinned === null) showEdgeTip(e, ev.clientX, ev.clientY, false); highlight(null, e); });
      hit.addEventListener('pointerleave', function(){ if (pinned === null) hideTip(); highlight(selected, null); });
      hit.addEventListener('click', function(ev){ ev.stopPropagation(); pinned = e; showEdgeTip(e, ev.clientX, ev.clientY, true); });
      edgeEls.push({ e: e, p: p });
      if (focus && v.edges.length <= 10){ var lx = (x1 + x2)/2, ly = (y1 + y2)/2 - 6; var lab = document.createElement('div'); lab.className = 'map-elabel'; lab.style.left = lx + 'px'; lab.style.top = ly + 'px'; lab.style.borderColor = M.types[e.type].color; lab.textContent = e.label; layer.appendChild(lab); }
    });
    // node interactions
    Object.keys(L.cards).forEach(function(id){ var d = L.cards[id];
      d.addEventListener('pointerenter', function(){ highlight(id, null); });
      d.addEventListener('pointerleave', function(){ highlight(selected, null); });
      d.addEventListener('click', function(ev){ ev.stopPropagation(); selected = (selected === id) ? null : id; pinned = null; hideTip(); render(); if (selected) setTimeout(function(){ panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 50); });
      d.addEventListener('keydown', function(ev){ if (ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); d.click(); } });
    });
    function highlight(nodeId, edge){ var conn = {}; if (nodeId){ conn[nodeId] = 1; v.edges.forEach(function(e){ if (e.from === nodeId || e.to === nodeId){ conn[e.from] = 1; conn[e.to] = 1; } }); } if (edge){ conn[edge.from] = 1; conn[edge.to] = 1; }
      var on = nodeId || edge; Object.keys(L.cards).forEach(function(id){ L.cards[id].classList.toggle('dim', !!on && !conn[id]); });
      edgeEls.forEach(function(x){ var keep = edge ? x.e === edge : (nodeId ? (x.e.from === nodeId || x.e.to === nodeId) : true); x.p.classList.toggle('dim', !!on && !keep); x.p.classList.toggle('hot', !!on && keep); }); }
    if (selected) highlight(selected, null);
    // panel
    renderPanel(v);
    // fit
    var avail = wrap.clientWidth - 2; var scale = fit ? Math.max(0.65, Math.min(1, avail / L.W)) : 1; stage.style.transform = 'scale(' + scale + ')'; stage.style.transformOrigin = '0 0'; wrap.style.height = (L.H * scale + 4) + 'px';
    $('#map-count').textContent = v.nodes.length + ' nodes · ' + v.edges.length + ' relationships' + (focus ? ' · isolated: ' + byId[focus].short : selected ? ' · selected: ' + byId[selected].short : '') + (year !== 'all' ? ' · instruments without a ' + (year==='2027+'?'2027 and later':year) + ' event are faded' : '');
    renderTable(v);
  }
  function renderPanel(v){
    panel.innerHTML = '';
    var id = selected || focus;
    if (!id){ panel.hidden = true; return; }
    var n = byId[id]; panel.hidden = false;
    var edges = M.edges.filter(function(e){ return (e.from === id || e.to === id) && activeTypes().indexOf(e.type) >= 0; });
    var head = document.createElement('div'); head.className = 'mp-head';
    var h = document.createElement('h3'); h.textContent = n.short; head.appendChild(h);
    var sub = document.createElement('p'); sub.className = 'mp-sub'; sub.textContent = n.kind === 'actor' ? 'Person or organisation named in the tracker' : (n.title || ''); head.appendChild(sub);
    var acts = document.createElement('div'); acts.className = 'mp-actions';
    if (n.kind !== 'actor'){ var open = document.createElement('a'); open.href = '#' + n.id; open.className = 'viz-btn primary'; open.textContent = 'Open the tracker entry'; acts.appendChild(open); }
    var iso = document.createElement('button'); iso.type = 'button'; iso.className = 'viz-btn'; iso.textContent = focus === id ? 'Show the full map again' : 'Isolate this node and its connections'; iso.addEventListener('click', function(){ if (focus === id){ focus = null; } else { focus = id; selected = id; } render(); }); acts.appendChild(iso);
    var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'viz-btn'; clr.textContent = 'Clear selection'; clr.addEventListener('click', function(){ selected = null; focus = null; render(); }); acts.appendChild(clr);
    head.appendChild(acts); panel.appendChild(head);
    if (n.kind !== 'actor'){ var facts = document.createElement('dl'); facts.className = 'mp-facts'; [['Section', n.section ? n.section + (n.sectionName ? ' · ' + n.sectionName : '') : ''], ['Jurisdiction', n.juris], ['Status class', n.status], ['Confidence', n.conf], ['Years with dated events', (n.years||[]).join(', ')]].forEach(function(kv){ if (!kv[1]) return; var w = document.createElement('div'); var dt = document.createElement('dt'); dt.textContent = kv[0]; var dd = document.createElement('dd'); dd.textContent = kv[1]; w.appendChild(dt); w.appendChild(dd); facts.appendChild(w); }); panel.appendChild(facts); }
    var count = document.createElement('p'); count.className = 'mp-count'; count.textContent = edges.length + (edges.length === 1 ? ' relationship' : ' relationships') + ' stated in the tracker' + (edges.length !== M.edges.filter(function(e){ return e.from === id || e.to === id; }).length ? ' (some types are hidden by the current lens or legend)' : ''); panel.appendChild(count);
    var byType = {}; edges.forEach(function(e){ (byType[e.type] = byType[e.type] || []).push(e); });
    Object.keys(M.types).forEach(function(t){ if (!byType[t]) return; var grp = document.createElement('div'); grp.className = 'mp-group'; var gh = document.createElement('h4'); var sw = document.createElement('i'); sw.style.background = M.types[t].color; gh.appendChild(sw); gh.appendChild(document.createTextNode(M.types[t].name)); grp.appendChild(gh); var ul = document.createElement('ul'); ul.className = 'mp-cards';
      byType[t].forEach(function(e){ var other = e.from === id ? e.to : e.from; var li = document.createElement('li'); li.className = 'mp-card' + (e.dashed ? ' qualified' : ''); li.style.borderTopColor = M.types[t].color;
        var dir = document.createElement('span'); dir.className = 'mp-dir'; dir.textContent = e.from === id ? 'to' : 'from'; li.appendChild(dir);
        var ob = document.createElement('button'); ob.type = 'button'; ob.className = 'mp-other'; ob.textContent = byId[other].short; ob.addEventListener('click', function(){ selected = other; if (focus) focus = other; render(); }); li.appendChild(ob);
        var lab = document.createElement('p'); lab.className = 'mp-label'; lab.textContent = e.label + (e.dashed ? ' · qualified by the tracker' : ''); li.appendChild(lab);
        var q = document.createElement('blockquote'); q.textContent = e.quote; li.appendChild(q);
        var src = document.createElement('a'); src.href = e.srcHref; src.className = 'mp-src'; src.textContent = 'Tracker: ' + e.srcLabel + ' · ' + e.col; li.appendChild(src);
        ul.appendChild(li); });
      grp.appendChild(ul); panel.appendChild(grp); });
  }
  function showEdgeTip(e, x, y, pin){ tip.innerHTML = ''; var rows = [ { t: e.label, cls: 'v', color: M.types[e.type].color }, { t: byId[e.from].short + ' → ' + byId[e.to].short, cls: 'k' }, { t: M.types[e.type].name + (e.dashed ? ' · qualified by the tracker' : ''), cls: 'm' }, { t: e.quote, cls: 'q' }, { t: 'Tracker: ' + e.srcLabel + ' · column “' + e.col + '”', cls: 'm' } ];
    rows.forEach(function(r){ var d = document.createElement('div'); d.className = 'tr ' + r.cls; if (r.color){ var i = document.createElement('i'); i.style.background = r.color; d.appendChild(i); } var s = document.createElement('span'); s.textContent = r.t; d.appendChild(s); tip.appendChild(d); });
    if (pin){ var a = document.createElement('a'); a.href = e.srcHref; a.textContent = 'Open the cited entry'; a.className = 'tl'; tip.appendChild(a); var c = document.createElement('button'); c.type = 'button'; c.className = 'tc'; c.textContent = 'Close'; c.addEventListener('click', function(){ pinned = null; hideTip(); }); tip.appendChild(c); }
    tip.hidden = false; var r = root.getBoundingClientRect(); var px = x - r.left + 14, py = y - r.top + 14; if (px + 400 > r.width) px = Math.max(8, x - r.left - 414); tip.style.left = px + 'px'; tip.style.top = py + 'px'; tip.style.pointerEvents = pin ? 'auto' : 'none'; }
  function hideTip(){ tip.hidden = true; }
  document.addEventListener('click', function(ev){ if (pinned !== null && !tip.contains(ev.target)){ pinned = null; hideTip(); } });
  function renderTable(v){ var tb = $('.map-table tbody'); tb.innerHTML = ''; v.edges.forEach(function(e){ var tr = document.createElement('tr'); [byId[e.from].short, e.type, byId[e.to].short, e.label + (e.dashed ? ' (qualified)' : ''), e.quote].forEach(function(val, i){ var td = document.createElement('td'); if (i === 1){ var sw = document.createElement('i'); sw.className = 'sw'; sw.style.background = M.types[e.type].color; td.appendChild(sw); td.appendChild(document.createTextNode(M.types[e.type].name)); } else td.textContent = val; tr.appendChild(td); }); var td = document.createElement('td'); var a = document.createElement('a'); a.href = e.srcHref; a.textContent = e.srcLabel + ' · ' + e.col; td.appendChild(a); tr.appendChild(td); tb.appendChild(tr); }); }

  // ---- year filter + visibility ----
  window.mapSetYear = function(y){ year = y || 'all'; if (rendered) render(); };
  var rendered = false;
  function maybe(){ if (root.hidden) return; if (!rendered){ var q = new URLSearchParams(location.search); year = q.get('year') || 'all'; var n = q.get('node'); if (n && byId[n]){ selected = n; if (q.get('isolate') === '1') focus = n; } render(); rendered = true; } }
  var origRender = render; render = function(){ origRender(); var q = new URLSearchParams(location.search); var nid = selected || focus; if (nid) q.set('node', nid); else q.delete('node'); if (focus) q.set('isolate', '1'); else q.delete('isolate'); var qs = q.toString(); history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash); };
  new MutationObserver(maybe).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  var t; window.addEventListener('resize', function(){ clearTimeout(t); t = setTimeout(function(){ if (rendered && !root.hidden) render(); }, 150); });
  maybe();
})();
