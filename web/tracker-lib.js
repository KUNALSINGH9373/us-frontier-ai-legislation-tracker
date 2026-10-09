// Data model + derivations for the tracker prototype. All values derive from data/*.json.
// Defaults for the v1 data; applySite() replaces them from site.json when the v2 data is loaded.
export let ASOF = new Date(2026, 8, 29), VERIFIED = new Date(2026, 8, 5);
export let WEEK_FROM = new Date(2026, 8, 23);
export let HC = { enacted: 3, pending: 5, stalled: 6, failed: 5, ivo: 6, fed: 10, exec: 10, lit: 9, total: 90, sources: 173, events: 178 };
export const SN = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming'};
export const GRID = [['AK',0,0],['ME',0,10],['WI',1,5],['VT',1,9],['NH',1,10],['WA',2,0],['ID',2,1],['MT',2,2],['ND',2,3],['MN',2,4],['IL',2,5],['MI',2,6],['NY',2,8],['MA',2,9],['OR',3,0],['NV',3,1],['WY',3,2],['SD',3,3],['IA',3,4],['IN',3,5],['OH',3,6],['PA',3,7],['NJ',3,8],['CT',3,9],['RI',3,10],['CA',4,0],['UT',4,1],['CO',4,2],['NE',4,3],['MO',4,4],['KY',4,5],['WV',4,6],['VA',4,7],['MD',4,8],['DE',4,9],['AZ',5,1],['NM',5,2],['KS',5,3],['AR',5,4],['TN',5,5],['NC',5,6],['SC',5,7],['DC',5,8],['OK',6,3],['LA',6,4],['MS',6,5],['AL',6,6],['GA',6,7],['HI',7,0],['TX',7,3],['FL',7,8]];
export const ST = {
  enacted:{l:'Enacted',g:'●'}, pending:{l:'Pending',g:'◐'}, stalled:{l:'Stalled',g:'‖'}, failed:{l:'Failed',g:'✕'},
  executive:{l:'Executive action',g:'▲'}, litigation:{l:'Litigation',g:'§'}, export:{l:'Export control',g:'⬢'}, excluded:{l:'Excluded',g:'○'}
};
export const STATUS_ORDER = ['enacted','pending','stalled','failed','executive','litigation','export','excluded'];
export const TYPES = {law:'Law',bill:'Bill',auditor:'Auditor licensing',draft:'Draft or proposal',executive:'Executive action',litigation:'Litigation',export:'Export control',precursor:'Earlier proposal',excluded:'Excluded'};
export let SEC = {A:'Enacted state frontier laws',B:'State frontier bills','B.2':'State catastrophic-risk bills without a compute threshold',C:'Auditor and verifier licensing',D:'Federal frontier bills',E:'Federal drafts and proposals',F:'Related federal bills',G:'Executive actions','G.2':'Lawsuits and enforcement','G.3':'Chips and export controls',H:'Earlier and withdrawn proposals',I:'Frontier provisions in broader laws',J:'Checked and excluded'};
export const BOARD = {enacted:'#2FD69E',pending:'#FFC23D',auditor:'#C89BFF',stalled:'#A9B4C7',failed:'#FF9B5E',executive:'#4FD4F0',litigation:'#FF8CC0',export:'#A9B6C8',excluded:'#8792A6'};
export const CAT = {
  law:{l:'Frontier law enacted',g:'●',c:'#2FD69E'}, pending:{l:'Bill pending',g:'◐',c:'#FFC23D'}, auditor:{l:'Auditor licensing',g:'◆',c:'#C89BFF'},
  sf:{l:'Stalled or failed',g:'‖',c:'#FF9B5E'}, other:{l:'Other activity',g:'▲',c:'#4FD4F0'}, none:{l:'No frontier law tracked',g:'',c:'#56627A'}
};
export const CONF = {
  'HIGH':{n:5,l:'High',d:'Checked against a primary record, such as the bill text, a docket or an official page.'},
  'MED-HIGH':{n:4,l:'Med-high',d:'Strong corroboration, but a key primary record is not public or was not opened.'},
  'MED':{n:3,l:'Medium',d:'Two or more reputable secondary sources agree; no primary record checked.'},
  'SEARCH-QUALIFIED':{n:2,l:'Search-qualified',d:'A dated “none located” finding. It means nothing was found by that date, not proof that nothing exists.'},
  'LOW':{n:1,l:'Low',d:'A single source or thin details. Treat as a lead, not a fact.'}
};
export const CONF_ORDER = ['HIGH','MED-HIGH','MED','SEARCH-QUALIFIED','LOW'];
export const KINDS = {federal:{l:'Congress',g:'■',v:'var(--k-fed)'},state:{l:'States',g:'●',v:'var(--k-state)'},executive:{l:'White House and agencies',g:'▲',v:'var(--k-exec)'},litigation:{l:'Courts',g:'§',v:'var(--k-lit)'},industry:{l:'Industry and incidents',g:'◇',v:'var(--k-ind)'}};
export const STATE_OVERRIDE = {57:'CA',58:'IL',59:'OR',68:'FL',69:'CA'};
export let FED_GROUPS = [
  {k:'D',l:'Bills in Congress',sub:'Introduced. None enacted.'},
  {k:'F',l:'Related federal bills',sub:'Adjacent and sector-specific'},
  {k:'E',l:'Drafts and proposals',sub:'Not introduced as bills'},
  {k:'G',l:'White House and agencies',sub:'Orders, directives, voluntary programs'},
  {k:'G.2',l:'Lawsuits and enforcement',sub:'Courts, task forces, negative findings'},
  {k:'G.3',l:'Chips and export controls',sub:'Compute and diffusion rules'},
  {k:'H',l:'Earlier proposals',sub:'Withdrawn or stripped'}
];
export let MILESTONES = [
  ['2023-10-01',75,'The 10²⁶-operation compute threshold enters US policy'],
  ['2024-09-29',77,'California’s SB 1047 is vetoed'],
  ['2025-07-01',78,'The Senate strips a 10-year moratorium on state AI laws, 99–1'],
  ['2025-09-29',1,'California signs SB 53, the first frontier-developer law'],
  ['2025-12-11',51,'EO 14365 directs agencies to challenge state AI laws'],
  ['2025-12-19',2,'New York signs the RAISE Act'],
  ['2026-03-27',2,'New York replaces RAISE with a law on the SB 53 template'],
  ['2026-07-06',3,'Illinois signs SB 315, adding annual audits'],
  ['2026-07-23',27,'The FRONTIER Act is introduced in the House'],
  ['2026-09-09',20,'California signs auditor laws SB 813 and AB 1405'],
  ['2026-09-29',60,'White House accord: voluntary principles, no binding rule']
].map(([d,id,c]) => ({d:new Date(d+'T12:00:00'), id, c}));
export let REPLAY_START = new Date(2023, 8, 1);
// Section groups, as v1 groups its sections (build/build.mjs GROUPS). Used by the Explore sidebar and the table's Group filter.
export let GROUPS = [
  { k: 'state', l: 'State legislation', sections: ['A', 'B', 'B.2', 'C'] },
  { k: 'federal', l: 'Federal legislation', sections: ['D', 'E', 'F'] },
  { k: 'exec', l: 'Executive action, litigation, export controls', sections: ['G', 'G.2', 'G.3'] },
  { k: 'context', l: 'Precursors, adjacent laws, exclusions', sections: ['H', 'I', 'J'] }
];
export const groupOf = (sec) => (GROUPS.find((g) => g.sections.includes(sec)) || { k: 'other' }).k;

// Plain-English summaries are OFF for the v1-parity showcase: the app shows the tracker's own core-mechanism text.
// Real summaries will arrive with the automated pipeline (reviewed, stored in a separate field). Set to true to preview the 22 drafts.
export const USE_DRAFT_SUMMARIES = false;

// Draft plain-English summaries, derived only from each entry's `mechanism` (and status where noted). For author review.
export const SUM = {
  1:'Requires the largest frontier AI developers to publish a safety framework and transparency reports, report critical safety incidents within 15 days (24 hours if there is imminent risk of death or serious injury), and protect whistleblowers.',
  2:'New York’s replacement law copies California’s framework and transparency-report duties, requires incident reports within 72 hours, and creates an office in the Department of Financial Services with rulemaking power. It has no whistleblower section and no audit mandate.',
  3:'Requires large frontier developers to publish a safety framework and transparency reports, undergo an annual independent audit from 2028, report incidents within 72 hours, and protects whistleblowers.',
  4:'The Senate text would require an independent catastrophic-risk review at least every 120 days, with whistleblower protections and enforcement by the Attorney General. The House version contains only funding.',
  6:'Large frontier developers with New Jersey users would file risk disclosures with the Attorney General, mapped to the NIST AI framework, including before new models deploy. The bill would sunset after five years.',
  11:'Frontier developers would publish a safety plan, large chatbot providers would publish child-protection plans, and incidents would be reported within 15 days.',
  13:'Would require a frontier AI framework, transparency reports, incident reports within 15 days, and an annual independent audit from July 1, 2028.',
  17:'Would have amended the RAISE Act to require an independent pre-deployment safety evaluation of every frontier model.',
  18:'Pennsylvania’s version of the SB 53 model, plus registration: large frontier developers would register with the state emergency agency, publish a framework, face annual audits and report critical incidents within 72 hours. Penalties reach $1 million, then $3 million.',
  20:'From 2029, anyone conducting an AI audit required by California law must be on a state registry run by the Government Operations Agency.',
  21:'By 2028, California’s Government Operations Agency must set up a way to designate independent verification organizations, with conflict-of-interest rules.',
  22:'Creates a voluntary license for organizations that verify AI risks. Nothing requires a developer to seek verification.',
  24:'Directs a Virginia commission to study whether a framework for independent verification organizations is feasible. A study, not a mandate.',
  25:'Runs a pilot program for independent verification organizations through June 30, 2030.',
  26:'The Department of Energy would run a mandatory evaluation program for advanced AI, including classified red-team testing, with a penalty of at least $1 million a day for not taking part.',
  27:'Would create an Under Secretary of Commerce for AI Security, require frameworks, annual audits and 72-hour incident reports, let the Commerce Secretary suspend a model posing imminent catastrophic risk, and bar states from adding new obligations in these areas.',
  33:'Would create a Department of Artificial Intelligence, pause training and deployment of advanced systems until it has rules, and permanently ban artificial superintelligence.',
  35:'A two-page bill requiring advanced AI systems to include a way for a human operator to shut them down.',
  51:'Directs federal agencies to challenge state AI laws that are not “minimally burdensome” and sets up an AI Litigation Task Force. It cannot itself preempt state law.',
  53:'Directs agencies to build a classified cyber-capability benchmark and a voluntary framework allowing up to 30 days of government access before release. It expressly rules out mandatory licensing.',
  60:'Companies signed voluntary principles at a White House meeting. No binding rule was announced.',
  77:'The vetoed predecessor to SB 53. It required a safety protocol, an annual independent auditor, compliance certifications and a full-shutdown capability.',
  78:'A proposed 10-year moratorium on state AI laws in the 2025 reconciliation bill.'
};

// Section K comparison matrix (verbatim from tracker-full.md), keyed by entry id.
export let K_IDS = [1,2,3,5,6,4,27];
export let K_ROWS = [
  ['Casualty threshold', {1:'>50',2:'>50 (was 100)',3:'>50',5:'>100',6:'25+',4:'50+',27:'>50'}],
  ['Developer trigger', {1:'>$500M revenue',2:'>$500M revenue',3:'>$500M revenue',5:'Compute cost $5M / $100M',6:'>$100M revenue',4:'>$500M AI revenue or >$1B R&D',27:'>$50M revenue + ≥$1B AI spend (large); >$5B + ≥$10B (very large)'}],
  ['Compute (FLOP) threshold', {1:'10²⁶',2:'10²⁶',3:'10²⁶',5:'None — compute expressed as estimated cost',6:'10²⁶',4:'10²⁶',27:'10²⁶'}],
  ['Incident reporting', {1:'15 days / 24 h if imminent',2:'72 h / 24 h',3:'72 h / 24 h if imminent',5:'Conditions self-defined in protocol',6:'None (term defined, never used)',4:'To the AG',27:'72 h / 24 h to law enforcement'}],
  ['Third-party audit', {1:'None',2:'Dropped',3:'Annual (from 2028)',5:'Annual',6:'Discretionary (AG)',4:'Every 120 days',27:'Annual (large) + IVO at least every 6 months (very large)'}],
  ['Whistleblower protection', {1:'Yes + anonymous channel',2:'Removed',3:'Yes',5:'Yes + private right of action',6:'None',4:'Yes',27:'None'}],
  ['Private right of action', {1:'None for developer obligations; employees may sue for retaliation',2:'No',3:'None for developer obligations; employee remedies via IL Whistleblower Act',5:'Employees only',6:'No',4:'No',27:'No (IVO immunity)'}],
  ['Penalty ceiling', {1:'$1M',2:'$1M / $3M',3:'$1M / $3M',5:'$1M ($500 for whistleblower violations)',6:'$100K',4:'—',27:'$1M/day; $10M/day + criminal for emergency-order violations'}],
  ['Oversight body', {1:'OES + AG',2:'New DFS office (rulemaking)',3:'IEMA/OHS + AG',5:'AG',6:'AG + OHSP',4:'AG',27:'New Under Secretary of Commerce'}],
  ['Federal reciprocity', {1:'Incident reporting only',2:'Incident reporting only',3:'Whole Act, but federal rule must mandate audits',5:'—',6:'—',4:'—',27:'Would displace'}],
  ['Preempts local governments', {1:'Yes (ordinances on/after Jan 1, 2025)',2:'—',3:'Yes (denies home rule, Sec. 35)',5:'—',6:'—',4:'—',27:'Partially preempts states in three enumerated fields; effect on existing laws textually disputed'}]
];

const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MNL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export const fmt = d => d ? `${d.getDate()} ${MN[d.getMonth()]} ${d.getFullYear()}` : 'Undated';
export const fmtMonth = d => `${MNL[d.getMonth()]} ${d.getFullYear()}`;
export const fmtShort = d => `${MN[d.getMonth()]} ${d.getFullYear()}`;
export const clean = s => (s||'').replace(/\s*⟨[^⟩]*⟩/g,'').replace(/\s+/g,' ').trim();
// The status line exactly as recorded, minus the column label ("Status (as of …):") and the [PENDING]-style class tag,
// which the status badge already shows. asOf is the date in the column label, when it has one.
export function statusOf(text) {
  let t = clean(text), asOf = null;
  const m = t.match(/^(Status|Introduced \/ status|Date \/ status|Date)\b([^:]{0,40}):\s*/);
  if (m) { const a = m[2].match(/as of ([^)]+)\)/i); if (a) asOf = a[1].trim(); t = t.slice(m[0].length); }
  t = t.replace(/\[[A-Z][A-Z—\- ]*\]\s*/g, '').trim();
  return { text: t, asOf };
}

const DRE = /\b(Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b(?:,?\s*(\d{4}))?/g;
const DRE_ONE = /^(Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b(?:,?\s*\d{4})?\)?/;
export function datesIn(text, fy) {
  const out = []; let m; DRE.lastIndex = 0;
  while ((m = DRE.exec(text))) {
    let y = m[3];
    if (!y) { const r = text.slice(m.index, m.index + 70).match(/\b(20\d\d)\b/); y = r ? r[1] : fy; }
    if (!y) continue;
    out.push({ d: new Date(+y, MON[m[1].slice(0,3).toLowerCase()], +m[2], 12), i: m.index });
  }
  if (!out.length) { const mm = text.match(/\b(Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(20\d\d)\b/); if (mm) out.push({ d: new Date(+mm[2], MON[mm[1].slice(0,3).toLowerCase()], 1, 12), i: mm.index }); }
  return out;
}
const VERB = /(signed|enacted|introduced|passed|vetoed|filed|referred|effective|withdrawn|stripped|published|announced|denied|approved|rescinded|suspended|released|recommitted|reimposed|enrolled|sued|issued|ordered|scheduled|due)/i;
const cleanSeg = s => clean(s).replace(/^(Status|Introduced \/ status|Date \/ status|Date)[^:]*:\s*/i,'').replace(/\[[A-Z—\- ]+\]\s*/g,'').replace(/^Signed:\s*/,'Signed ').replace(/^Effective:\s*/,'Effective ').replace(/\s+,/g,',').trim();

function deriveStatus(x) {
  const s = x.section, sd = x.status_and_dates || '';
  if (s === 'A' || s === 'I') return 'enacted';
  if (s === 'B') { const m = sd.match(/\[(PENDING|STALLED|FAILED)/); return m ? m[1].toLowerCase() : 'pending'; }
  if (s === 'B.2') return 'stalled';
  if (s === 'C') { if (/FAILED/.test(sd)) return 'failed'; if (/signed|enacted|approved by governor/i.test(sd)) return 'enacted'; return 'pending'; }
  if (s === 'D' || s === 'E' || s === 'F') return 'pending';
  if (s === 'G') return 'executive'; if (s === 'G.2') return 'litigation'; if (s === 'G.3') return 'export';
  if (s === 'H') return 'failed'; return 'excluded';
}
const TYPE_OF = {A:'law',I:'law',B:'bill','B.2':'bill',C:'auditor',D:'bill',F:'bill',E:'draft',G:'executive','G.2':'litigation','G.3':'export',H:'precursor',J:'excluded'};

// Dated steps from a status line: the parts of the text tied to each date, plus the first date and the key (latest past) step.
function stepsOf(statusText, fy) {
  const sd = (statusText || '').replace(/\s*\(as of [^)]*\)/gi, '');
  const all = datesIn(sd, fy);
  const segs = []; let pos = 0;
  sd.split(/\s*(?:\||;)\s*/).forEach(raw => {
    const start = sd.indexOf(raw, pos); pos = start + raw.length;
    const ds = all.filter(a => a.i >= start && a.i < pos);
    if (!ds.length) { const txt = cleanSeg(raw); if (txt) segs.push({ d: null, t: txt }); return; }
    let from = start;
    ds.forEach((a, k) => {
      const m = sd.slice(a.i).match(DRE_ONE); const end = a.i + (m ? m[0].length : 0);
      const stop = k === ds.length - 1 ? pos : end;
      let txt = cleanSeg(sd.slice(from, stop)).replace(/^[,.\s)(]+/, '').replace(/\s*\(?\b(Jan|Feb|Mar|Apr|May|June?|July?|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b(,?\s*\d{4})?\)?\s*$/, '').replace(/[,;:\s]+$/, '');
      if (txt) txt = txt[0].toUpperCase() + txt.slice(1);
      if (!txt) { const vm = sd.slice(start, stop).match(VERB); txt = vm ? vm[1][0].toUpperCase() + vm[1].slice(1).toLowerCase() : 'Dated step'; }
      const before = sd.slice(Math.max(start, a.i - 40), a.i);
      const isCheck = /\b(through|as of|since|until)\s*$/i.test(before) || /^(no|nor|none)\b/i.test(txt);
      if (isCheck) { from = stop; return; }
      if (txt) segs.push({ d: a.d, t: txt.length > 220 ? txt.slice(0, 216).replace(/\s\S*$/, '') + '…' : txt });
      from = stop;
    });
  });
  const dated = segs.filter(s => s.d).sort((a, b) => a.d - b.d);
  const first = dated.length ? dated[0].d : (all.length ? new Date(Math.min(...all.map(a => +a.d))) : null);
  const past = dated.filter(s => s.d <= ASOF);
  const kd = past.length ? past[past.length - 1] : dated[0];
  const verb = kd ? (kd.t.match(VERB) || [])[1] : null;
  return { segs, dated, first, kd, verb };
}

export function build(entries, news, rel) {
  const anchorToId = {}; entries.forEach(x => { anchorToId[(x.permalink_old_site||'').split('#')[1]] = x.id; });
  const keyToId = {}, idToKey = {};
  Object.entries(rel.aliases).forEach(([k, a]) => { if (anchorToId[a]) { keyToId[k] = anchorToId[a]; idToKey[anchorToId[a]] = k; } });
  const events = [];
  const E = entries.map(x => {
    const t = clean(x.title), st = STATE_OVERRIDE[x.id] || (/^[A-Z]{2}$/.test(x.jurisdiction) && x.jurisdiction !== 'US' ? x.jurisdiction : null);
    const fy = (x.years || []).find(y => /^\d{4}$/.test(y));
    const { segs, dated, first, kd, verb } = stepsOf(x.status_and_dates, fy);
    const key = idToKey[x.id];
    const short = (key && rel.short[key]) || t.split(' — ')[0];
    const status = deriveStatus(x);
    const mech = clean(x.mechanism);
    let lead = mech.split(/;\s|\.\s/)[0]; if (lead.length > 190) lead = lead.slice(0, 186).replace(/\s\S*$/, '') + '…';
    const o = { id:x.id, raw:x, title:t, short, key, section:x.section, sec:SEC[x.section], st, juris: st ? SN[st] : (x.section==='J' ? 'Not tracked' : 'Federal'), level: st ? 'state' : (x.section==='J' ? 'none' : 'federal'),
      status, type: TYPE_OF[x.section], conf: x.confidence_level || null, confNote: clean(x.confidence_note), sponsor: clean(x.sponsor), mech, thresholds: clean(x.thresholds), source: clean(x.source),
      years: x.years || [], U: /⟨U⟩/.test(x.title), R: /⟨R⟩/.test(x.title), NCSL: /⟨NCSL⟩/.test(x.title), segs, dated, first, kd, kdLabel: kd ? `${verb ? verb[0].toUpperCase()+verb.slice(1).toLowerCase()+' · ' : ''}${fmt(kd.d)}` : 'No dated event',
      summary: USE_DRAFT_SUMMARIES ? (SUM[x.id] || null) : null, lead, link: x.permalink_old_site,
      srcLinks: x.source_links || [], moreLinks: (x.all_links || []).filter(l => !(x.source_links || []).some(s => s.u === l.u)), penalties: clean(x.penalties), signed: clean(x.signed), effective: clean(x.effective), statusText: statusOf(x.status_and_dates) };
    dated.forEach(s => events.push({ d: s.d, id: x.id, t: s.t }));
    return o;
  });
  const byId = {}; E.forEach(e => byId[e.id] = e);
  const N = news.items.map((n, i) => ({ ...n, i, d: new Date(n.date + 'T12:00:00'), entryId: n.tracker ? keyToId[n.tracker] : null }));
  const edges = rel.edges.map(ed => ({ ...ed, fromId: keyToId[ed.from] || null, toId: keyToId[ed.to] || null }));
  const pulse = {};
  N.filter(n => n.d >= WEEK_FROM && n.entryId).forEach(n => { const s = byId[n.entryId].st; if (s) pulse[s] = true; });
  return { E, byId, keyToId, idToKey, N, edges, rel, events: events.sort((a, b) => b.d - a.d), pulse, kinds: news.kinds, newsBottom: news.bottom };
}

export function stateCat(list) {
  if (!list.length) return 'none';
  if (list.some(x => x.section === 'A')) return 'law';
  if (list.some(x => x.type === 'bill' && x.status === 'pending')) return 'pending';
  if (list.some(x => x.section === 'C' && x.status !== 'failed')) return 'auditor';
  if (list.some(x => x.status === 'stalled' || x.status === 'failed')) return 'sf';
  return 'other';
}

const LCAT = {law:{c:'#2FD69E',d:'#0B7F5E'},pending:{c:'#FFC23D',d:'#B07800'},auditor:{c:'#B98AF2',d:'#7A3FC4'},sf:{c:'#D9622B',d:'#B4471A'},other:{c:'#0E9BB8',d:'#0B7891'}};
export function tileStyle(cat, selected, light) {
  if (light) {
    const ring = selected ? '0 0 0 3px #0D1424' : '', k = LCAT[cat], ink = { fg:'#0D1424', ts:'none' };
    const sh = (s) => [s, ring].filter(Boolean).join(', ') || 'none';
    if (cat === 'law') return { ...ink, bg:k.c, bd:`1px solid ${k.d}`, fg:'#03140D', gc:'#03140D', sh: sh(`0 6px 18px -8px ${k.d}`) };
    if (cat === 'pending') return { ...ink, bg:`linear-gradient(to top, ${k.c} 0 50%, #FFF6DD 50% 100%)`, bd:`1.5px solid ${k.d}`, gc:'#5A3F00', sh: sh('') };
    if (cat === 'auditor') return { ...ink, bg:`repeating-linear-gradient(135deg, ${k.c}99 0 3px, #F6EFFF 3px 8px)`, bd:`1.5px solid ${k.d}`, gc:k.d, sh: sh('') };
    if (cat === 'sf') return { ...ink, bg:'#FDF1EA', bd:`1.5px dashed ${k.d}`, gc:k.d, sh: sh('') };
    if (cat === 'other') return { ...ink, bg:'#EAF7FA', bd:`2px dotted ${k.d}`, gc:k.d, sh: sh('') };
    return { bg:'#E9EEF5', bd:'1px solid #D6DDE8', fg:'#4F5A72', ts:'none', gc:'#4F5A72', sh: sh('') };
  }
  const c = CAT[cat].c, ring = selected ? ', 0 0 0 3px #FFFFFF' : '';
  const base = { fg:'#FFFFFF', ts:'0 1px 2px rgba(0,0,0,.85)', gc:c };
  if (cat === 'law') return { bg:c, bd:`1px solid ${c}`, fg:'#03140D', ts:'none', gc:'#03140D', sh:`0 0 16px -4px ${c}${ring}` };
  if (cat === 'pending') return { ...base, bg:`linear-gradient(to top, ${c}D9 0 50%, rgba(255,194,61,.10) 50% 100%)`, bd:`1.5px solid ${c}`, sh:`0 0 20px -8px ${c}${ring}` };
  if (cat === 'auditor') return { ...base, bg:`repeating-linear-gradient(135deg, ${c}70 0 3px, rgba(200,155,255,.07) 3px 8px)`, bd:`1.5px solid ${c}`, sh:`0 0 18px -8px ${c}${ring}` };
  if (cat === 'sf') return { ...base, bg:'rgba(255,155,94,.09)', bd:`1.5px dashed ${c}`, sh: selected ? '0 0 0 3px #FFFFFF' : 'none' };
  if (cat === 'other') return { ...base, bg:'rgba(79,212,240,.08)', bd:`2px dotted ${c}`, sh: selected ? '0 0 0 3px #FFFFFF' : 'none' };
  return { bg:'rgba(255,255,255,.035)', bd:'1px solid rgba(255,255,255,.07)', fg:'#8A96AD', ts:'none', gc:'#8A96AD', sh: selected ? '0 0 0 3px #FFFFFF' : 'none' };
}

export function hl(text, terms) {
  if (!terms.length || !text) return [{ t:text, m:false, n:true }];
  const re = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'ig');
  return text.split(re).filter(Boolean).map(p => { const m = terms.some(t => p.toLowerCase() === t.toLowerCase()); return { t:p, m, n:!m }; });
}

export function search(E, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (!terms.length) return { terms, res: E.map(x => ({ x, s:0 })) };
  const res = [];
  E.forEach(x => {
    const f = [[x.title.toLowerCase(),6],[x.short.toLowerCase(),6],[(x.juris+' '+(x.st||'')).toLowerCase(),5],[x.sponsor.toLowerCase(),3],[(x.sec+' '+TYPES[x.type]+' '+ST[x.status].l).toLowerCase(),2],[x.mech.toLowerCase(),1],[x.thresholds.toLowerCase(),1]];
    let s = 0;
    for (const t of terms) { let hit = 0; f.forEach(([h, w]) => { if (h.includes(t)) hit += w; }); if (!hit) return; s += hit; }
    res.push({ x, s: s + (x.U ? .5 : 0) });
  });
  return { terms, res: res.sort((a, b) => b.s - a.s) };
}

export function snippet(text, terms) {
  if (!terms.length) return null;
  const low = text.toLowerCase(); let i = -1;
  for (const t of terms) { const j = low.indexOf(t); if (j >= 0 && (i < 0 || j < i)) i = j; }
  if (i < 0) return null;
  const s = Math.max(0, i - 60), e = Math.min(text.length, i + 140);
  return (s ? '…' : '') + text.slice(s, e).replace(/^\S*\s/, s ? '' : '$&') + (e < text.length ? '…' : '');
}


/* ---------- v2 data ---------- */
// The published v2 files (entries, relationships, news, site) are the source of truth: the UI builds the same model
// from them that build() makes from the v1 files, so every view works unchanged. Entries keep their legacy numeric id
// (the schema guarantees one, never reused); the text key links entries, news, links, milestones and the matrix.
const dayOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const noonOf = (iso) => new Date(iso + 'T12:00:00');

export function applySite(site, idOfKey) {
  ASOF = dayOf(site.updates_through); VERIFIED = dayOf(site.verified_as_of); WEEK_FROM = dayOf(site.week_from);
  if (site.section_names) SEC = { ...site.section_names };
  if (site.replay_start) REPLAY_START = dayOf(site.replay_start);
  if (site.section_groups) GROUPS = site.section_groups.map((g) => ({ k: g.key, l: g.name, sections: g.sections }));
  if (site.federal_groups) FED_GROUPS = site.federal_groups.map((g) => ({ k: g.section, l: g.name, sub: g.note }));
  MILESTONES = (site.replay_milestones || []).filter((m) => idOfKey[m.entry_key]).map((m) => ({ d: noonOf(m.date), id: idOfKey[m.entry_key], c: m.caption }));
  const cm = site.comparison_matrix || { entry_keys: [], rows: [] };
  K_IDS = cm.entry_keys.filter((k) => idOfKey[k]).map((k) => idOfKey[k]);
  K_ROWS = cm.rows.map((r) => [r.dimension, Object.fromEntries(Object.entries(r.values).filter(([k]) => idOfKey[k]).map(([k, v]) => [idOfKey[k], v]))]);
}

// Headline numbers, counted from the entries instead of typed in.
export function headline(E) {
  const n = (f) => E.filter(f).length, B = (st) => n((x) => (x.section === 'B' || x.section === 'B.2') && x.status === st);
  return { enacted: n((x) => x.section === 'A'), pending: B('pending'), stalled: B('stalled'), failed: B('failed'), stalledOrFailed: B('stalled') + B('failed'), ivo: n((x) => x.section === 'C'),
    fed: n((x) => x.section === 'D'), exec: n((x) => x.section === 'G'), lit: n((x) => x.section === 'G.2'), total: E.length,
    sources: E.reduce((t, x) => t + x.srcLinks.length, 0), events: E.reduce((t, x) => t + x.v2events.length, 0) };
}

export function buildV2(entries, news, rel, site) {
  const idOfKey = {}; entries.forEach((x) => { idOfKey[x.key] = x.id; });
  applySite(site, idOfKey);
  // relationships: node keys (e.g. SB53) are what the graph uses; entry_key ties a node to its entry
  const R = { types: rel.types, columns: rel.columns, short: {}, actors: {}, columnOf: {}, edges: rel.edges };
  const keyToId = {}, idToKey = {};
  Object.entries(rel.nodes).forEach(([k, nd]) => {
    R.columnOf[k] = nd.column;
    if (nd.kind === 'actor') { R.actors[k] = nd.name; return; }
    R.short[k] = nd.name;
    const id = idOfKey[nd.entry_key]; if (id != null) { keyToId[k] = id; idToKey[id] = k; }
  });
  const events = [];
  const E = entries.map((x) => {
    // years as the year filter uses them: anything after the data year is grouped as "<next year>+"
    const later = ASOF.getFullYear() + 1, st = x.state || null, years = [...new Set(x.events.map((e) => { const y = +e.date.slice(0, 4); return y >= later ? later + '+' : String(y); }))].sort();
    const fy = years.find((y) => /^\d{4}$/.test(y));
    const { segs, dated, first, kd, verb } = stepsOf(x.status_text, fy);
    const mech = clean(x.mechanism);
    let lead = mech.split(/;\s|\.\s/)[0]; if (lead.length > 190) lead = lead.slice(0, 186).replace(/\s\S*$/, '') + '…';
    const tags = x.tags || {}, conf = x.confidence || {};
    const o = { id: x.id, v2key: x.key, raw: x, title: clean(x.title), short: x.short_name, key: idToKey[x.id], section: x.section, sec: SEC[x.section], st,
      juris: st ? SN[st] : (x.section === 'J' ? 'Not tracked' : 'Federal'), level: x.level === 'state' || x.level === 'federal' ? x.level : (st ? 'state' : (x.section === 'J' ? 'none' : 'federal')),
      status: x.status, type: x.type, conf: conf.level || null, confNote: clean(conf.note || conf.level || ''), sponsor: clean(x.sponsor_text), mech, thresholds: clean(x.thresholds), source: clean(x.source_label),
      years, U: !!tags.updated_after_verification, R: tags.found_via === 'dedicated_search', NCSL: tags.found_via === 'ncsl', segs, dated, first, kd,
      kdLabel: kd ? `${verb ? verb[0].toUpperCase() + verb.slice(1).toLowerCase() + ' · ' : ''}${fmt(kd.d)}` : 'No dated event',
      summary: USE_DRAFT_SUMMARIES ? (SUM[x.id] || null) : null, lead, link: x.legacy ? x.legacy.permalink : null,
      srcLinks: (x.sources || []).map((l) => ({ t: l.label, u: l.url })), moreLinks: (x.more_links || []).map((l) => ({ t: l.t, u: l.u })),
      penalties: clean(x.penalties), signed: clean(x.signed_text), effective: clean(x.effective_text), statusText: statusOf(x.status_text),
      origin: x.origin, lastChecked: x.last_checked, v2events: x.events };
    dated.forEach((sg) => events.push({ d: sg.d, id: x.id, t: sg.t }));
    return o;
  });
  const byId = {}; E.forEach((e) => { byId[e.id] = e; });
  const N = news.items.map((n, i) => ({ ...n, tracker: n.tracker ? idToKey[idOfKey[n.tracker]] || null : null, i, d: noonOf(n.date), entryId: n.tracker ? idOfKey[n.tracker] || null : null }));
  const edges = rel.edges.map((ed) => ({ ...ed, fromId: keyToId[ed.from] || null, toId: keyToId[ed.to] || null }));
  const pulse = {};
  N.filter((n) => n.d >= WEEK_FROM && n.entryId).forEach((n) => { const s = byId[n.entryId].st; if (s) pulse[s] = true; });
  // dated events for the timeline lanes, straight from each entry's structured events
  const tev = [];
  E.forEach((x) => x.v2events.forEach((e, i) => tev.push({ id: x.id, date: e.date, precision: e.precision, inferredYear: !!e.inferred_year, type: e.type, column: i, clause: e.clause, match: e.text, d: noonOf(e.date) })));
  HC = headline(E);
  return { E, byId, keyToId, idToKey, idOfKey, N, edges, rel: R, events: events.sort((a, b) => b.d - a.d), pulse, kinds: news.kinds, newsBottom: news.bottom, tev, site, v2: true };
}
