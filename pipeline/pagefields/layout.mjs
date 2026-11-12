// Which entry page layout an entry uses, and what its written page fields may hold. Mirrors billKind / billName in
// web/Tracker.dc.html: change one, change the other.
import crypto from 'crypto';
export const KIND_HEADINGS = {
  bill: ['Who', 'Must do', 'Or else'],
  exec: ['Who it directs', 'What it orders', 'Binding on companies?'],
  lit: ['Who v. who', 'About', 'Where it is'],
  watch: ['What we watch', 'Why', 'Latest']
};
// Key facts rows the record cannot give by code, by layout (entry.key_facts).
export const KIND_FACTS = { bill: ['enforced_by'], exec: ['issued_by', 'lead_agencies'], lit: ['court', 'judge', 'plaintiff', 'defendants', 'lawyers'], watch: [] };

export function kindOf(e) {
  if (e.type === 'executive') return 'exec';
  if (e.type === 'export') return /\b(?:H\.\s?R\.|S\.)\s?\d|\bAct\b/.test(e.title) ? 'bill' : 'exec';
  if (e.type === 'litigation') return / v\. /.test(e.title) ? 'lit' : 'watch';
  return 'bill';
}

// The title the page shows without a display_name, and whether that is good enough. A name is needed when the page would show
// the tracker's short name (which carries notes like "(no threshold)" or "(Ch. 699 → Ch. 96)") or an official title that is a
// chapter number or an "An Act relative to ..." line.
export function nameOf(e) {
  const t = e.title.replace(/\s*⟨[^⟩]*⟩/g, ''), i = t.indexOf(' — ');
  if (kindOf(e) === 'lit') { const m = /^(.+? v\. .+?)(?:,? No\.|,|\s\(|$)/.exec(t); return { name: m ? m[1] : e.short_name, fallback: !m }; }
  const tidy = (n) => n.replace(/\s*\((?:moved from|see) [^)]*\)/gi, '').trim();
  if (i < 0) return { name: tidy(e.short_name), fallback: true };
  const before = tidy(t.slice(0, i)), after = tidy(t.slice(i + 3)), q = /^titled (?:the )?[“"]([^”"]+)[”"]/.exec(after);
  if (q) return { name: q[1], fallback: false };
  if ((/^[a-z]/.test(after) || /^(?:announced|discussion draft|draft|proposal|in development|not yet|reported|text not|voluntary)/i.test(after)) && !/^(?:[A-Z]{1,4}\.?\s?){1,3}\d[\d\s/.&,A-Z-]*$/.test(before)) return { name: before, fallback: false };
  if (/^(?:Chapter \d|[“"]An Act|An Act)/.test(after)) return { name: e.short_name, fallback: true };
  return { name: after.charAt(0).toUpperCase() + after.slice(1), fallback: false };
}
export const needsName = (e) => { const n = nameOf(e); return n.fallback || /→/.test(n.name) || !/[a-z]{3}/.test(n.name); };

// The entry's own checked text, labelled: the only thing the writer may draw on and the reviewer checks against.
export function entryText(e) {
  const L = [];
  const add = (label, v) => { if (v) L.push(`${label}: ${v}`); };
  add('TITLE', e.title.replace(/\s*⟨[^⟩]*⟩/g, ''));
  add('SHORT NAME', e.short_name);
  add('TYPE', e.type); add('STATUS', e.status); add('JURISDICTION', e.state ? e.state + ' (state)' : 'federal');
  add('SPONSORS', e.sponsor_text);
  add('WHAT IT DOES', e.mechanism);
  add('THRESHOLDS', e.thresholds);
  add('PENALTIES', e.penalties);
  add('SIGNED', e.signed_text); add('EFFECTIVE', e.effective_text);
  add('STATUS AS RECORDED', e.status_text);
  (e.events || []).forEach((v) => L.push(`EVENT ${v.date}: ${v.type}: ${v.text}`));
  const answers = (o, label) => Object.entries(o || {}).forEach(([k, d]) => L.push(`${label} ${k}: ${d.value}: ${d.summary}${d.quote ? ` (bill words: "${d.quote}")` : ''}`));
  answers(e.duties, 'CHECKLIST');
  answers(e.exec_checklist, 'ORDER CHECKLIST');
  if (e.plain && e.plain.items) Object.entries(e.plain.items).forEach(([k, list]) => (list || []).forEach((i) => L.push(`PLAIN ${k}: ${i.text} (bill words: "${i.quote}")`)));
  return L.join('\n');
}

// The checksum of the entry's own checked text, stored with the page fields (page_verification.basis_sha256): a different checksum
// means the text they were written from has changed, and the pipeline writes them again.
export const basisOf = (e) => crypto.createHash('sha256').update(entryText(e)).digest('hex');
