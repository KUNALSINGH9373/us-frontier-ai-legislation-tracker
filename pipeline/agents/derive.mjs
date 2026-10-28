// Facts that are already exact fields in the official record are written by code, not by a model.
// A model can only get these wrong, and the smaller models drift when asked for them. What stays with the model is the
// part that needs reading: what the item does, who it covers, and whether it belongs in the tracker.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']; // the tracker's own spellings
export const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
import { eventsFrom, trackerStatus, normNumber } from '../grabber/sources/legiscan.mjs';
import { actionKind } from '../compare/congress.mjs';
const TYPE_LABEL = { hr: 'H.R.', s: 'S.', hjres: 'H.J.Res.', sjres: 'S.J.Res.', hres: 'H.Res.', sres: 'S.Res.', hconres: 'H.Con.Res.', sconres: 'S.Con.Res.' };

// "Sen. Sanders, Bernard [I-VT]"  ->  "Sen. Bernard Sanders (I-VT)"
export function sponsorText(sponsors) {
  return (sponsors || []).slice(0, 1).map((s) => {
    const m = /^(Rep\.|Sen\.|Del\.|Resident Commissioner)\s+([^,]+),\s*([^\[]+?)\s*\[([A-Z])-([A-Z]{2})/.exec(s.fullName || '');
    return m ? `${m[1]} ${m[3]} ${m[2]} (${m[4]}-${m[5]})` : s.fullName;
  }).join('; ') || null;
}

// A Congress.gov action -> the tracker's event type, or null for a procedural step (cloture, amendments, motions, held at the desk,
// messages between chambers). The rules are compare/congress.mjs actionKind, the same ones the comparison step uses.
export { actionKind };
export const eventFor = (action) => actionKind(action && action.text).type;

// A bill on export controls for advanced AI chips cites their export classifications (ECCN 3A090 / 4A090). It is filed under
// G.3 (compute and export controls) by rule; a model chose D or F for all three such bills in the 27 Oct 2026 test.
export const exportControlBill = (text, title = '') => /\b[34]A090\b/.test(text || '') && /\b(?:export|reexport|licen[cs]e)/i.test(`${title} ${text}`);

// A state bill's number in the tracker's two styles. LegiScan "SB00086" -> title "S.B. 86", short name "CT SB 86"; one-letter
// prefixes keep the tracker's existing spelling without a space: "S10373" -> "S.10373" in both (as in "NY S.10373").
export function stateNumber(billNumber) {
  const n = normNumber(billNumber), m = n && /^([A-Z]+)(\d+)$/.exec(n);
  if (!m) return { dotted: String(billNumber), short: String(billNumber) };
  const [, l, d] = m;
  return l.length === 1 ? { dotted: `${l}.${d}`, short: `${l}.${d}` } : { dotted: `${[...l].join('.')}. ${d}`, short: `${l} ${d}` };
}

// LegiScan sponsors -> "Rep. Anastasia Travers (D) with 3 co-sponsors; joint sponsor Rep. Matthew Gwynn (R)". Primary sponsors first, in
// LegiScan's order (sponsor_type_id 1; when none is marked primary, the first listed). Co-sponsors (2) are counted, joint sponsors (3) named.
// A party is written only when it is a party letter (Nebraska's nonpartisan "N" is left out). A committee sponsor is labelled as one
// ("Legislative Modernization (committee)") unless its name already says so ("General Law Committee").
// LegiScan's role is not trusted on its own: a primary sponsor's chamber is the bill's (S... = Senate; H... or A... = House or Assembly).
// When LegiScan's role names the other chamber (NJ SR52: "Rep" for two Senators), the bill text decides ("Senator RAJ MUKHERJI"); when
// the text does not say either, no title is written (never a guess). bill: { bill_number, text } (optional).
const PARTY = new Set(['D', 'R', 'I', 'L', 'G']);
const chamberOf = (billNumber) => { const n = normNumber(billNumber) || ''; return /^S/.test(n) ? 'Sen' : /^[HA]/.test(n) ? 'Rep' : null; };
const titleInText = (text, last) => {
  if (!text || !last) return null;
  const esc = String(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\bSenators?\\s+(?:[A-Z][A-Za-z.'-]*\\s+){0,3}${esc}\\b`, 'i').test(text)) return 'Sen';
  if (new RegExp(`\\b(?:Representatives?|Assembly(?:man|woman|member|men|women|members)|Delegates?)\\s+(?:[A-Z][A-Za-z.'-]*\\s+){0,3}${esc}\\b`, 'i').test(text)) return 'Rep';
  return null;
};
const roleFor = (s, primary, bill) => {
  if (!primary || !bill) return s.role;
  const want = chamberOf(bill.bill_number);
  if (!want || !s.role || !['Sen', 'Rep'].includes(s.role) || s.role === want) return s.role;
  const t = titleInText(bill.text, s.last_name || String(s.name || '').split(/\s+/).pop());
  return t === want ? t : null;
};
const committeeName = (n) => (/\bcommittee\b/i.test(n || '') ? n : `${n} (committee)`);
const stateSponsor = (s, primary, bill) => { if (s.committee_sponsor) return committeeName(s.name); const r = roleFor(s, primary, bill); return `${r ? r + '. ' : ''}${s.name}${PARTY.has(s.party) ? ` (${s.party})` : ''}`; };
export function stateSponsorText(sponsors, bill = null) {
  const all = [...(sponsors || [])].sort((a, b) => (a.sponsor_order || 0) - (b.sponsor_order || 0));
  let primary = all.filter((s) => s.sponsor_type_id === 1);
  if (!primary.length) primary = all.slice(0, 1);
  if (!primary.length) return null;
  const co = all.filter((s) => s.sponsor_type_id === 2 && !primary.includes(s)).length, joint = all.filter((s) => s.sponsor_type_id === 3 && !primary.includes(s));
  return primary.map((s) => stateSponsor(s, true, bill)).join('; ') + (co ? ` with ${co} co-sponsor${co === 1 ? '' : 's'}` : '') + (joint.length ? `; joint sponsor${joint.length === 1 ? '' : 's'} ${joint.map((s) => stateSponsor(s, false, bill)).join(', ')}` : '');
}

// A state bill's status, by the same rule the comparison step uses for tracked state bills (compare/legiscan.mjs, from LegiScan's status
// code): enacted when LegiScan marks it passed into law, failed when vetoed or failed, otherwise pending. "stalled" is a person's judgement.
export const stateStatus = (bill) => trackerStatus(bill && bill.status);

// The sections a new state bill may be filed in, by rule from its status (the tracker's own sections): an enacted bill is a law (A, enacted
// state frontier-developer laws) or an IVO / AI-auditor measure (C); a pending or failed one is a bill (B, pending, stalled and failed state
// bills; B.2, catastrophic-risk regulation without a frontier threshold) or an IVO / AI-auditor measure (C). Which one needs a reading of the
// text, so the Generator chooses within these, and code refuses anything else.
export const stateSections = (status) => (status === 'enacted' ? ['A', 'C'] : ['B', 'B.2', 'C']);

// Returns { fields, events, section } with everything the record states exactly. section is null when it cannot be decided by rule.
export function deriveCreate({ item, raw }) {
  if (item.source === 'federal_register') {
    const d = raw.document, n = d.executive_order_number, isEo = !!n;
    let signed = d.signing_date;
    if (!signed && isEo) { const m = /Executive Order \d+ of ([A-Z][a-z]+) (\d{1,2}), (20\d\d)/.exec(raw.text || ''); if (m) signed = `${m[3]}-${String(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    const status = [signed ? `Signed ${longDate(signed)}` : null, `published in the Federal Register ${longDate(d.publication_date)}${d.citation ? ` (${d.citation})` : ''}`, d.effective_on ? `effective ${longDate(d.effective_on)}` : null].filter(Boolean).join('; ');
    const events = [];
    if (signed) events.push({ date: signed, precision: 'day', type: 'Signed / enacted', text: isEo ? `Executive Order ${n} signed` : `${d.type} signed` });
    events.push({ date: d.publication_date, precision: 'day', type: 'Introduced / published', text: `Published in the Federal Register${d.citation ? ` (${d.citation})` : ''}` });
    if (d.effective_on) events.push({ date: d.effective_on, precision: 'day', type: 'Effective', text: 'Takes effect' });
    const agencies = (d.agency_names || []).join('; ');
    return {
      fields: {
        title: isEo ? `Executive Order ${n}: ${d.title}` : d.title, short_name: trunc(isEo ? `EO ${n} (${d.title})` : d.title, 100),
        sponsor_text: d.type === 'Presidential Document' ? 'President' : agencies, status_text: status, signed_text: signed ? longDate(signed) : null, effective_text: d.effective_on ? longDate(d.effective_on) : null
      },
      events, section: d.type === 'Presidential Document' ? 'G' : /Industry and Security/i.test(agencies) ? 'G.3' : null
    };
  }
  if (item.source === 'congress_gov') {
    const b = raw.bill, num = `${TYPE_LABEL[String(b.type).toLowerCase()] || b.type} ${b.number}`;
    const events = [];
    if (b.introducedDate) events.push({ date: b.introducedDate, precision: 'day', type: 'Introduced / published', text: `${num} introduced` });
    // The latest action when it is a milestone; else the latest milestone after the introduction (the most important one on its date).
    // A procedural latest action ("Held at the desk") is never the status line.
    const la = (b.latestAction && actionKind(b.latestAction.text).milestone ? b.latestAction : null) || (raw.actions || [])
      .filter((a) => a && a.actionDate && actionKind(a.text).milestone && actionKind(a.text).kind !== 'introduced')
      .sort((x, y) => y.actionDate.localeCompare(x.actionDate) || actionKind(y.text).importance - actionKind(x.text).importance)[0] || null;
    if (la && la.actionDate !== b.introducedDate && eventFor(la)) events.push({ date: la.actionDate, precision: 'day', type: eventFor(la), text: la.text.replace(/\.$/, '') });
    return {
      fields: {
        title: `${num} — ${b.title}`, short_name: trunc(`${num} ${b.title}`, 100), sponsor_text: sponsorText(b.sponsors),
        status_text: `Introduced / status: ${b.introducedDate ? longDate(b.introducedDate) : 'date not stated'}${la ? `; ${la.text.replace(/\.$/, '')} (${longDate(la.actionDate)})` : ''}`
      },
      events, section: exportControlBill(raw.text, b.title) ? 'G.3' : null
    };
  }
  if (item.source === 'legiscan') {
    const b = raw.bill, num = stateNumber(b.bill_number), status = stateStatus(b);
    // Every non-routine history action is an event (grabber/sources/legiscan.mjs eventsFrom, the rules Tier A uses for tracked state bills).
    const events = eventsFrom(b).map(({ date, precision, type, text }) => ({ date, precision, type, text: text.replace(/\.$/, '') }));
    const intro = events.find((e) => e.type === 'Introduced / published') || ((b.history || [])[0] && { date: b.history[0].date }), last = events[events.length - 1];
    const status_text = `Status: Introduced ${intro && intro.date ? longDate(intro.date) : 'date not stated'}${last && last !== intro ? `; ${last.text} (${longDate(last.date)})` : ''}`;
    return {
      fields: { title: `${num.dotted} — ${b.title}`, short_name: trunc(`${b.state} ${num.short}`, 100), sponsor_text: stateSponsorText(b.sponsors, { bill_number: b.bill_number, text: raw.text }), status_text },
      events, section: null, sections: stateSections(status), status, jurisdiction: b.state, state: b.state, session: b.session && b.session.session_name
    };
  }
  throw new Error('no derivation for ' + item.source);
}
