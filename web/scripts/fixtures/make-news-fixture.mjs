// Local test data for the automated News cards (pipeline/news/CONTRACT.md). Not published: web/scripts is never
// copied to docs/. Writes news-fixture.json = web/data/v2/news.json + automated items covering every card variant.
//   node web/scripts/fixtures/make-news-fixture.mjs
// then serve web/ and open Tracker.dc.html?news=scripts/fixtures/news-fixture.json&today=2026-10-29#/updates
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const news = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'data', 'v2', 'news.json'), 'utf8'));
const ver = (d) => ({ method: 'official-record', checked_at: d + 'T14:00:00Z' });
const A = (o) => ({ origin: 'automated', verification: ver(o.date), statements: [], stage: null, next: '', status: 'confirmed', links: [], tracker: null, ...o,
  event_key: `${o.jur}|${o.tracker || '-'}|${o.class}|${o.date}` });

const items = [
  A({ jur: 'US', date: '2026-10-27', kind: 'federal', class: 'passage', tracker: 'h-r-9925-frontier-act', stage: 'passed-chamber',
    title: 'House passes H.R. 9925, the FRONTIER Act, 241 to 183',
    body: 'The House passed H.R. 9925 on a recorded vote of 241 to 183. The bill now goes to the Senate.',
    next: 'Referral to a Senate committee; no Senate date is on the record.',
    links: [{ t: 'Congress.gov: H.R. 9925 actions', u: 'https://www.congress.gov/bill/119th-congress/house-bill/9925/all-actions' }],
    statements: [{ publisher: 'Rep. Obernolte', t: 'House Passes Bipartisan FRONTIER Act', u: 'https://obernolte.house.gov/media/press-releases/house-passes-frontier-act' },
      { publisher: 'House Science Committee', t: 'Statement on Floor Passage of H.R. 9925', u: 'https://science.house.gov/press-releases/hr-9925-passage' }] }),
  A({ jur: 'PA', date: '2026-10-28', kind: 'state', class: 'committee-passage', tracker: 'pa-h-b-2800-ai-risk-prevention-act', stage: 'committee',
    title: 'Pennsylvania House Communications and Technology Committee reports H.B. 2800 as amended',
    body: 'The committee voted 15 to 10 to report H.B. 2800 as amended to the full House.', next: 'Second consideration on the House floor.',
    links: [{ t: 'PA General Assembly: H.B. 2800', u: 'https://www.palegis.us/legislation/bills/2025/hb2800' }],
    statements: [{ publisher: 'PA House Democrats', t: 'AI Risk Prevention Act clears committee', u: 'https://www.pahouse.com/InTheNews/NewsRelease/?id=140001' }] }),
  A({ jur: 'CA', date: '2026-10-26', kind: 'state', class: 'executive-signature', tracker: 'ca-sb-813-ivos', stage: 'law',
    title: 'Governor signs SB 813 (Chapter 612, Statutes of 2026)', body: 'The Governor signed SB 813; the Secretary of State chaptered it as Chapter 612.',
    next: 'Takes effect January 1, 2027.', links: [{ t: 'leginfo.legislature.ca.gov: SB 813 history', u: 'https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=202520260SB813' }] }),
  A({ jur: 'US', date: '2026-10-24', kind: 'federal', class: 'hearing-scheduled', tracker: 's-5576-warner-schatz-kim-ai-risk-management-and-security-act', stage: 'committee',
    title: 'Senate Commerce schedules a hearing on S. 5576 for November 4', body: 'The Committee on Commerce, Science, and Transportation noticed a full-committee hearing on S. 5576.',
    next: 'Hearing on 4 Nov 2026, 10:00, Russell 253.', links: [{ t: 'Senate Commerce hearing notice', u: 'https://www.commerce.senate.gov/2026/11/hearing-s-5576' }] }),
  A({ jur: 'US', date: '2026-10-25', kind: 'executive', class: 'comment-period-open', comments_close: '2026-11-03', facts: { agency: 'NIST', document_number: '2026-21877', comments_close: '2026-11-03' },
    title: 'NIST requests comments on frontier-model evaluation guidelines (NIST AI 800-2 draft)', body: 'NIST published a request for information in the Federal Register with a short comment window.',
    links: [{ t: 'Federal Register 2026-21877', u: 'https://www.federalregister.gov/documents/2026/10/25/2026-21877' }] }),
  A({ jur: 'US', date: '2026-10-29', kind: 'executive', class: 'comment-period-closing', facts: { agency: 'Commerce/BIS', document_number: '2026-19020', comments_close: '2026-10-29' },
    title: 'Comment period on BIS model-weight export rule closes today', body: 'The comment period on the interim final rule on advanced AI model weights ends today.',
    links: [{ t: 'Regulations.gov BIS-2026-0031', u: 'https://www.regulations.gov/docket/BIS-2026-0031' }] }),
  A({ jur: 'US', date: '2026-10-20', kind: 'executive', class: 'agency-rule-proposed', comments_close: '2026-12-15',
    title: 'FTC proposes a rule on AI system incident disclosures', body: 'The FTC published a notice of proposed rulemaking; comments are due December 15.',
    links: [{ t: 'Federal Register 2026-21500', u: 'https://www.federalregister.gov/documents/2026/10/20/2026-21500' }] }),
  A({ jur: 'US', date: '2026-10-23', kind: 'federal', class: 'introduction', tracker: 's-5493-h-r-10538-ban-artificial-superintelligence-act', stage: 'introduced', status: 'corrected',
    history: [{ at: '2026-10-25T09:00:00Z', change: 'Number corrected after the official record was updated', from: 'S. 5439', to: 'S. 5493' }],
    title: 'S. 5493 introduced in the Senate and referred to Commerce', body: 'Introduced and read twice; referred to the Committee on Commerce, Science, and Transportation.',
    next: 'Committee consideration; no hearing scheduled.', links: [{ t: 'Congress.gov: S. 5493', u: 'https://www.congress.gov/bill/119th-congress/senate-bill/5493' }] }),
  A({ jur: 'NY', date: '2026-10-22', kind: 'state', class: 'hearing-held', tracker: 'ny-s-10701-terminator-act-withdrawn', stage: 'committee', status: 'withdrawn',
    history: [{ at: '2026-10-24T09:00:00Z', change: 'Withdrawn: the hearing listing was removed from the Senate calendar; no hearing took place' }],
    title: 'Senate Internet and Technology Committee hearing on S.10701', body: 'The committee calendar listed a hearing on S.10701.',
    links: [{ t: 'NY Senate: S10701', u: 'https://www.nysenate.gov/legislation/bills/2025/S10701' }] }),
  A({ jur: 'FL', date: '2026-10-21', kind: 'litigation', class: 'court-ruling', tracker: 'florida-v-openai-injunction-motion',
    title: 'Court denies Florida’s motion for a preliminary injunction against OpenAI', body: 'The district court denied the motion in a written order; the case continues.',
    links: [{ t: 'CourtListener docket', u: 'https://www.courtlistener.com/docket/70000000/state-of-florida-v-openai/' }],
    statements: [{ publisher: 'Florida Attorney General', t: 'Statement on Today’s Ruling in Florida v. OpenAI', u: 'https://www.myfloridalegal.com/newsrelease/statement-ruling-florida-v-openai' }] }),
  A({ jur: 'US', date: '2026-10-15', kind: 'executive', class: 'executive-order', tracker: 'eo-14434-super-intelligence-terminology-order',
    title: 'Executive Order 14434 published in the Federal Register', body: 'The order was published as Federal Register document 2026-20811.',
    links: [{ t: 'Federal Register 2026-20811', u: 'https://www.federalregister.gov/documents/2026/10/15/2026-20811' }] }),
  A({ jur: 'US', date: '2026-10-02', kind: 'federal', class: 'referral-committee', tracker: 'h-r-9925-frontier-act', stage: 'committee',
    title: 'H.R. 9925 referred to the House Committee on Science, Space, and Technology', body: 'Referred on introduction.',
    links: [{ t: 'Congress.gov: H.R. 9925', u: 'https://www.congress.gov/bill/119th-congress/house-bill/9925' }] }),
  A({ jur: 'US', date: '2026-10-10', kind: 'executive', class: 'comment-period-closing', facts: { comments_close: '2026-10-12' },
    title: 'OSTP comment period on the national AI R&D plan closed', body: 'The comment window closed on October 12.',
    links: [{ t: 'Federal Register 2026-19555', u: 'https://www.federalregister.gov/documents/2026/09/12/2026-19555' }] }),
  // class null: recorded by the pipeline, never shown
  A({ jur: 'US', date: '2026-10-28', kind: 'federal', class: null, title: 'Unmapped action (must not render)', body: 'Must not render.' })
];
news.items = [...news.items, ...items.map(({ jur, ...o }) => o)];
fs.writeFileSync(path.join(here, 'news-fixture.json'), JSON.stringify(news, null, 1) + '\n');
console.log(`news-fixture.json: ${news.items.length} items (${items.length} automated)`);

// A second fixture with no automated items this week, for the empty digest state.
const quiet = { ...news, items: news.items.filter((n) => n.origin !== 'automated' || n.date < '2026-10-16') };
fs.writeFileSync(path.join(here, 'news-fixture-quiet.json'), JSON.stringify(quiet, null, 1) + '\n');
