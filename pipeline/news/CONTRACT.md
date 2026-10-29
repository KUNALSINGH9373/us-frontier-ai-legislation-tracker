# News rebuild: shared contract (29 Oct 2026)

Every agent building the new News lane codes against this file. If you need to change it, say so in your report; do not silently diverge.

## Principle
Only official structured records create news events. Press releases only attach to an existing event as statements (verbatim headline + link). The AI never reads web pages; it may only rewrite a closed fact sheet (news/writer.mjs), checked by code, with a template fallback. When unsure: hold (no card), never guess.

## Event classes (Open States vocabulary subset + non-bill classes)
Bill: `introduction`, `referral-committee`, `hearing-scheduled`, `hearing-held`, `committee-passage`, `committee-failure`, `passage` (one chamber; facts.chamber), `failure`, `amendment-passage`, `concurrence`, `enrolled`, `executive-receipt`, `executive-signature`, `executive-veto`, `became-law`, `veto-override-passage`, `withdrawal`, `carried-over`, `new-text-version`, `crs-report`, `cbo-estimate`.
Non-bill: `executive-order`, `presidential-memo`, `agency-rule-proposed`, `agency-rule-final`, `agency-guidance`, `comment-period-open`, `comment-period-closing`, `nomination`, `court-filing`, `court-ruling`.
Anything a classifier cannot map is recorded with class `null` and never shown.

## Raw item (what a source adapter returns)
```js
{ source: 'congress_gov'|'legiscan'|'federal_register'|'govinfo'|'regulations_gov'|'whitehouse'|'openstates'|'nysenate'|'courtlistener'|'nist'|'cbo'|'ca_ag'|...,
  source_id: 'stable id from the source',
  jurisdiction: 'US'|'CA'|'NY'|...,
  entry_id: 'tracker entry id or null',   // matched by code only (ids/numbers/aliases), never by AI
  class: '<event class>'|null,
  date: 'YYYY-MM-DD',                     // official action date; reject future dates and dates > 1 day after retrieval
  facts: { /* plain-text official fields only: chamber, committee, vote {yes,no}, title, number, agency, comments_close, document_number, court, docket, ... */ },
  url: 'official URL (host on the allowlist)', title: 'verbatim official title', retrieved_at: ISO }
```
Adapter module shape (`news/sources/<name>.mjs`): `export async function fetchItems({ http, env, since, state, entries }) -> { items: RawItem[], health: { ok, count, newest, errors: [] } }`. Missing key → `{ items: [], health: { ok: false, errors: ['no key'] } }`, never throw. Each adapter has offline fixtures in `pipeline/fixtures/news/sources/<name>/` and tests.

## Event (stored in pipeline/state/news-events.json, rendered to web/data/v2/news.json)
```js
{ key: `${jurisdiction}|${entry_id||'-'}|${class}|${date}`,   // releases may match within +3 days
  jurisdiction, entry_id, class, date, facts,
  sources: [{ role: 'official'|'confirmation'|'statement', source, source_id, url, title, publisher, retrieved_at, hash }],
  status: 'pending'|'confirmed'|'corrected'|'withdrawn',
  confirmations: ['legiscan','openstates'],   // confirmed = official + an independent confirmation where one exists for that class, else official alone after 2 stable runs
  history: [{ at, change, from, to }],
  card: { headline, body, template_headline, template_body, written_by: 'ai'|'template' } }
```
Similarity may only suggest attaching a statement; the key must agree. Corrections never delete: status `corrected`/`withdrawn` + history entry.

## news.json item (backwards compatible; hand-written items stay untouched)
Automated items keep existing fields `date, kind (federal|state|executive|litigation), title, body, links [{t,u}], tracker, origin: 'automated', verification {method:'official-record', checked_at}` and add `event_key, class, status, statements: [{t,u,publisher}], stage, next`.
Added 29 Oct (site needs): `jurisdiction` (always), `stage` = one of `introduced|committee|passed-chamber|passed-both|law` (or omitted), `comments_close` (YYYY-MM-DD, comment-period items), `history` (copied from the event; last entry shown on corrected/withdrawn), optional `status_note`. Corrected/withdrawn items stay in news.json with their status. `next` is shown verbatim. The site hides automated items whose class is null or unknown.

## Decisions 29 Oct (from the verify agent)
- `entry_id` = the entry's `key` slug from web/data/v2/entries.json (e.g. `ca-sb-53-tfaia`; same as news.json `tracker`), never the numeric id.
- Event also stores `stable_runs`, `facts_hash`, and `disagreements` while disputed (news/confirm.mjs `applyRun` owns these).
- A withdrawn/cancelled record is signalled by `facts.withdrawn: true`; events.mjs must honour it (status withdrawn + history).
- `hearing-scheduled`: `date` = the day first seen; the hearing day goes in `facts.hearing_date` (the no-future-dates rule applies to `date` only).
- Statement RawItems: `class: null`, `facts.role='statement'`, `facts.publisher`, `facts.text` (plain text, used in the content hash). Attachment: news/attach.mjs `attachStatements`.
- Adapters may accept extra optional params (`config`, `now`, `sleep`) and return extra health fields (`requests`, `truncated`); hitting a per-run request cap is not "broken".
- Health: news/health.mjs; confirmation: news/confirm.mjs (`showable(event)` decides what may render).

## Rules for every agent
Work in your worktree on top of 2f1d34b; commit there; do not push; do not touch main; never change any `auto_publish` switch (news stays false); Lane 1 output must stay byte-identical; add your test file to the `npm test` script in pipeline/package.json; `npm test` must exit 0; end commits with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions 29 Oct (core: events, classify, render)
- `facts.milestone`: an official-record field computed by code only from tracker data (news/events.mjs `milestoneFor`, e.g. "3rd state with an enacted law in this tracker section (B)"); null when any date is unknown. Never written by AI; the writer may say "first"/"Nth" only when it is present.
- Adapters built on records the run already has (congress_gov, legiscan, courtlistener) use a per-action `source_id` (`<record>#<date>#<hash of the official words>`) plus `record` (the bill), so news/confirm.mjs matches an event to its own action; `fetched: [{ source, record }]` names records read in full this run (an event of such a record no longer in it is withdrawn via `facts.withdrawn`). An event whose record was not read again is carried into applyRun unchanged (the grabber's cursor says it did not change).
- Several items with one key: one event; the official source is the existing one's, else by `OFFICIAL_ORDER`; other sources only confirm. Different official words of one key are kept in `facts.actions`.
- Rendering: one item per entry and date (an entry/date the page already covers by hand or by Lane 1's official-action news is not added again). Lane 1's `news_from_official_actions` is left on: switching it off would change Lane 1 output, which must stay byte-identical; turn it off when `auto_publish.news` goes on.
- A long official text (a court order) is quoted by its opening sentences, verbatim, marked "(opening words of the entry)"; a quote is never cut mid-way.
