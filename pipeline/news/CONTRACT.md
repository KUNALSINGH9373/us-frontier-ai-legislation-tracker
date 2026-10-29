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
{ key: `${jurisdiction}|${entry_id||'-'}|${class}|${date}`,   // + `#<bill>` for a bill action with a number; hearing-scheduled by hearing day (see r5)
  jurisdiction, entry_id, class, date, facts,
  sources: [{ role: 'official'|'confirmation'|'statement', source, source_id, url, title, publisher, retrieved_at, hash }],
  status: 'pending'|'confirmed'|'corrected'|'withdrawn',
  confirmations: ['legiscan','openstates'],   // confirmed = official + an independent confirmation where one exists for that class, else official alone after 2 stable runs
  history: [{ at, change, from, to }],
  card: { headline, body, template_headline, template_body, written_by: 'ai'|'template' } }
```
Similarity may only suggest attaching a statement; the key must agree. Corrections never delete: status `corrected`/`withdrawn` + history entry.

## news.json item (backwards compatible; hand-written items stay untouched)
Automated items keep existing fields `date, kind (federal|state|executive|litigation), title, body, links [{t,u}], tracker, origin: 'automated', verification {method:'official-record', checked_at}` and add `event_key, class, status, statements: [{t,u,publisher}], stage`. (`next` was removed in review r5: no item carries a next step.)
Added 29 Oct (site needs): `jurisdiction` (always), `stage` = one of `introduced|committee|passed-chamber|passed-both|law` (or omitted), `comments_close` (YYYY-MM-DD, comment-period items), `history` (copied from the event; last entry shown on corrected/withdrawn), optional `status_note`. Corrected/withdrawn items stay in news.json with their status. The site hides automated items whose class is null or unknown.

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

## Decisions 29 Oct (core, review round 2)
- Key: executive orders and memos are keyed on the EO number (else FR document number), agency documents on the FR document number, not the date (`US|entry|executive-order|EO14409`). A White House posting with the same title as an FR order takes its EO number and signing date. Public-inspection copies (`pi:` ids, `facts.public_inspection`) never create events. FR comment-period items get `#<class>` on their source_id.
- Chambers are normalised for every source before anything reads them (news/events.mjs `normalizeItem`): upper -> Senate, lower -> House (Assembly in CA, NY, NV, NJ, WI), LegiScan H/S/A likewise.
- Items with `facts.role` 'confirmation' (govinfo) or 'statement' never create an event. A withdrawn record confirms nothing. A public law is confirmed on its number (`facts.public_law`), not its date.
- Equivalence groups: executive-signature/became-law, concurrence/enrolled, hearing-scheduled/hearing-held (same `hearing_date`), comment-period-open/agency-rule-proposed. One card per entry per group within a day either side; a later class is merged into the existing card (`event.merged`, `event.merged_into`), which then shows the highest-ranked class under its own event_key.
- Statements: one rule (news/attach.mjs): exactly one candidate attaches; several go to the timeline (held, never the nearest). The headline's chamber and committee words must agree with the event's facts. Allowed hosts come from config only.
- Backlog: a new card is only added for an event dated within 14 days of the run; older confirmed events stay off the page (timeline only).
- The news step never throws (it returns status 'stopped'). An unreadable events file is moved to `<file>.bad-<time>` and the step starts empty; malformed stored events and items are dropped and reported.

## Decisions 29 Oct (core, review round 3)
- A changed official record never changes the page at once. The event goes back to `pending` with `pending_correction: true` and `last_confirmed` (the facts, card and status the page showed); the card keeps showing those, with the status note "The official record has changed; the change is being confirmed and is not shown yet." The change is confirmed by the same rules as a new event; then the status is `corrected` and the card shows the new facts. A withdrawn event that comes back in the record goes through the same cycle. news/confirm.mjs applyRun still checks corrected events (withdrawal, disagreement, confirmation again).
- A record that re-dates or re-classes an action supersedes the old event (status withdrawn, `superseded: { field, to }`); the new date/class is its own event, which is merged into the old card once confirmed. The card then says exactly what changed ("the official record now dates this Oct 19, 2026 (first published as Oct 20, 2026)"). Never two cards.
- The law and final equivalence groups have no date window: one card per entry per group. Comment-period/proposed-rule keeps a day either side.
- One card per entry and date, checked against every event card on the page (not only this run's). An event within a day of an item written another way (by hand, or Lane 1's official-action news) on the same entry is not added.
- **Switching news on means switching Lane 1's official-action news off.** The gate (eval/gate.mjs) keeps `auto_publish.news` off, with a note, while `config/publish.json` `news_from_official_actions` is not `false`; both lanes would otherwise write the same action.
- Official hosts are exact lists per source from config/news-sources.json "structured" (`hosts`; state bill sources also `state_legislature.hosts`), matched exactly or as a subdomain. No patterns.
- Confirmers are not fully independent: LegiScan and Open States both copy the legislature's own site, so their agreement says the copy is consistent, not that a second body recorded the action. Where a state's own legislature API is read (New York: nysenate), it is the confirmer for the aggregators and they confirm it; LegiScan and Open States do not confirm each other there. Elsewhere they still do, as the best available check; adding a state's own legislature adapter makes it the confirmer the same way.

## Decisions 29 Oct (fact sheet and phrase bank, review round 4)
- (Superseded by review r5: no next step is stated anywhere.)
- Nebraska and DC have one chamber: no "both chambers" wording; the stage is "Passed the Legislature" / "Passed the Council". DC's executive is the Mayor, and a DC act or any resolution is never "signed into law" or "enacted".
- The signer is named only from `facts.executive` (signature, veto, executive order, memorandum, nomination); otherwise the wording is passive.
- The summary label: "What it does" for a measure in force (signed, law, executive order, memorandum, final rule, guidance); "What the bill would do" for a live bill; else "What it would do". The summary is quoted only when it reads as a whole sentence about what the measure does (no asides, no editorial words). Entries carry no text-version date, so a summary written from a later text cannot yet be detected; when entries gain one, the summary is skipped for an event older than that text.
- Open States: the key goes in the X-API-KEY header, never in a URL; requests are paced (min_interval_ms 6500) and an HTTP 429 is retried once after 15 s. Its own pages (openstates.org) are an allowed host for its records.

## Decisions 29 Oct (review round 5)
- **No next step, anywhere.** Cards state only what the official record shows happened. The fact sheet has no `next` (news/factsheet.mjs `stageOf` replaces `stageAndNext`), the phrase bank has no next-step lines and no variant that implies a future step ("heads to", "goes to", "awaits", "next", "will"; a scheduled hearing or comment deadline says "scheduled"), templates.mjs has no `nextOf`, news.json items have no `next` (schema: removed), and the site shows no "What's next" line. checkCard refuses any next-step word on an event that happened.
- **Stage** (news.json `stage` and the fact sheet's stage line): only a stage the record proves from this entry's own confirmed events up to the event's date, of the same bill when both give a number (news/factsheet.mjs `provenStage`): `passed-both` only with confirmed passage/concurrence events in both chambers, or an enrolled / executive-receipt / executive-signature / became-law event; a concurrence alone proves one chamber; a failure proves nothing; otherwise the stage is omitted.
- **Measures that skip the executive** (news/factsheet.mjs `isResolution`, `isConstitutionalAmendment`, `skipsExecutive`): every state resolution and memorial (HR/SR/AR, HCR/SCR/ACR, HJR/SJR/AJR, HJ/SJ, HC/SC, HM/SM/AM, LR, PR ...) and constitutional amendment (CA ACA/SCA, NJ ACR/SCR, NE LRCA, HCA/SCA ...), and federal H.Res/S.Res/H.Con.Res/S.Con.Res, never get executive wording (no executive slot, no "Sent to the Governor", no signer). "Into law"/"enacts" only for a known bill number that is not a resolution, outside DC. Maine's LD gives no origin chamber.
- **Template fallback** (news/templates.mjs): a bill-class headline is the phrase bank's most neutral variant (`neutralCandidates`: shortest eligible, passing checkCard) from the same fact sheet; non-bill classes keep their fixed headlines; the body quotes the official words. No variant fits -> no template -> held.
- **Event key** additions: a bill action with a number carries `#<normalised number>` (companion bills under one entry are separate events; news/confirm.mjs `compare` treats two different numbers as unrelated). `hearing-scheduled` is keyed `HD<hearing_date>@<committee slug>` (else the source id), never the seen day; a re-seen hearing keeps its first-seen `date`, and confirmation compares hearing days.
- **Carried copies** (events.mjs: the stored facts of an event whose record was not read again) are marked `carried`; in applyRun a fresh item of the same `source|source_id` always wins, and a cancellation (`facts.withdrawn`) wins over both, so a cancellation withdraws the event whatever key it has.
- **Open States votes**: a vote is used only with the action's own chamber organization and a result that agrees with the action (pass for passage/concurrence/override, fail for failure); otherwise no vote.
