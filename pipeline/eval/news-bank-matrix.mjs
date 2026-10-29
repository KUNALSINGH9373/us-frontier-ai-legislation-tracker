// The phrase-bank matrix (eval/news-writer-set.mjs, news/test-writer.mjs): every event class × representative fact sheets (vote missing,
// no votes against, a split vote, scheduled vs held, state vs federal, with and without signer / summary) × every variant.
// Each variant must render to a card that passes checkCard (news/writer.mjs), and every rendered card must pass the trap assertions
// below, which are independent of checkCard. Code only.
import { buildFactSheet, isResolution, isUnicameral, skipsExecutive } from '../news/factsheet.mjs';
import { BANK, slotsOf, render, cardsFrom, neutralCandidates } from '../news/phrasebank.mjs';
import { checkCard, bankCard } from '../news/writer.mjs';

export const TODAY = '2026-10-29';
const BASE = { chamber: 'Senate', committee: 'Senate Judiciary Committee', number: 'SB 1405', agency: 'National Institute of Standards and Technology', title: 'AI risk management framework', comments_close: '2026-11-30', court: 'U.S. District Court for the District of Colorado', nominee: 'Jordan Avery', position: 'Director of the National Institute of Standards and Technology', law_number: 'Chapter 178, Statutes of 2026', executive: 'Governor Gavin Newsom' };
const VOTES = { none: null, split: { yes: 30, no: 10 }, unanimous: { yes: 37, no: 0 } };

// Representative sheets for one class: { label, sheet, facts }.
export function sheetsFor(cls, entry) {
  const out = [];
  // multi-chamber: the Senate and the lower chamber (Assembly in CA, House federally); NE is unicameral (no other chamber, no next step)
  // review r4: bills passing their own and the other chamber (CA, NY, federal, both directions), Nebraska, DC, an acting governor, a resolution
  // review r5: Maine's LD (no origin), measures that skip the executive (CA ACA, NJ ACR, Montana HJ, a state SR / SCR / HM memorial,
  // federal H.Res and H.Con.Res), a federal joint resolution (goes to the President, never "into law")
  const JUR = [['ME', 'House', { number: 'LD 1234', executive: 'Governor Janet Mills' }], ['CA', 'Assembly', { number: 'ACA 1', executive: 'Governor Gavin Newsom' }], ['NJ', 'General Assembly', { number: 'ACR 10', executive: 'Governor Mikie Sherrill' }], ['MT', 'House', { number: 'HJ 4', executive: 'Governor Greg Gianforte' }], ['CA', 'Senate', { number: 'SR 5' }], ['CA', 'Senate', { number: 'SCR 12' }], ['MT', 'House', { number: 'HM 2' }], ['US', 'House', { number: 'H.Res. 12', executive: 'President Avery Lane' }], ['US', 'Senate', { number: 'H.Con.Res. 7', executive: 'President Avery Lane' }], ['US', 'House', { number: 'H.J.Res. 3', executive: 'President Avery Lane' }], ['CA', 'Senate'], ['CA', 'Assembly'], ['US', 'Senate'], ['US', 'House'], ['NE', 'Legislature'], ['CA', 'Senate', { number: 'AB 1018' }], ['CA', 'Assembly', { number: 'AB 1018' }], ['NY', 'Senate', { number: 'A 6453' }], ['NY', 'Assembly', { number: 'S 6953' }], ['US', 'Senate', { number: 'H.R. 1405' }], ['US', 'House', { number: 'H.R. 1405' }], ['DC', 'Council', { number: 'B 26-0123', executive: 'Mayor Muriel Bowser' }], ['CA', 'Senate', { executive: 'Acting Governor Eleni Kounalakis' }], ['KS', 'House', { number: 'HR 6023', executive: 'Governor Laura Kelly' }]];
  for (const [j, chamber, over] of JUR) for (const [vl, vote] of Object.entries(VOTES)) for (const signer of [true, false]) for (const withEntry of [true, false]) {
    const facts = { ...BASE, chamber, committee: `${chamber} Judiciary Committee`, ...(j === 'US' ? { number: 'S. 1405', executive: 'President Avery Lane', law_number: 'Public Law 119-55' } : {}), ...(j === 'NE' ? { number: 'LB 1405', executive: 'Governor Avery Lane' } : {}), ...(over || {}) };
    if (vote) facts.vote = vote;
    if (!withEntry) Object.assign(facts, { agency: 'NIST', court: 'Ninth Circuit', title: 'Doe v. Roe', position: 'Director of NIST' }); // short names: long ones push some headlines past 90
    if (!signer) delete facts.executive;
    const dates = cls === 'hearing-scheduled' ? [['scheduled', '2026-10-28', '2026-11-04'], ['past-hearing', '2026-10-01', '2026-10-08']] : cls === 'comment-period-closing' ? [['scheduled', '2026-10-28', null]] : [['held', '2026-10-27', null]];
    for (const [tl, date, hd] of dates) {
      const f = { ...facts, ...(hd ? { hearing_date: hd } : {}) };
      const event = { key: `${j}|x|${cls}|${date}|${vl}|${signer}|${withEntry}`, jurisdiction: j, class: cls, date, facts: f };
      out.push({ label: `${j}/${chamber}/${(over && over.number) || ''}/${vl}/${signer ? 'signer' : 'no-signer'}/${withEntry ? 'summary' : 'no-entry'}/${tl}`, event, sheet: buildFactSheet(event, withEntry ? entry : null, { today: TODAY }) });
    }
  }
  return out;
}

// Trap assertions on a rendered card, independent of checkCard. Returns problems.
const SIGN = /\b(sign\w*|into law|now law|became law|becomes law|enact\w*)\b/i, VETO = /\bveto\w*\b/i, SEND = /\b(sent|presented|delivered)\b[^.]{0,40}\b(governor|president)\b/i;
const FAIL = /\b(reject\w*|fail\w*|did not pass)\b/i, PASS = /\b(pass(?:ed|es)|approv\w*|advanc\w*|clears?)\b/i;
const CHAMBERS = /\b(senate|house|assembly|legislature|congress)\b/gi;
export function trapProblems(card, sheet) {
  const p = [], e = sheet.event, cls = e.class;
  // only the headline and the event sentence are the bank's claims; the summary and stage lines are the sheet's own words
  const body = card.body.split(/ (?=What it does: |What the bill would do: |What it would do: |Status: )/)[0];
  // official identifiers (Public Law 119-55, a docket) are not tallies
  const claim = [e.law_number, e.docket, e.document_number, sheet.bill && sheet.bill.short_title, sheet.bill && sheet.bill.number].filter(Boolean).reduce((t, x) => t.split(x).join(' '), `${card.headline}\n${body}`);
  if (/unanimous/i.test(claim) && !(e.vote && e.vote.no === 0)) p.push('unanimous without a 0 against');
  if (!e.vote && /\b\d+-\d+\b/.test(claim.replace(/\b\d{4}\b/g, ''))) p.push('a tally with no vote');
  if (e.vote && /\b\d+-\d+\b/.test(claim) && !claim.includes(`${e.vote.yes}-${e.vote.no}`)) p.push('a tally that is not the vote');
  if (SIGN.test(claim) && !['executive-signature', 'became-law', 'executive-order'].includes(cls)) p.push('signing/law words outside a signing class');
  if (VETO.test(claim) && !['executive-veto', 'veto-override-passage'].includes(cls)) p.push('veto words outside a veto class');
  if (SEND.test(claim) && cls !== 'executive-receipt') p.push('sent to the executive outside receipt');
  if (FAIL.test(claim) && !['failure', 'committee-failure'].includes(cls)) p.push('failure words outside a failure class');
  if (PASS.test(claim) && ['failure', 'committee-failure', 'withdrawal', 'introduction', 'referral-committee', 'hearing-held', 'hearing-scheduled', 'executive-veto', 'executive-receipt'].includes(cls)) p.push('passage words in a class that is not a passage');
  if (cls.startsWith('committee') && /\b(passes|passed) the (senate|house|assembly)\b/i.test(claim)) p.push('committee written as floor');
  const own = new Set([e.chamber, e.committee].filter(Boolean).flatMap((x) => (String(x).match(CHAMBERS) || []).map((w) => w.toLowerCase())));
  for (const m of claim.matchAll(CHAMBERS)) if (!own.has(m[1].toLowerCase())) p.push(`chamber "${m[1]}" is not the event's`);
  if (cls === 'hearing-scheduled' && !/\b(scheduled|will|schedules|to hold|set for)\b/i.test(claim)) p.push('scheduled hearing not written as upcoming');
  if (cls === 'hearing-scheduled' && /\b(held|heard)\b/i.test(claim)) p.push('scheduled hearing written as held');
  if (cls === 'hearing-held' && /\b(scheduled|will)\b/i.test(claim)) p.push('held hearing written as upcoming');
  // review r4 traps
  const all = `${card.headline}\n${card.body}`, b = sheet.bill || {};
  // review r5: no next step, ever; no future step outside a scheduled event; nothing beyond what the record shows
  if ('next' in sheet) p.push('the fact sheet carries a next step');
  if (/\b(next|heads? to|headed to|goes to|moves? to|awaits?|awaiting|transmittal|consideration (?:in|by))\b/i.test(all)) p.push('a next step');
  if (/\bwill\b/i.test(all) && !['hearing-scheduled', 'comment-period-closing'].includes(cls)) p.push('a future step ("will")');
  if (cls === 'concurrence' && /\bboth (chambers|houses)\b/i.test(`${card.headline}\n${body}`)) p.push('a concurrence written as passage in both chambers');
  if (skipsExecutive(b.number, b.jurisdiction) && /\b(governor|president|mayor|into law|enact\w*)\b/i.test(all)) p.push('executive wording for a measure that skips the executive');
  if (b.number && /^\s*LD\b/.test(b.number) && cls === 'passage' && /\b(other|second) chamber\b/i.test(all)) p.push('an origin read from Maine LD');
  if (isUnicameral(b.jurisdiction) && /\bboth chambers\b/i.test(`${all} ${sheet.stage || ''}`)) p.push('both chambers in a one-chamber legislature');
  if (b.jurisdiction === 'DC' && /\b(governor|into law|enact\w*)\b/i.test(all)) p.push('DC written with a governor or into law');
  if (['executive-signature', 'executive-veto', 'executive-order', 'presidential-memo', 'nomination'].includes(cls) && !e.executive && /\b(governor|president|mayor)\s+(signs|signed|vetoes|vetoed|issues|issued|nominates|nominated)\b/i.test(all)) p.push('a signer the record does not name');
  if (isResolution(b.number, b.jurisdiction) && /\binto law\b|\benact/i.test(all)) p.push('a resolution signed into law');
  if (/\bthe the\b/i.test(all)) p.push('the the');
  if (/What it does: /.test(card.body) && !['executive-signature', 'became-law', 'executive-order', 'presidential-memo', 'agency-rule-final', 'agency-guidance'].includes(cls)) p.push('What it does on a measure not in force');
  if (e.hearing_date && cls === 'hearing-scheduled' && card.body.includes(slotsOf(sheet).date) && e.hearing_date !== e.date) p.push('first-seen date given as the hearing day');
  return p;
}

// The matrix: per class, every variant checked on every sheet it applies to.
export function runMatrix(entry) {
  const rows = [], counts = {};
  for (const [cls, bank] of Object.entries(BANK)) {
    counts[cls] = { headlines: bank.H.length, bodies: bank.B.length, renderings: 0 };
    const usedH = new Set(), usedB = new Set();
    for (const { label, sheet } of sheetsFor(cls, entry)) {
      const s = slotsOf(sheet), H = bank.H.map((x, i) => [i, render(x, s, sheet)]).filter(([, r]) => r), B = bank.B.map((x, i) => [i, render(x, s, sheet)]).filter(([, r]) => r);
      const pass = (c) => !checkCard(c.check, sheet).length;
      // every variant is checked with every partner from the other list (all headline × body combinations)
      for (const [i, h] of H) {
        usedH.add(i);
        cardsFrom(sheet, [h], B.map(([, b]) => b)).forEach((card, j) => {
          counts[cls].renderings++;
          const t = trapProblems(card, sheet), c = checkCard(card.check, sheet);
          if (card.body.length > 400) c.push('body over 400');
          rows.push({ cls, label, kind: 'H', i, b: B[j][0], card, problems: [...c, ...t], wrong: t.length > 0, refused: c.length > 0 });
        });
      }
      // the template fallback's choice (news/templates.mjs: the most neutral variant), under the same traps (review r5 M5)
      const neutral = neutralCandidates(sheet).find((c) => !checkCard(c.check, sheet).length);
      if (neutral) { const t = trapProblems(neutral, sheet); rows.push({ cls, label, kind: 'neutral', card: neutral, problems: t, wrong: t.length > 0, refused: false }); }
      for (const [i] of B) usedB.add(i);
      // the chosen card for this sheet
      const r = bankCard({ event: { key: label + cls, class: cls }, sheet });
      if (r.card.written_by === 'bank') { const t = trapProblems(r.card, sheet); rows.push({ cls, label, kind: 'chosen', card: r.card, problems: t, wrong: t.length > 0, refused: false }); }
    }
    counts[cls].unused = [...bank.H.keys()].filter((i) => !usedH.has(i)).map((i) => 'H' + i).concat([...bank.B.keys()].filter((i) => !usedB.has(i)).map((i) => 'B' + i));
  }
  return { rows, counts };
}
