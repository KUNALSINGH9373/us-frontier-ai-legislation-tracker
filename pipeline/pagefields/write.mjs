// One entry's page fields (display_name, summary_line, thirty_seconds, key_facts): writer -> code checks -> reviewer, with one
// rewrite round fed the refusals. A field that still fails is left out, and the page keeps showing the entry's existing text there.
// Nothing is written here; the caller gets the checked fields and why any were left out.
import { WRITER_SYSTEM, writerPrompt, WRITER_SCHEMA, REVIEWER_SYSTEM, reviewerPrompt, REVIEWER_SCHEMA } from './prompts.mjs';
import { kindOf, nameOf, needsName, entryText, KIND_FACTS } from './layout.mjs';
import { containsQuote, norm } from '../agents/source-text.mjs';
import { pageFieldProblems } from '../schema/integrity.mjs';

export const ROUNDS = 2;
const BAD_CHARS = /[\n{}<>]/;
// Words about our own process or the record itself: a reader must never see them.
const META = /\b(?:entry text|the entry|this entry|the record does not|our record|not stated|does not say|does not list|does not name|names no|not specified in)\b/i;
export const FACT_MAX = 60;
// A sentence end inside the text: . ! or ? (a closing quote or bracket may follow), a space, then a capital. Initials ("U.S.", "S.B.")
// and the usual abbreviations ("Gov.", "No.", "Sec.") are not sentence ends; an acronym ("FTC.", "AI.") is.
const ABBR = /^(?:Gov|Sen|Rep|Asm|Inc|Corp|Dept|No|Nos|St|Mr|Ms|Mrs|Dr|Jr|Co|Ch|Sec|vs|v|Jan|Feb|Mar|Apr|Aug|Sept|Sep|Oct|Nov|Dec|U\.S|[A-Z](?:\.[A-Z])*)$/;
export const sentenceBreaks = (s) => [...String(s).matchAll(/(\S+?)[.!?]["”')\]]*\s+(?=["“(]?[A-Z])/g)].some((m) => !ABBR.test(m[1].replace(/^["“(]+/, '')));
// Present-tense openings that would describe a bill that has not passed as law.
const PRESENT = /^(Requires|Makes|Creates|Establishes|Sets|Bans|Prohibits|Mandates|Imposes|Gives|Lets|Forces|Directs|Bars|Adds|Protects)\b/;

// Plain-code checks on a draft. Returns { fields, problems: { path: [text] } } where fields holds only what passed.
export function checkDraft({ entry, draft, kind, wantName }) {
  const text = entryText(entry), problems = {}, put = (k, p) => { (problems[k] ||= []).push(p); };
  const fields = {};
  const s = String(draft.summary_line || '').trim();
  if (s) {
    if (s.length < 20 || s.length > 240) put('summary_line', `it is ${s.length} characters; it must be 20 to 240`);
    if (BAD_CHARS.test(s)) put('summary_line', 'it has a line break or markup');
    if (/^(?:Describes|Records|Summarizes|Documents|Notes|Covers)\b/.test(s)) put('summary_line', `it describes the tracker's entry ("${s.split(' ')[0]} ..."): say what the law, order or case itself does`);
    if (META.test(s)) put('summary_line', `it talks about the record ("${s.match(META)[0]}"): say only what the entry does`);
    if (sentenceBreaks(s)) put('summary_line', 'it must be one sentence');
    if (['pending', 'stalled', 'failed'].includes(entry.status) && kind === 'bill' && PRESENT.test(s)) put('summary_line', `the bill is ${entry.status}, not law: say "Would ..."${entry.status === 'pending' ? '' : ' or "Would have ..."'}, not "${s.split(' ')[0]} ..."`);
    if (!problems.summary_line) fields.summary_line = s;
  }
  const ts = draft.thirty_seconds || {}, boxes = ['a', 'b', 'c'].map((k) => String(ts[k] || '').trim());
  if (boxes.some(Boolean)) {
    if (boxes.filter(Boolean).length < 2) put('thirty_seconds.a', 'at least two of the three boxes are needed');
    boxes.forEach((t, i) => {
      const k = 'thirty_seconds.' + 'abc'[i];
      if (!t) return; // the page shows "Not stated in the text" for an empty box
      if (t.length > 320) put(k, `${t.length} characters; at most 320`);
      if (BAD_CHARS.test(t)) put(k, 'a line break or markup');
      if (META.test(t)) put(k, `it talks about the record ("${t.match(META)[0]}"): leave the box empty instead`);
    });
    if (!['a', 'b', 'c'].some((k) => problems['thirty_seconds.' + k])) fields.thirty_seconds = { a: boxes[0], b: boxes[1], c: boxes[2] };
  }
  // key facts and the display name are copied, never written: each must be found in ENTRY TEXT as it stands
  const kf = {};
  KIND_FACTS[kind].forEach((k) => {
    const v = String((draft.key_facts || {})[k] || '').trim();
    if (!v) return;
    if (v.length > FACT_MAX || BAD_CHARS.test(v) || /[;§(]/.test(v)) put('key_facts.' + k, `a key fact is a name only (an office, a court, a person), at most ${FACT_MAX} characters, no sections or explanations: "${v.slice(0, 80)}"`);
    else if (!v.split(/\s*[;,]\s*(?:and\s+)?|\s+and\s+/).filter(Boolean).every((part) => containsQuote(text, part))) put('key_facts.' + k, `"${v}" is not copied from ENTRY TEXT`);
    else kf[k] = v;
  });
  if (Object.keys(kf).length) fields.key_facts = kf;
  const dn = String(draft.display_name || '').trim();
  if (dn && wantName) {
    if (dn.length > 80 || BAD_CHARS.test(dn)) put('display_name', 'too long or has markup');
    else if (!containsQuote(text, dn)) put('display_name', `"${dn}" is not copied from ENTRY TEXT`);
    else if (/^(?:an act\b|a bill\b|chapter \d|relating to\b|concerning\b)/i.test(dn)) put('display_name', `"${dn}" is a formal title, not a name a reader knows the entry by: leave it empty if ENTRY TEXT gives no short name`);
    else if (norm(dn) === norm(nameOf(entry).name)) put('display_name', 'it is the same as the name the page already shows');
    else fields.display_name = dn;
  }
  // the integrity rule every publish runs: no number that is not in the entry's own text
  pageFieldProblems({ ...entry, ...fields, page_verification: { method: 'agent', checked_at: new Date().toISOString() } }).forEach((p) => {
    const m = /: (display_name|summary_line|thirty_seconds\.[abc]|key_facts\.\w+) has the number/.exec(p);
    if (!m) return;
    put(m[1], p.replace(/^[^:]+: /, ''));
    const top = m[1].split('.')[0];
    if (top === 'thirty_seconds') delete fields.thirty_seconds;
    else if (top === 'key_facts') { delete fields.key_facts[m[1].split('.')[1]]; if (!Object.keys(fields.key_facts).length) delete fields.key_facts; }
    else delete fields[top];
  });
  return { fields, problems };
}

// Reviewer verdicts applied to the checked fields: a field stays only if every line of it is "ok" with support code finds.
export function applyVerdicts({ fields, verdicts, text }) {
  const by = {}; (verdicts || []).forEach((v) => { by[String(v.field).trim()] = v; });
  const keep = {}, refused = {};
  const judge = (path) => {
    const v = by[path];
    if (!v) return 'the reviewer gave no verdict';
    if (v.verdict !== 'ok') return `${v.verdict}: ${v.problem || 'no reason given'}`;
    const sup = (v.support || []).filter((q) => String(q).trim().length >= 6);
    if (!sup.length) return 'passed without a supporting quote';
    const missing = sup.filter((q) => !containsQuote(text, q));
    return missing.length ? `the support quote is not in ENTRY TEXT: "${String(missing[0]).slice(0, 80)}"` : null;
  };
  if (fields.summary_line) { const w = judge('summary_line'); if (w) refused.summary_line = w; else keep.summary_line = fields.summary_line; }
  if (fields.thirty_seconds) {
    const ws = ['a', 'b', 'c'].filter((k) => fields.thirty_seconds[k]).map((k) => [k, judge('thirty_seconds.' + k)]).filter(([, w]) => w);
    if (ws.length) ws.forEach(([k, w]) => { refused['thirty_seconds.' + k] = w; }); else keep.thirty_seconds = fields.thirty_seconds;
  }
  if (fields.key_facts) Object.entries(fields.key_facts).forEach(([k, v]) => { const w = judge('key_facts.' + k); if (w) refused['key_facts.' + k] = w; else (keep.key_facts ||= {})[k] = v; });
  if (fields.display_name) { const w = judge('display_name'); if (w) refused.display_name = w; else keep.display_name = fields.display_name; }
  return { keep, refused };
}

// writer, reviewer: llm clients ({ generate }). Returns { key, kind, fields, dropped: { path: why }, rounds, reviewerModel }.
export async function writePageFields({ entry, writer, reviewer, log = () => {} }) {
  const kind = kindOf(entry), text = entryText(entry), wantName = needsName(entry), currentName = nameOf(entry).name;
  const itemId = 'pagefields:' + entry.key;
  let complaints = [], best = {}, lastRefused = {};
  for (let round = 1; round <= ROUNDS; round++) {
    const w = await writer.generate({ system: WRITER_SYSTEM, prompt: writerPrompt({ entry, kind, text, wantName, currentName, complaints }), responseSchema: WRITER_SCHEMA, itemId: `${itemId}:w${round}` });
    const { fields, problems } = checkDraft({ entry, draft: w.data, kind, wantName });
    // what passed an earlier round stays unless this round passes it again (a rewrite never loses a field that was already good)
    const candidate = { ...fields };
    let refused = Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, 'refused by code: ' + v.join('; ')]));
    if (Object.keys(candidate).length) {
      const r = await reviewer.generate({ system: REVIEWER_SYSTEM, prompt: reviewerPrompt({ entry, kind, text, draft: candidate }), responseSchema: REVIEWER_SCHEMA, itemId: `${itemId}:r${round}` });
      const a = applyVerdicts({ fields: candidate, verdicts: r.data.verdicts, text });
      refused = { ...refused, ...a.refused };
      best = merge(best, a.keep);
    }
    lastRefused = refused;
    log(`${entry.key} round ${round}: kept ${Object.keys(best).join(', ') || 'nothing'}; refused ${Object.keys(refused).join(', ') || 'nothing'}`);
    const open = Object.keys(refused).filter((p) => !has(best, p));
    if (!open.length) return { key: entry.key, kind, fields: best, dropped: {}, rounds: round, reviewerModel: reviewer.model };
    complaints = open.map((p) => `${p}: ${refused[p]}`);
  }
  const dropped = Object.fromEntries(Object.entries(lastRefused).filter(([p]) => !has(best, p)));
  return { key: entry.key, kind, fields: best, dropped, rounds: ROUNDS, reviewerModel: reviewer.model };
}

const merge = (a, b) => ({ ...a, ...b, ...(a.key_facts || b.key_facts ? { key_facts: { ...(a.key_facts || {}), ...(b.key_facts || {}) } } : {}) });
const has = (f, path) => { const [top, sub] = path.split('.'); return top === 'thirty_seconds' ? !!f.thirty_seconds : sub ? !!(f[top] && f[top][sub]) : !!f[top]; };
