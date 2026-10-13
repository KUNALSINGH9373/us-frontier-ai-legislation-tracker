// Facts that are already exact fields in the official record are written by code, not by a model.
// A model can only get these wrong, and the smaller models drift when asked for them. What stays with the model is the
// part that needs reading: what the item does, who it covers, and whether it belongs in the tracker.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']; // the tracker's own spellings
export const longDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const TYPE_LABEL = { hr: 'H.R.', s: 'S.', hjres: 'H.J.Res.', sjres: 'S.J.Res.', hres: 'H.Res.', sres: 'S.Res.', hconres: 'H.Con.Res.', sconres: 'S.Con.Res.' };

// "Sen. Sanders, Bernard [I-VT]"  ->  "Sen. Bernard Sanders (I-VT)"
export function sponsorText(sponsors) {
  return (sponsors || []).slice(0, 1).map((s) => {
    const m = /^(Rep\.|Sen\.|Del\.|Resident Commissioner)\s+([^,]+),\s*([^\[]+?)\s*\[([A-Z])-([A-Z]{2})/.exec(s.fullName || '');
    return m ? `${m[1]} ${m[3]} ${m[2]} (${m[4]}-${m[5]})` : s.fullName;
  }).join('; ') || null;
}

const eventFor = (action) => {
  const t = action.text || '';
  if (/became public law|signed by president/i.test(t)) return 'Signed / enacted';
  if (/vetoed/i.test(t)) return 'Vetoed / failed / rescinded';
  if (/passed|agreed to|ordered to be reported|reported by/i.test(t)) return 'Passed / advanced';
  if (/referred to|hearing/i.test(t)) return 'Referred / stalled / hearing';
  return null;
};

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
    const la = b.latestAction;
    if (la && la.actionDate !== b.introducedDate && eventFor(la)) events.push({ date: la.actionDate, precision: 'day', type: eventFor(la), text: la.text.replace(/\.$/, '') });
    return {
      fields: {
        title: `${num} — ${b.title}`, short_name: trunc(`${num} ${b.title}`, 100), sponsor_text: sponsorText(b.sponsors),
        status_text: `Introduced / status: ${b.introducedDate ? longDate(b.introducedDate) : 'date not stated'}${la ? `; ${la.text.replace(/\.$/, '')} (${longDate(la.actionDate)})` : ''}`
      },
      events, section: null
    };
  }
  throw new Error('no derivation for ' + item.source);
}
