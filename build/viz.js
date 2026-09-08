// Timeline tab. Reads window.VIZ (events extracted at build time from the tracker's
// date cells) and draws three linked SVG charts plus a table view. No library.
(function(){
  var V = window.VIZ; if (!V) return;
  var root = document.getElementById('sec-timeline'); if (!root) return;
  var TYPES = V.types, COLORS = V.colors;
  var events = V.events.map(function(e){ e.t = Date.UTC(+e.date.slice(0,4), +e.date.slice(5,7)-1, +e.date.slice(8,10)); return e; });
  var entries = V.entries; // {id:{title, section, group, sectionName}}
  var enabled = {}; TYPES.forEach(function(t){ enabled[t] = true; });
  var PRESETS = [
    { key:'active', label:'Jan 2025 – Dec 2026', from:Date.UTC(2025,0,1), to:Date.UTC(2026,11,31) },
    { key:'y2024', label:'2024', from:Date.UTC(2024,0,1), to:Date.UTC(2024,11,31) },
    { key:'y2025', label:'2025', from:Date.UTC(2025,0,1), to:Date.UTC(2025,11,31) },
    { key:'y2026', label:'2026', from:Date.UTC(2026,0,1), to:Date.UTC(2026,11,31) },
    { key:'wide', label:'2023 – 2028', from:Date.UTC(2023,0,1), to:Date.UTC(2028,11,31) },
    { key:'all', label:'All dates', from:Math.min.apply(null, events.map(function(e){return e.t;})) - 864e5*20, to:Math.max.apply(null, events.map(function(e){return e.t;})) + 864e5*40 }
  ];
  var range = PRESETS[0], cursor = null, playing = false, rendered = false;
  var $ = function(s, el){ return (el||root).querySelector(s); };
  var fmt = function(t, p){ var d = new Date(t); var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; return p==='month' ? m+' '+d.getUTCFullYear() : m+' '+d.getUTCDate()+', '+d.getUTCFullYear(); };
  var svgNS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent){ var n = document.createElementNS(svgNS, name); for (var k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
  function txt(node, s){ node.textContent = s; return node; }

  // ---- controls ----
  var ctl = $('.viz-controls');
  var presetBox = $('.viz-presets'); PRESETS.forEach(function(p){ var b = document.createElement('button'); b.type='button'; b.textContent = p.label; b.dataset.key = p.key; if (p===range) b.setAttribute('aria-pressed','true'); b.addEventListener('click', function(){ range = p; cursor = null; stop(); presetBox.querySelectorAll('button').forEach(function(x){ x.setAttribute('aria-pressed', x===b?'true':'false'); }); render(); }); presetBox.appendChild(b); });
  var legend = $('.viz-legend'); TYPES.forEach(function(t, i){ var b = document.createElement('button'); b.type='button'; b.className='lg'; b.setAttribute('aria-pressed','true'); var sw = document.createElement('i'); sw.style.background = COLORS[i]; b.appendChild(sw); b.appendChild(document.createTextNode(t)); b.addEventListener('click', function(){ enabled[t] = !enabled[t]; b.setAttribute('aria-pressed', enabled[t]?'true':'false'); render(); }); legend.appendChild(b); });
  var playBtn = $('#viz-play'), cursorLabel = $('#viz-cursor');
  playBtn.addEventListener('click', function(){ if (playing) stop(); else play(); });
  $('#viz-reset').addEventListener('click', function(){ stop(); cursor = null; render(); });
  var tableBtn = $('#viz-table-toggle'), tableBox = $('.viz-table');
  tableBtn.addEventListener('click', function(){ var open = tableBox.hidden; tableBox.hidden = !open; tableBtn.setAttribute('aria-expanded', open?'true':'false'); tableBtn.textContent = open ? 'Hide table view' : 'Show table view'; });

  // ---- tooltip ----
  var tip = $('.viz-tip');
  function showTip(x, y, rows){ tip.innerHTML=''; rows.forEach(function(r){ var d = document.createElement('div'); d.className = 'tr ' + (r.cls||''); if (r.color){ var k = document.createElement('i'); k.style.background = r.color; d.appendChild(k); } var s = document.createElement('span'); s.textContent = r.text; d.appendChild(s); tip.appendChild(d); }); tip.hidden=false; var rect = root.getBoundingClientRect(); var px = x - rect.left + 14, py = y - rect.top + 14; if (px + 380 > rect.width) px = x - rect.left - 394; tip.style.left = px+'px'; tip.style.top = py+'px'; }
  function hideTip(){ tip.hidden = true; }
  function eventTip(e, x, y){ var en = entries[e.id]; showTip(x, y, [
    { text: fmt(e.t, e.precision) + (e.inferredYear ? ' (year inferred from the same cell)' : '') + (e.precision==='month' ? ' (month only)' : ''), cls:'v' },
    { text: e.type, color: COLORS[TYPES.indexOf(e.type)], cls:'k' },
    { text: en.title, cls:'t' },
    { text: en.section + ' · column “' + e.column + '”', cls:'m' },
    { text: e.clause, cls:'q' } ]); }

  // ---- derived data ----
  function visible(){ return events.filter(function(e){ return enabled[e.type] && e.t >= range.from && e.t <= range.to && (cursor===null || e.t <= cursor); }); }
  function inRangeAll(){ return events.filter(function(e){ return enabled[e.type] && e.t >= range.from && e.t <= range.to; }); }

  // ---- stats ----
  function renderStats(){ var vis = visible(), ids = {}; vis.forEach(function(e){ ids[e.id]=1; }); var enacted = {}; vis.forEach(function(e){ if (e.type==='Signed / enacted') enacted[e.id]=1; }); var eff = {}; vis.forEach(function(e){ if (e.type==='Effective') eff[e.id]=1; });
    $('#st-events').textContent = vis.length; $('#st-entries').textContent = Object.keys(ids).length; $('#st-enacted').textContent = Object.keys(enacted).length; $('#st-effective').textContent = Object.keys(eff).length;
    var outside = events.filter(function(e){ return enabled[e.type] && (e.t < range.from || e.t > range.to); }).length;
    $('#st-note').textContent = (cursor!==null ? 'As of ' + fmt(cursor,'day') + '. ' : '') + (outside ? outside + ' event' + (outside===1?'':'s') + ' outside this range.' : 'All events in range.'); }

  // ---- chart 1: lifecycles ----
  function renderTimeline(){
    var host = $('#viz-timeline'); host.innerHTML = '';
    var all = inRangeAll(); var vis = visible();
    var byId = {}; all.forEach(function(e){ (byId[e.id] = byId[e.id] || []).push(e); });
    var groups = {}; Object.keys(byId).forEach(function(id){ var en = entries[id]; (groups[en.section] = groups[en.section] || { name: en.sectionName, label: en.section, ids: [] }).ids.push(id); });
    var order = V.sectionOrder.filter(function(s){ return groups[s]; });
    var W = host.clientWidth || 900, L = Math.min(300, Math.max(200, W*0.3)), R = 24, rowH = 26, headH = 30, top = 34, bottom = 28;
    var rows = []; order.forEach(function(s){ rows.push({ head: groups[s] }); groups[s].ids.sort(function(a,b){ return byId[a][0].t - byId[b][0].t; }).forEach(function(id){ rows.push({ id: id }); }); });
    var H = top + rows.reduce(function(h, r){ return h + (r.head ? headH : rowH); }, 0) + bottom;
    var svg = el('svg', { viewBox: '0 0 '+W+' '+H, width: W, height: H, class: 'tl', role:'img', 'aria-label':'Lifecycle timeline of every instrument' }, host);
    var x = function(t){ return L + (t - range.from) / (range.to - range.from) * (W - L - R); };
    // month/year grid
    var d = new Date(range.from); d = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); var span = range.to - range.from; var stepMonths = span > 4*365*864e5 ? 6 : span > 2*365*864e5 ? 3 : 1;
    for (var t = d; t <= range.to; ){ var dt = new Date(t); if (dt.getUTCMonth() % stepMonths === 0 && t >= range.from){ var isYear = dt.getUTCMonth()===0; el('line', { x1:x(t), x2:x(t), y1: top-8, y2: H-bottom, class: isYear ? 'grid year' : 'grid' }, svg); txt(el('text', { x:x(t), y: top-14, class:'ax' + (isYear?' year':'') }, svg), isYear ? String(dt.getUTCFullYear()) : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()]); } t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth()+1, 1); }
    // rows
    var y = top;
    rows.forEach(function(r){
      if (r.head){ var g = el('g', { class:'rowhead' }, svg); el('rect', { x:0, y:y+4, width:W, height:headH-6, class:'headbg' }, g); txt(el('text', { x:8, y:y+headH/2+5, class:'headlbl' }, g), r.head.label); txt(el('text', { x:44, y:y+headH/2+5, class:'headname' }, g), r.head.name); y += headH; return; }
      var evs = byId[r.id], en = entries[r.id]; var cy = y + rowH/2;
      var g = el('g', { class:'row', 'data-id': r.id }, svg);
      el('rect', { x:0, y:y, width:W, height:rowH, class:'rowbg' }, g);
      var a = document.createElementNS(svgNS, 'a'); a.setAttribute('href', '#'+r.id); a.setAttribute('class','rowlink'); g.appendChild(a);
      var label = en.title.length > 42 ? en.title.slice(0, 40).trimEnd()+'…' : en.title; txt(el('text', { x:L-10, y:cy+4, class:'rowlbl', 'text-anchor':'end' }, a), label);
      var shown = evs.filter(function(e){ return cursor===null || e.t <= cursor; });
      if (shown.length > 1) el('line', { x1:x(shown[0].t), x2:x(shown[shown.length-1].t), y1:cy, y2:cy, class:'life' }, g);
      evs.forEach(function(e){ var on = cursor===null || e.t <= cursor; var c = COLORS[TYPES.indexOf(e.type)]; var dot = el('g', { class:'dot' + (on?'':' off'), transform:'translate('+x(e.t)+','+cy+')' }, g); el('circle', { r:12, class:'hit' }, dot); el('circle', { r:5.5, fill:c, class:'mark' + (e.precision==='month'?' approx':'') }, dot); dot.addEventListener('pointermove', function(ev){ eventTip(e, ev.clientX, ev.clientY); }); dot.addEventListener('pointerleave', hideTip); dot.setAttribute('tabindex','0'); dot.addEventListener('focus', function(){ var b = dot.getBoundingClientRect(); eventTip(e, b.left+b.width/2, b.top+b.height/2); }); dot.addEventListener('blur', hideTip); });
      y += rowH;
    });
    // cursor line
    if (cursor !== null){ el('line', { x1:x(cursor), x2:x(cursor), y1: top-8, y2: H-bottom, class:'cursor' }, svg); }
    // crosshair
    var hair = el('line', { x1:0, x2:0, y1: top-8, y2: H-bottom, class:'hair' , visibility:'hidden'}, svg); var hairLbl = txt(el('text', { x:0, y:H-8, class:'hairlbl', visibility:'hidden' }, svg), '');
    svg.addEventListener('pointermove', function(ev){ var b = svg.getBoundingClientRect(); var px = (ev.clientX - b.left) * (W / b.width); if (px < L){ hair.setAttribute('visibility','hidden'); hairLbl.setAttribute('visibility','hidden'); return; } var t = range.from + (px - L)/(W-L-R)*(range.to-range.from); hair.setAttribute('x1',px); hair.setAttribute('x2',px); hair.setAttribute('visibility','visible'); hairLbl.setAttribute('x', Math.min(px, W-70)); hairLbl.setAttribute('visibility','visible'); hairLbl.textContent = fmt(t,'day'); });
    svg.addEventListener('pointerleave', function(){ hair.setAttribute('visibility','hidden'); hairLbl.setAttribute('visibility','hidden'); });
  }

  // ---- chart 2: monthly stacked bars ----
  function renderBars(){
    var host = $('#viz-bars'); host.innerHTML = '';
    var all = inRangeAll();
    var months = []; var d0 = new Date(range.from); for (var t = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1); t <= range.to; ){ months.push(t); var dt = new Date(t); t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth()+1, 1); }
    var idx = {}; months.forEach(function(m, i){ idx[m] = i; });
    var counts = months.map(function(){ return TYPES.map(function(){ return []; }); });
    all.forEach(function(e){ var dt = new Date(e.t); var m = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1); if (idx[m]!==undefined) counts[idx[m]][TYPES.indexOf(e.type)].push(e); });
    var W = host.clientWidth || 900, H = 260, L = 36, R = 12, top = 18, bottom = 40;
    var max = Math.max(1, Math.max.apply(null, counts.map(function(c){ return c.reduce(function(s, a){ return s + a.length; }, 0); })));
    var svg = el('svg', { viewBox:'0 0 '+W+' '+H, width:W, height:H, class:'bars', role:'img', 'aria-label':'Events per month by type' }, host);
    var bw = (W - L - R) / months.length, gap = Math.min(6, bw*0.25);
    var y = function(v){ return top + (H - top - bottom) * (1 - v/max); };
    [0, Math.ceil(max/2), max].forEach(function(v){ el('line', { x1:L, x2:W-R, y1:y(v), y2:y(v), class:'grid' }, svg); txt(el('text', { x:L-8, y:y(v)+4, class:'ax', 'text-anchor':'end' }, svg), String(v)); });
    months.forEach(function(m, i){ var dt = new Date(m); var x0 = L + i*bw + gap/2; var acc = 0; var total = counts[i].reduce(function(s,a){ return s+a.length; }, 0);
      var isJan = dt.getUTCMonth()===0; if (months.length <= 30 || isJan || dt.getUTCMonth()%6===0) txt(el('text', { x:x0+ (bw-gap)/2, y:H-bottom+16, class:'ax' + (isJan?' year':''), 'text-anchor':'middle' }, svg), isJan ? String(dt.getUTCFullYear()) : (months.length <= 30 ? ['J','F','M','A','M','J','J','A','S','O','N','D'][dt.getUTCMonth()] : ''));
      var reveal = cursor===null ? 1 : (m > cursor ? 0 : 1);
      counts[i].forEach(function(list, k){ if (!list.length) return; var shown = cursor===null ? list : list.filter(function(e){ return e.t <= cursor; }); var h = (y(0) - y(shown.length)); var r = el('rect', { x:x0, y:y(acc + shown.length), width: Math.max(1, bw-gap), height: Math.max(0, h - (h>2?2:0)), fill: COLORS[k], class:'seg', rx: 2 }, svg); acc += shown.length; r.addEventListener('pointermove', function(ev){ showTip(ev.clientX, ev.clientY, [{ text: shown.length + (shown.length===1?' event':' events') + ' · ' + TYPES[k], color: COLORS[k], cls:'v' }, { text: fmt(m,'month') + ' · ' + total + ' in month', cls:'m' }].concat(shown.slice(0,6).map(function(e){ return { text: '• ' + entries[e.id].title, cls:'t' }; })).concat(shown.length > 6 ? [{ text: '… and ' + (shown.length-6) + ' more', cls:'m' }] : [])); }); r.addEventListener('pointerleave', hideTip); });
    });
  }

  // ---- chart 3: cumulative instruments ----
  function renderCum(){
    var host = $('#viz-cum'); host.innerHTML = '';
    var all = inRangeAll().slice().sort(function(a,b){ return a.t-b.t; });
    var seen = {}, pts = []; all.forEach(function(e){ if (!seen[e.id]){ seen[e.id]=1; pts.push({ t:e.t, n:Object.keys(seen).length, id:e.id, e:e }); } });
    var W = host.clientWidth || 900, H = 220, L = 36, R = 12, top = 18, bottom = 34;
    var svg = el('svg', { viewBox:'0 0 '+W+' '+H, width:W, height:H, class:'cum', role:'img', 'aria-label':'Instruments with at least one dated event, cumulative' }, host);
    var x = function(t){ return L + (t - range.from)/(range.to-range.from)*(W-L-R); }; var max = Math.max(1, pts.length); var y = function(v){ return top + (H-top-bottom)*(1 - v/max); };
    [0, Math.ceil(max/2), max].forEach(function(v){ el('line', { x1:L, x2:W-R, y1:y(v), y2:y(v), class:'grid' }, svg); txt(el('text', { x:L-8, y:y(v)+4, class:'ax', 'text-anchor':'end' }, svg), String(v)); });
    var d = new Date(range.from); for (var t = Date.UTC(d.getUTCFullYear(), 0, 1); t <= range.to; t = Date.UTC(new Date(t).getUTCFullYear()+1, 0, 1)) if (t >= range.from) txt(el('text', { x:x(t), y:H-bottom+16, class:'ax year', 'text-anchor':'middle' }, svg), String(new Date(t).getUTCFullYear()));
    var shown = pts.filter(function(p){ return cursor===null || p.t <= cursor; });
    if (shown.length){ var path = 'M'+x(range.from)+' '+y(0); var prev = 0; shown.forEach(function(p){ path += ' H'+x(p.t)+' V'+y(p.n); prev = p.n; }); var endT = cursor===null ? range.to : cursor; path += ' H'+x(endT); var area = el('path', { d: path + ' V'+y(0)+' Z', class:'area' }, svg); var line = el('path', { d: path, class:'line' }, svg); var last = shown[shown.length-1]; el('circle', { cx:x(endT), cy:y(last.n), r:5, class:'end' }, svg); txt(el('text', { x:Math.min(x(endT)+8, W-30), y:y(last.n)-8, class:'endlbl' }, svg), last.n + ' instruments'); }
    var hair = el('line', { x1:0, x2:0, y1:top, y2:H-bottom, class:'hair', visibility:'hidden' }, svg);
    svg.addEventListener('pointermove', function(ev){ var b = svg.getBoundingClientRect(); var px = (ev.clientX-b.left)*(W/b.width); if (px < L) return; var t = range.from + (px-L)/(W-L-R)*(range.to-range.from); hair.setAttribute('x1',px); hair.setAttribute('x2',px); hair.setAttribute('visibility','visible'); var n = 0, lastP = null; shown.forEach(function(p){ if (p.t <= t){ n = p.n; lastP = p; } }); showTip(ev.clientX, ev.clientY, [{ text: n + ' instruments with a dated event by ' + fmt(t,'month'), cls:'v' }].concat(lastP ? [{ text: 'Most recent added: ' + entries[lastP.id].title + ' (' + fmt(lastP.t, lastP.e.precision) + ')', cls:'t' }] : [])); });
    svg.addEventListener('pointerleave', function(){ hair.setAttribute('visibility','hidden'); hideTip(); });
  }

  // ---- table view ----
  function renderTable(){ var tb = $('.viz-table tbody'); tb.innerHTML=''; inRangeAll().forEach(function(e){ var tr = document.createElement('tr'); [fmt(e.t, e.precision) + (e.inferredYear?' *':''), entries[e.id].section, entries[e.id].title, e.type, e.column, e.clause].forEach(function(v, i){ var td = document.createElement('td'); if (i===2){ var a = document.createElement('a'); a.href = '#'+e.id; a.textContent = v; td.appendChild(a); } else td.textContent = v; tr.appendChild(td); }); tb.appendChild(tr); }); }

  // ---- play ----
  var raf = null;
  function play(){ playing = true; playBtn.textContent = 'Pause'; playBtn.setAttribute('aria-pressed','true'); var start = performance.now(); var from = cursor===null || cursor >= range.to ? range.from : cursor; var dur = 14000 * (range.to - from)/(range.to - range.from);
    function step(now){ var k = Math.min(1, (now-start)/dur); cursor = from + k*(range.to-from); renderCharts(false); if (k < 1 && playing) raf = requestAnimationFrame(step); else { stop(); } }
    raf = requestAnimationFrame(step); }
  function stop(){ playing = false; playBtn.textContent = 'Play the timeline'; playBtn.setAttribute('aria-pressed','false'); if (raf) cancelAnimationFrame(raf); raf = null; }

  function renderCharts(withTable){ renderStats(); renderTimeline(); renderBars(); renderCum(); if (withTable!==false) renderTable(); cursorLabel.textContent = cursor===null ? 'Showing every event in range' : 'As of ' + fmt(cursor,'day'); }
  function render(){ renderCharts(true); rendered = true; }

  // render when the tab becomes visible; re-render on resize
  var pending = false;
  function maybeRender(){ if (root.hidden || root.offsetParent===null) return; if (!rendered) render(); }
  new MutationObserver(maybeRender).observe(root, { attributes:true, attributeFilter:['hidden'] });
  window.addEventListener('resize', function(){ if (pending) return; pending = true; setTimeout(function(){ pending = false; if (rendered && !root.hidden) renderCharts(false); }, 150); });
  maybeRender();
})();
