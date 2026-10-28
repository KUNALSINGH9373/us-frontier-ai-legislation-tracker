// Long bills read section by section. An omnibus bill (MA S.3228 is about 600,000 characters) cannot be sent whole, so it is split
// at the bill's own section headings and only the sections that matter for a frontier-AI entry are sent: definitions, coverage,
// duties, enforcement and penalties, whistleblower protections, effective dates, and anything that names frontier or AI terms.
// Every selected piece is copied from the bill exactly (a quote from the selection is a quote from the bill), sections are kept
// whole (a section over the limit is split only at its own (a)/(b) subsections), and a closing note lists what was left out.
// Code checks still verify every quote against the FULL text; this only decides what the models read.

export const SECTION_CHARS = 90000; // the most a selection may hold, note included

// A heading at the start of a line: federal "SEC. 2.", state "Section 1." / "SECTION 33." / "Sec. 33.", MA "Section 3A." and
// "Section 9A 1/2.", "§ 3.". A printed line number left in front of it ("3208 SECTION 164.") is allowed.
const HEADING = /^(?:\d{1,5}[ \t]+)?((SECTION|Section|SEC\.|Sec\.|§)[ \t]*(\d{1,4}[A-Z]{0,3}(?:[ \t]+1\/2)?)\.)(?=[ \t]|\r?\n|$)/gm;
const CHAPTER = /^(?:\d{1,5}[ \t]+)?CHAPTER[ \t]+(\d{1,4}[A-Z]{0,3}(?:[ \t]+1\/2)?)\.?[ \t]*$/gm;

// [{ heading, label, level, parent, chapter, start, end, text }] in order. text is source.slice(start, end), heading included.
// When a bill numbers its own sections in capitals ("SECTION 164.", "SEC. 4.") and inserts whole chapters with their own
// "Section 1." headings, the inserted sections are level 2 under the bill section that inserts them.
export function splitSections(source) {
  const s = String(source || ''), heads = [];
  for (const m of s.matchAll(HEADING)) heads.push({ start: m.index, heading: m[1], style: m[2], num: m[3] });
  if (!heads.length) return s.trim() ? [{ heading: '', label: '(whole text)', level: 1, parent: null, chapter: null, start: 0, end: s.length, text: s }] : [];
  const first = heads[0].style, top = (first === 'SECTION' || first === 'SEC.') && heads.filter((h) => h.style === first).length >= 3 ? first : null;
  const chapters = [...s.matchAll(CHAPTER)].map((m) => ({ at: m.index, id: m[1] }));
  const out = [];
  if (heads[0].start > 0 && s.slice(0, heads[0].start).trim()) out.push({ heading: '', label: '(opening)', level: 1, parent: null, chapter: null, start: 0, end: heads[0].start, text: s.slice(0, heads[0].start) });
  let parent = null;
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].start : s.length;
    const level = top && h.style !== top && parent ? 2 : 1;
    const sec = { heading: h.heading, label: h.heading, level, parent: null, chapter: null, start: h.start, end, text: s.slice(h.start, end) };
    if (level === 1) parent = sec;
    else {
      sec.parent = parent;
      const ch = chapters.filter((c) => c.at > parent.start && c.at < h.start).pop();
      sec.chapter = ch ? ch.id : null;
      sec.label = `${parent.heading.replace(/\.$/, '')} (${ch ? `chapter ${ch.id} ` : ''}${h.heading.replace(/\.$/, '')})`;
    }
    out.push(sec);
  });
  return out;
}

const STRONG = /\bfrontier\b|foundation models?\b|\b10\^2\d\b|floating[- ]point operations|catastrophic risks?\b|general[- ]purpose (?:AI|artificial intelligence)|large language models?\b/gi;
const WEAK = /artificial intelligence|\bAI\b|machine[- ]learning|automated decision/gi;
const DEFINES = /\bAs used in\b|\bDefinitions?\b|following words shall have the following meanings|\bFor (?:the )?purposes of this (?:act|chapter|section|title)\b/;
const DEFINED_TERM = /["“][A-Za-z][^"”\n]{1,60}["”],?\s+(?:means|has the|shall mean|an? |the )/g;
const APPLIES = /\b(?:shall|does) not apply\b|\bapplies to\b|\bapplicab(?:le|ility)\b/i;
const DUTY_ACTOR = /\bdevelopers?\b|\bmodels?\b|\bdeployers?\b/i;
const ENFORCES = /civil penalt(?:y|ies)|attorney general|\bpenalt(?:y|ies)\b|\binjunctive relief\b/i;
const WHISTLE = /whistle-?blow|retaliat/i;
const EFFECTIVE = /\btakes? effect\b|\beffective\b/i;
const LINE_ITEM = /^\s*\d{4}-\d{4}\b/gm; // an appropriation line item ("1596-7066 For a bridge funding reserve ...")
const count = (re, t) => (t.match(re) || []).length;

function features(t) {
  const strong = count(STRONG, t), weak = count(WEAK, t);
  const def = DEFINES.test(t) || count(DEFINED_TERM, t) >= 3;
  return { strong, ai: 3 * strong + weak, def, apply: APPLIES.test(t), duty: /\bshall\b/.test(t) && DUTY_ACTOR.test(t), enf: ENFORCES.test(t), whistle: WHISTLE.test(t), eff: EFFECTIVE.test(t), items: count(LINE_ITEM, t) };
}

// A section over the limit is split at its own subsections, "(a)" or "(c)(1)" starting a line, into whole runs that each fit.
// null when a single subsection is still over the limit (it is then never sent cut off).
function bySubsection(sec, limit) {
  const t = sec.text, cuts = [0];
  for (const m of t.matchAll(/\n[ \t]*(?=\([a-z]{1,2}\)[ (\w])/g)) cuts.push(m.index + 1);
  cuts.push(t.length);
  const pieces = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] > cuts[i]) pieces.push([cuts[i], cuts[i + 1]]);
  if (pieces.some(([a, b]) => b - a > limit)) return null;
  const runs = [];
  for (const [a, b] of pieces) {
    const last = runs[runs.length - 1];
    if (last && b - last[0] <= limit) last[1] = b; else runs.push([a, b]);
  }
  return runs.map(([a, b], k) => ({ ...sec, label: `${sec.label} (part ${k + 1} of ${runs.length})`, start: sec.start + a, end: sec.start + b, text: t.slice(a, b) }));
}

// { text, chunks, selected, omitted, sections }: text = the selected sections in their original order, joined by "[...]" where
// something was left out, then a note naming the omitted sections; chunks = each verbatim span of the source; selected / omitted =
// section labels. Nothing relevant found: text '' and no chunks (the caller keeps its old behaviour).
export function relevantSections(source, { maxChars = SECTION_CHARS } = {}) {
  const s = String(source || ''), all = splitSections(s);
  const NOTE_ROOM = Math.min(3000, Math.floor(maxChars / 5)), budget = maxChars - NOTE_ROOM;
  let units = [];
  for (const sec of all) {
    if (sec.text.length <= budget) { units.push(sec); continue; }
    const parts = bySubsection(sec, budget);
    if (parts) units.push(...parts); else units.push({ ...sec, tooBig: true });
  }
  units = units.map((u, i) => ({ ...u, i, f: features(u.text) }));

  // A bill section (or inserted chapter) that names frontier terms anywhere makes its other sections relevant too; an effective-date
  // section that names such a chapter ("chapter 93M ... shall take effect on July 1, 2027") is relevant wherever it sits.
  const groupOf = (u) => (u.parent || u).start;
  const strongGroups = new Set(units.filter((u) => u.f.strong).map(groupOf));
  const anchors = [...new Set(units.filter((u) => u.f.strong && u.chapter).map((u) => u.chapter))];
  const anchorRe = anchors.length ? new RegExp(`\\bchapters?\\s+(?:[0-9A-Z]+,?\\s+(?:and\\s+)?)*(?:${anchors.join('|')})\\b`) : null;
  // A section that points by number at a frontier section of the same bill ("for a violation of section 4", "Sections 3 to 5 shall
  // take effect") is relevant too; a pointer into other law ("section 4 of chapter 6C") is not.
  const numOf = (h) => (String(h).match(/(\d+[A-Z]{0,3})/) || [, null])[1];
  const strongNums = new Set(units.filter((u) => u.f.strong && u.level === 1).map((u) => numOf(u.heading)).filter(Boolean));
  const pointsAtStrong = (t) => {
    for (const m of t.matchAll(/\bsections?\s+(\d+[A-Z]{0,3})(?:\s*(?:to|through|-)\s*(\d+))?(?:,?\s+(?:and\s+)?(\d+[A-Z]{0,3}))?(?!\s*(?:of|in)\s+(?:chapter|title|the|said|public|this\s+title))/gi)) {
      const [, a, b, c] = m, nums = [a, c];
      if (b && /^\d+$/.test(a)) for (let k = +a; k <= +b && k - a < 200; k++) nums.push(String(k));
      if (nums.some((x) => x && strongNums.has(x))) return true;
    }
    return false;
  };
  for (const u of units) {
    const f = u.f, inGroup = strongGroups.has(groupOf(u)) || (u.level === 1 && pointsAtStrong(u.text)), anchored = !!(anchorRe && anchorRe.test(u.text));
    const signal = f.def || f.apply || f.duty || f.enf || f.whistle || f.eff;
    const eligible = !u.tooBig && !(f.items >= 3 && !f.strong) && (f.ai > 0 || (inGroup && signal) || (anchored && f.eff));
    u.score = !eligible ? 0 : Math.min(f.ai, 40) + (f.def ? 6 : 0) + (f.def && f.strong ? 10 : 0) + (f.duty ? 4 : 0) + (f.enf ? 4 : 0) + (f.whistle ? 4 : 0) + (f.apply ? 3 : 0) + (f.eff ? 2 : 0) + (inGroup ? 5 : 0) + (anchored && f.eff ? 8 : 0);
  }
  const ranked = units.filter((u) => u.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (!ranked.length) return { text: '', chunks: [], selected: [], omitted: units.map((u) => u.label), sections: all.length };
  const picked = new Set();
  let used = 0;
  for (const u of ranked) if (used + u.text.length + 7 <= budget) { picked.add(u); used += u.text.length + 7; }
  // A short bill section that inserts a picked chapter ("SECTION 164. ... inserting after chapter 93L the following 2 chapters:-
  // CHAPTER 93M. TRANSPARENCY IN FRONTIER ARTIFICIAL INTELLIGENCE ACT") says where the picked sections sit: kept when it fits.
  for (const u of [...picked]) {
    const p = u.parent && units.find((x) => x.start === u.parent.start && x.end === u.parent.end);
    if (p && !picked.has(p) && p.text.length <= 1500 && used + p.text.length + 7 <= budget) { picked.add(p); used += p.text.length + 7; }
  }
  const inOrder = units.filter((u) => picked.has(u));
  const spans = [];
  for (const u of inOrder) {
    const last = spans[spans.length - 1];
    if (last && last[1] === u.start) last[1] = u.end; else spans.push([u.start, u.end]);
  }
  const chunks = spans.map(([a, b]) => s.slice(a, b));
  const omitted = units.filter((u) => !picked.has(u)).map((u) => u.label);
  const body = chunks.map((c) => c.trim()).join('\n\n[...]\n\n');
  const note = (list) => `\n\n[NOTE: SOURCE above is a selection from a ${s.length}-character text: ${inOrder.length} of ${units.length} sections, chosen for frontier AI (definitions, coverage, duties, enforcement and penalties, effective dates). Each section is copied whole and word for word; "[...]" marks omitted text. Omitted sections: ${list.replace(/\.$/, '')}.]`;
  let shown = Math.min(omitted.length, 40), text;
  do { text = body + note(omitted.slice(0, shown).join(', ') + (omitted.length > shown ? ` and ${omitted.length - shown} more` : '') || 'none'); shown = Math.floor(shown / 2); } while (text.length > maxChars && shown > 0);
  if (text.length > maxChars) text = body + note(`${omitted.length} sections`);
  return { text, chunks, selected: inOrder.map((u) => u.label), omitted, sections: all.length };
}

// A long text whose section headings could not be read (IL H.B. 2949, a 1.25-million-character budget bill printed with its line
// numbers run into the text, so "Section 40-15." never starts a line) is not judged on its opening: the WHOLE text is searched for
// frontier-AI markers, and the passages around them are read instead, each copied word for word. Same shape as relevantSections;
// no marker anywhere: text '' and no chunks.
const MARKERS = /\bfrontier\b|foundation models?\b|\b10\^2\d\b|floating[- ]point operations|catastrophic risks?\b|general[- ]purpose (?:AI|artificial intelligence)|large language models?\b|artificial intelligence safety|\bAI safety\b|independent verification organi[sz]ation|model weights|advanced (?:AI|artificial intelligence) (?:chips?|models?|systems?)/gi;
export function markerPassages(source, { maxChars = SECTION_CHARS, before = 2000, after = 6000 } = {}) {
  const s = String(source || ''), spans = [];
  for (const m of s.matchAll(MARKERS)) {
    const a = Math.max(0, m.index - before), b = Math.min(s.length, m.index + after), last = spans[spans.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else spans.push([a, b]);
  }
  if (!spans.length) return { text: '', chunks: [], selected: [], omitted: [], sections: 0 };
  const room = maxChars - 600, picked = [];
  let used = 0;
  for (const [a, b] of spans) { const n = Math.min(b - a, room - used); if (n <= 200) break; picked.push([a, a + n]); used += n + 7; }
  const chunks = picked.map(([a, b]) => s.slice(a, b));
  const text = chunks.join('\n\n[...]\n\n') + `\n\n[NOTE: SOURCE above is ${picked.length} passage(s) from a ${s.length}-character text, chosen because they name frontier-AI terms; each is copied word for word and "[...]" marks omitted text${picked.length < spans.length ? `; ${spans.length - picked.length} more passage(s) did not fit` : ''}.]`;
  return { text, chunks, selected: picked.map(([a, b]) => `characters ${a}-${b}`), omitted: [], sections: 0 };
}
