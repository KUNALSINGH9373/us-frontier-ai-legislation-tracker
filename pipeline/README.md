# pipeline/ — schemas and checks for the automatic update system

Separate from v1 (`build/`, `docs/`, `tracker.md`) and from the new UI (`web/`). Nothing here changes either of them.

## What this is

The one agreed shape of the data. Every stage of the pipeline (Grabber, Generator, Validator) reads and writes these shapes, and the UI will read the published ones. If a file does not match its schema, it is rejected before it can reach the site.

## Run it

```bash
cd pipeline
npm install
npm test                                   # 49 checks
node schema/legacy-to-v2.mjs               # converts today's data into the v2 shape (writes pipeline/out/, git-ignored)
node schema/validate.mjs entry out/entries.v2.json
```

## Files

| File | What it defines |
| --- | --- |
| `schema/common.schema.json` | Shared lists: status, section, event type, confidence level and basis, source, evidence |
| `schema/entry.schema.json` | One tracker entry (bill, law, order, lawsuit) |
| `schema/news.schema.json` | The updates feed |
| `schema/relationships.schema.json` | The link network: nodes, edges, each with a quote |
| `schema/site.schema.json` | Dates, section names, replay milestones, comparison table |
| `schema/pipeline.schema.json` | The agents' own files: state, change set, draft, verdict, held item, run log |
| `schema/validate.mjs` | Checks any file against a schema |
| `schema/integrity.mjs` | Checks references between files (every link points at a real entry, dates are real) |
| `schema/legacy-to-v2.mjs` | Converts the current data to v2, reusing the UI's own logic |
| `schema/test.mjs` | Proves the real data passes and bad data is rejected |

## What changed compared with today's data

| Today | v2 | Why |
| --- | --- | --- |
| Entry numbers (1–90) | Stable text `key` (e.g. `ca-sb-53-tfaia`) plus the old `id` | Numbers are row positions. A key survives re-ordering, so news, links and milestones can point at it. |
| Dates and status written inside prose | Structured `events[]`, `status`, `type`, `state` | The agents can update a date without rewriting a paragraph. The UI stops guessing from sentences. |
| Hardcoded state overrides, milestone ids, comparison matrix, headline counts in the UI | `state` per entry, `site.json` for milestones and the matrix; counts computed by the build | The first automatic update would otherwise break the UI. |
| Confidence written by hand | `confidence.level` plus `confidence.basis`, tied together by rule | Automated entries cannot claim HIGH from a news story. |
| Source links mixed into text | `sources[]` with `kind` primary / secondary | The validator and the confidence rule need to know which is which. |
| Nothing says who wrote it | `origin`, `verification`, `last_checked`, `last_changed` | Every entry shows whether the author or the agents produced it, and when it was last checked. |

## Rules the schema enforces for automatic entries

An entry with `origin: automated` or `mixed` is rejected unless it has:

1. `identifiers` (how it was matched to the official API record),
2. at least one `sources` entry,
3. at least one `evidence` item: a verbatim quote and its source URL (the Validator then checks in code that the quote really appears in the stored source text),
4. `verification.method = agent`, with the run id and the number of rounds (max 3),
5. a confidence `basis` of primary record, corroborated, secondary or single source. The agents may never write a "none located" finding.

Confidence level must match the basis: primary record gives HIGH or MED-HIGH; corroborated gives MED-HIGH or MED; secondary gives MED or LOW; single source gives LOW.

Other rules: excluded (section J) entries have status `excluded` and no confidence rating; federal entries sit on no state tile; state entries must name a state; automated news items and links need evidence and a source URL.

## What converting the real data showed

All 90 entries, 178 events, 133 links and 39 news items convert and pass. The conversion also found things worth knowing:

- **10 entries have no source link, and all 10 are in the "excluded" section (J).** That is expected: the section lists things the tracker checked and left out. Every other entry has at least one source.
- **13 entries have no dated event.** Ten are the same excluded items; the other three (one state bill, one federal draft, one executive action) are worth a look by the author.
- **40 of the 178 events have a year inferred from the same cell** (the date was written without a year). The schema keeps that flag, and the UI already says so on the event card.
- **Source kind (primary / secondary) is a first guess** from the web address (government and legislature sites count as primary). The author should check it.
- Event kinds come from v1's keyword rules and are not yet verified.

## The Grabber (Congress.gov)

Plain code, no AI. It asks Congress.gov which bills changed since the last successful run, saves each one's raw source text, and writes a change set that the Generator and Validator will read.

```bash
npm run test:grabber                       # 37 checks against a fake Congress.gov, no live calls
node grabber/run.mjs --dry-run             # normal run, saves nothing
node grabber/run.mjs --bill 119/hr/9925    # fetch named bills (used for the one-time reconciliation)
node grabber/run.mjs                       # normal run, saves state
```

How it behaves:

- **Key:** read from `CONGRESS_API_KEY` in the environment or a `.env` file found upward from this folder (yours is at `E:\uslegislation\.env`, outside the repo). It is sent in a header, scrubbed from every error and log line, and `.env` is git-ignored.
- **Starting point:** 29 Sep 2026, the tracker's data cut-off. Nothing earlier is re-examined.
- **What it keeps:** bills we already track (matched by `identifiers.external.congress_gov`) and new bills that pass the screen in `config/scope.draft.json` (finalised 13 Oct 2026): a title with frontier wording (`precise_terms`) is a candidate at once; a title with any AI, compute, chip, security or threat word (`title_terms`, deliberately wide, because e.g. the "Collaboration on Adversarial Threats and Security Risks Act" has no AI word) goes to the AI intent check, which drops only a confident "no" (listed in `congress-screened-out.json`). Titles with none of those words are counted and dropped. A run cut off by its budget resumes at the first candidate it did not fetch.
- **Unchanged bills cost nothing:** a saved fingerprint per bill means a bill that has not changed is skipped, so a quiet run is one request.
- **Budget:** a hard cap on requests per run (default 400). If it is reached, the run stops cleanly and the next run resumes exactly where it stopped.
- **Failures:** rate limits and server errors are retried with growing waits; anything else fails the run. A failed run saves no state, so the next run starts from the same point and nothing is lost.
- **Outputs (git-ignored for now):** `data/runs/<run id>/changeset.json`, the raw text under `raw/`, and `state/state.json`.

## Identifiers (which bill is which entry)

`node grabber/map-ids.mjs` proposes the Congress.gov bill id(s) for every federal entry from the bill number in its title, then checks each against the live record (title and sponsor). Results: `config/identifiers.json` (kept in git) and a readable table at `out/identifier-review.md`.

Current result: 20 entries (25 bills) map and all agree with the live records. 12 federal-section entries have no bill number (drafts, rules, an executive order, and two bills not yet numbered: #34 and #50). **A person should confirm the table** (set an entry's `status` to `confirmed`, or fix an id). The converter merges these ids into each entry's `identifiers`, and the Grabber uses them to recognise tracked bills. An entry covering a House and a Senate bill lists both ids.

## The comparison step

`node compare/run.mjs` reads a change set and writes `diff.json`, so the AI steps only run where something real changed:

| Verdict | Meaning | AI used? |
| --- | --- | --- |
| `new_entry_candidate` | a bill we do not track that passed the title screen | yes |
| `material` | a new action since the entry was last checked, a status change (became law, vetoed) or a different primary sponsor | yes |
| `minor` | the record was touched, the title was reworded, or a companion bill's sponsor is not named | no |
| `unchanged` | nothing to do | no |

An action the tracker's own text already mentions is not counted as new. These rules are plain code, so they are exact, free and testable (`npm run test:compare`, 25 checks, using real Congress.gov records saved in `fixtures/`).

### First live reconciliation (dry run, 6 Oct 2026)

All 25 mapped federal bills were fetched (75 requests) and compared: **1 material, 17 minor, 7 unchanged.** The one material item is real: S. 2938 had a hearing on 30 Sep 2026, held by the Homeland Security and Governmental Affairs Committee, after the tracker's cut-off. The tracker still says "referred to Senate Commerce. No action in 11+ months". Only that item would have been sent on to the Generator.

## The Federal Register Grabber

`node grabber/run.mjs --source federal_register` (no key needed) searches for exact phrases ("artificial intelligence", "frontier model", "foundation model", "advanced computing", "superintelligence", "super intelligence") in documents published since the saved date, then screens each document's title and abstract. Presidential documents also have their full text screened, because an order's title often does not say what it is about. Orders already in the tracker are recognised by order number; later documents that name a tracked order are flagged. `--source all` runs both Grabbers. Bill text is also fetched for new Congress.gov candidates, so what we write about them can be checked.

## The LegiScan Grabber (state bills)

`node grabber/run.mjs --source legiscan [--dry-run] [--no-search] [--legiscan-bill <bill_id>]` (keys: `LEGISCAN_API_KEY`; `GEMINI_API_KEY` for the intent check). Built standalone so it can be plugged into compare / agents / derive later. The site is frontier-only (owner, 13 Oct 2026); discovery is built to **miss nothing in scope**, and catching extra bills is acceptable. The free tier is 30,000 queries a month:

- **Tracked bills:** `config/identifiers-legiscan.json` (made by `node grabber/map-ids-legiscan.mjs`, reviewed in `out/identifier-review-legiscan.md`) links 21 live state entries to 33 LegiScan bills. Each run makes one `getMasterListRaw` call per open session (11) and compares `change_hash`; `getBill` only for bills whose hash changed. A session counts as open until its last year ends (LegiScan's `sine_die` flag is set after the regular session, but e.g. Illinois still has a veto session).
- **New bills, two bulk full-text searches per run** (`getSearchRaw`: up to 2,000 hits per query, so no hit is cut off by a page limit):
  - *precise* (`precise_phrases` in `config/legiscan.json`: frontier model / developer, foundation model, large developer, compute-threshold wording, IVO, AI safety, ...): every hit is a candidate, with no title screen. A bill whose TEXT uses frontier wording can therefore never be dropped by the AI check.
  - *wide* (`wide_query`: every bill mentioning artificial intelligence / machine learning / AI model or system, about 2,700): titles of bills not seen before go to the **AI intent check** (`grabber/intent.mjs`, model role `screener`). Only a confident "no" is dropped; a title the model leaves out, a failed call or no key all count as "maybe"; a "no" on a generic title (budget, omnibus, "An act to amend the code", Illinois "SCH CD-...") is overruled to "maybe" by code. Titles come from one `getBill` each when there are few, or from the titled search pages (50 a query) when there are many.
  - Bill numbers the tracker already has (failed entries too) and federal bills (left to Congress.gov) are settled without the model. Every "no" is listed with the model's reason in the run folder (`legiscan-screened-out.json`) and remembered in `state/legiscan-seen.json`; it is re-checked only when the bill changes and 30 days have passed.
- **Text:** fetched only for candidates, newest version, HTML preferred; PDF-only states are read by `grabber/lib/pdf.mjs` (pdfjs-dist, pinned): margin line numbers and running headers / footers removed, words split across lines rejoined; the PDF file is kept next to the record. A scanned PDF (no text layer) or garbled text gives `text_missing: true` with the reason; nothing is guessed. Pieces of text that touch with no gap are one word (CT, RI and PA printers split words mid-run: "w" + "ithin"); line numbers are removed from the right margin too (Ohio) when they count up; a small raised number after a number becomes an exponent ("10^26"). Where the printed text itself has lost an exponent (PA H.B. 2800 prints "1,026 integer or floating-point operations"; MA S. 37 prints "1026"), the text is kept as printed and `pdf.warnings` lists a `possible_lost_exponent`, so no number is ever silently corrected. Tested on the real PA H.B. 2800, OH H.B. 628 and MA S. 37 PDFs (`fixtures/legiscan/`); all 11 PDF texts of the tracked state bills read on 15 Oct 2026. Each candidate also carries `frontier_markers` found in its text (a flag for the agents, never a filter).
- **Citations:** each item's `source_url` is the legislature's own page (`state_link`); LegiScan is only the finder.
- **Caps only delay:** `per_run_budget` (100), `max_candidates_per_run` (25) and a monthly cap (15,000 = half the free tier, counted in `state/legiscan-usage.json`, written even when a run fails). Anything not reached is not marked seen, so the next run continues.
- **Status and events:** `trackerStatus` (4 enacted, 5/6 failed, else pending; "stalled" is never set by code) and `eventsFrom` (routine readings, amendments, substitutes and Virginia's "passed by for the day" dropped), in `grabber/sources/legiscan.mjs`. `derive.mjs` does not use them yet.

**Recall tests (the bar is 100%; re-run after any change to the phrases, the word lists, the intent prompt or the screener model):**
- `node grabber/recall-legiscan.mjs` treats every state bill on the site as new: 13 Oct 2026, intent-v2: **38 / 38 caught** (37 by the precise search; MA H.5576 "economic development" by the wide search + "maybe"); 3 bills are in older sessions outside the search (RI 2025, CA SB 1047). Report: `out/recall-legiscan.md`.
- `node grabber/recall-congress.mjs` does the same for the 25 federal bills: **25 / 25**. intent-v1 missed 3 (two military / defense AI bills and the Cybersecurity and AI Board of Investigations), which led to intent-v2.

**Live dry run, 13 Oct 2026 (first run, nothing saved):** 180 queries. 141 precise hits, 2,717 wide hits (658 federal), intent yes 54 / maybe 539 / no 1,346 (before the generic-title rule, which turns 53 of those "no"s into "maybe"); 25 candidates fetched, all with text (16 read from PDFs); about 650 wait for later runs. The first catch-up therefore takes about 1,400 queries spread over a few days; after that a quiet run costs about 14 queries (11 master lists + 3 search pages).

## The Publisher (`publish/`), Tier A and Tier B

`node publish/run.mjs [run folder] [--dry-run] [--commit] [--data <dir>]` turns one run (its `changeset.json` and `diff.json`) into updated site data. **v1 is frozen** (owner, 15 Oct 2026): from now on the publisher writes `web/data/v2/{entries,news,site,changes}.json` directly (and the same files to `docs/data/v2/`, which the live site serves); `web/scripts/sync-v2.mjs` refuses to copy the v1 conversion over data the pipeline has changed. The grabber and the compare step read `web/data/v2/entries.json` (`--entries <file>` for a replay).

- **Tier A only: official facts, written by code, no AI.** For each `material` item on a tracked entry (matched by `key`, never by row number): a new dated action becomes an event (type by `agents/derive.mjs eventFor`, deduped by date and type) and is appended to the status text in fixed wording, e.g. `...; Committee on Homeland Security and Governmental Affairs. Hearings held (Sept 30, 2026, Congress.gov)`; a status the record proves (became law, vetoed) is set. The action text must be found in the stored record. Mechanism, thresholds, penalties and every other reading field are never touched. Not Tier A (sponsor changes, Federal Register wording, new bills): listed in the summary, not applied.
- Changed entries become `origin: mixed` with `verification` (agent, run id) and `evidence` (the official action text and URL); `last_checked` / `last_changed` move to the run date; `site.updates_through` and `news.asof` move forward (never back), and every event's `scheduled` flag is recomputed.
- **News:** one item per new action, in fixed wording, linked to the entry and the official page (`origin: automated`, with evidence); none if the entry already has a news item that day.
- **Change log** `web/data/v2/changes.json` (`schema/changes.schema.json`): one record per changed field (entry, field, old, new, date, run, source URL, tier).
- **Stop rules** (`publish/guards.mjs`); any one failing writes nothing and exits 1: every file passes its schema and the cross-file checks; no status goes backwards; no entry, event, link, news item or change record is deleted or edited; only Tier A fields change; relationships unchanged; at most `max_entries_changed_per_run` (15, `config/publish.json`) entries change; every stored source still has the hash saved at grab time; no unscheduled event after the cut-off.
- A quiet run writes nothing. `publish-summary.md` goes in the run folder; `--commit` makes one local commit with it as the message (never pushes).
- Tests: `npm run test:publish` (29), using the real S. 2938 run of 6 Oct 2026 against the site data of 8 Oct 2026 (`fixtures/publish/`).
- **Tier B: new entries** (`publish/tier-b.mjs`, after Tier A in the same run). Reads the agents' drafts marked `publishable` with operation `create` (`results.json`, `results/<item>.json`). **Off until `auto_publish.new_entries` is on** in `config/publish.json` (the accuracy bar); while off, each draft is listed as "ready; new-bill publishing is switched off". When on, a draft is added only if: the bill is not already tracked by any entry; the entry passes `checkNewEntry` (section in `AUTO_CREATE_SECTIONS`; type, level and status by the section rule; `origin: automated`, verified by the agent; mechanism, thresholds and penalties each with an evidence quote; no "none located" wording); the status is the one the record's latest action gives; and every evidence quote is in the stored record word for word. Id and key are renumbered against the current data (drafts from one run can share them). At most `max_new_entries_per_run` (3) per run; the rest wait for the next run. Each added entry gets a change-log record (`field: entry`, tier B) and one news item in fixed wording ("introduced" / "published in the Federal Register", dated by the record, quoting the official title). A new Congress bill is added to `config/identifiers.json` (`status: confirmed`, `added_by: pipeline`) after the data is written; `update.mjs` puts that file back with the data if the site check fails. The stop rules add a stricter path for new entries: any new entry Tier B did not add, one that fails `checkNewEntry`, an unscheduled future event, or more than `max_new_entries_per_run` stops the run. Tests: `node publish/test-tier-b.mjs` (38). Not built yet: links to existing bills, re-checking amended text, and section-by-section reading of long bills.
- **New state bills (28 Oct 2026)**, the same path to the same standard. `agents/derive.mjs` writes everything the LegiScan record states: title ("H.B. 4098 — " + official title), short name ("AZ HB 4098"; one-letter prefixes as "NY S.10373"), jurisdiction and state (the two-letter code, as on every state entry), sponsor ("Rep. Anastasia Travers (D) with 3 co-sponsors; joint sponsor ..."), events (the history actions `eventsFrom` keeps, the Tier A rules), status (LegiScan's status code, the rule `compare/legiscan.mjs` uses: passed = enacted, vetoed or failed = failed, else pending), status line ("Status: Introduced Feb 10, 2026; <latest kept action> (<date>)"), identifiers (`session` = LegiScan session name, `external.legiscan` = [bill_id]) and the legislature's own page as the source (plus its text page when the text came from there). Section by rule from the status: an enacted bill may go only in A (enacted state frontier-developer laws) or C (IVO / auditor measures), any other in B, B.2 or C; the Generator chooses within those (the answer schema and `assemble.mjs` refuse anything else, and a state bill can never take a federal section or the reverse). "stalled" is never written by the pipeline. A, B and B.2 get the duty step (every state frontier entry carries a session-written duty set); C has none. Tier B re-checks state, session and LegiScan id against the stored record, skips a bill already tracked (by entry ids, by `config/identifiers-legiscan.json`, or by a hand-written entry naming the same state and number), writes the "introduced" news item ("The AZ Legislature records that ..."), and adds the bill to `config/identifiers-legiscan.json` as a confirmed mapping in the `map-ids-legiscan.mjs` shape (`added_by: pipeline`), so the grabber watches it. Tests: `node publish/test-tier-b-state.mjs`, and the state cases in `agents/test.mjs` and `agents/test-derive.mjs` (real candidates in `fixtures/legiscan/candidates/`).
- **Replay, 16 Oct 2026:** all 25 tracked federal bills fetched live, compared and published onto the 8 Oct data: 1 material (the S. 2938 hearing), 14 minor, 10 unchanged, published cleanly and rendered on the bill page and News and Updates. Limit found: compare only counts actions after the entry's last check, so an action the author missed before that date (H.R. 9363's 25 June vote) is not caught; the daily re-check (phase 6) covers that.

## State bills through the publisher, and the one-command update

- **`compare/legiscan.mjs`** (LegiScan items): a non-routine history step after the entry's last check is `material` (routine steps such as readings, amendments and cosponsor additions are already dropped by `eventsFrom`); a chaptered bill on an entry not yet `enacted` is a status change; a failed bill is a status change only when the entry covers that one bill (a dead companion of a two-bill entry is `minor`, kind `companion_status`). The publisher types state events with the LegiScan rules, writes the bill number into the wording ("CA SB813: Enrolled and presented to the Governor at 4 p.m. (Sept 8, 2026, CA Legislature)"), cites the legislature's own page, and gives the entry its `identifiers.external.legiscan` ids when it first becomes `mixed`. Tests: `npm run test:publish-legiscan` (14), on real records fetched 16 Oct 2026 (`fixtures/publish/run-legiscan-20261016/`). A live reconcile of all 32 tracked state bills against the 8 Oct data found one real step after the author's check (CA SB 813, 8 Sept 2026).
- **`node update.mjs [--dry-run] [--commit] [--source ...] [--no-search]`** runs the whole chain the schedule will run: grab all three sources, compare and publish each run in turn, re-run the v1/v2 parity check (on failure the data is put back), write `web/data/v2/status.json`, and with `--commit` make one local commit (`data: ...` when the data changed, `status only: ...` otherwise; never pushes). One run at a time (`data/update.lock`). Dry run 16 Oct 2026: Congress.gov 2,701 updated bills listed (13 tracked, all unchanged or minor), Federal Register 1 tracked unchanged, LegiScan 33 tracked bills unchanged by hash; nothing published.
- **`status.json`** (`schema/status.schema.json`): `last_checked`, `sources`, `run_ids`, `last_change`, and `checked` (entry key -> time). Every run rewrites it, quiet runs included. The site shows "Checked for updates 2 hours ago · Last change 15 Oct 2026" under the Home headline and on News and Updates, and "Official record last checked ..." on a bill page; nothing at all when the file is missing or over 24 hours old.

## The accuracy test set (`eval/`), the gate for AI-written fields

- **Gold answers:** `eval/gold.json`, frozen 16 Oct 2026 from the hand-checked entries: 48 entries with an official text (41 in scope; 7 from section J, which must not be published). `node eval/build-gold.mjs` wrote it once.
- **Texts:** `node eval/fetch-texts.mjs` fetches each bill's official text (Congress.gov; LegiScan / the legislature for state bills, PDFs read by `grabber/lib/pdf.mjs`) into `data/eval/texts/` (git-ignored) and records bill, URL, length and SHA-256 in `eval/sources.json`. A changed text is refused until re-fetched. GPO superscripts (`10\`) are written `10^26`, and number checks read 10²⁶, 10^26 and 10\ alike.
- **Run:** `node eval/run.mjs [--provider] [--model] [--thinking-level] [--max-output-tokens] [--only] [--concurrency]` runs the production Generator and independent reader on each text as a new bill (up to 3 rounds, complaints fed back), publishes nothing, and writes `eval/report.md` and `eval/reports/<date>-<provider>-<model>.json`.
- **Scoring is code:** published (every code check and every claim confirmed by the reader); unsupported (a published quote or number not in the text, should be 0); fact recall (numbers of the author's field that the text also contains); a field passes when published, nothing unsupported, and for thresholds and penalties every provable number is stated (mechanism is prose: recall reported, not required); scope agreement (an in-scope bill must not be dropped, an excluded one must not be published).
- **Gate:** `config/publish.json` `eval_bar` (pass rate 100%, 0 unsupported, scope agreement 100%, the owner's to set). `node eval/gate.mjs` reads the latest full-set report for the production model and refuses any `auto_publish` switch that is on without a passing report. **Enforced at run time:** `update.mjs` treats every switch whose field does not pass (new_entries, relationships, news, the reading fields) as OFF for the run and says why in the run report (`rep.gate`, notes); news is not measured by the test set, so its switch stays off. To produce a report that counts (whole test set, production models, about $1-3): `cd pipeline && node eval/fetch-texts.mjs && node eval/run.mjs --provider anthropic && node eval/gate.mjs`. Tests: `node eval/test.mjs`.
- **First runs, 16 Oct 2026 (Gemini, testing only):**

| Model | Published | Pass rate (each field) | Unsupported | Scope agreement | Tokens |
|---|---|---|---|---|---|
| `gemini-3.5-flash-lite` (default) | 12 of 41 | 29% | 0 | 100% | 1.36M |
| `gemini-3.5-flash`, thinking low | 6 of 41 | 15% | 0 | 81% (9 in-scope bills dropped) | 1.54M |

  **After fixes, same day** (`gemini-3.5-flash-lite`): the owner-approved scope definition (`agents/prompts.mjs` SCOPE_DEFINITION, from sections A–I and the J exclusion reasons; title screener now `intent-v3`, recall re-run: 38/38 state, 25/25 federal); state bill texts cleaned of printed line numbers (`grabber/lib/text.mjs stripLineNumbering`: Illinois inline, New York at line starts) and `<sup>` exponents kept as `^`; GPO "10-26" before "integer or floating-point operations" written 10^26; numbers to be written as the source writes them; thresholds and penalties capped at 300 characters with one short quote per figure; the reader quotes one short exact span; a new check rejects letters from a script the source does not use (a published field had ended in Bengali text). Result: **15 of 41 published, 37% / 32% / 37% pass (mechanism / thresholds / penalties), 0 unsupported, scope agreement 100%.** Still held: the generator calling 6 in-scope bills out of scope, 4 answers cut off at the output limit, a few inexact quotes or numbers. Runs vary by a few items from one to the next.

  Nothing wrong was published by either, so the checks hold; but neither is near the bar. Published items are the simpler bills; every bill with compute or revenue thresholds was held (quotes not exact, fields too long), 3 texts are too long for one call (MA H.5576, CT P.A. 26-15 twice), and the scope definition in `agents/prompts.mjs` is narrower than the tracker (auditor registries, whistleblower and defence-AI bills judged out). All switches stay off.

## Model providers (`llm/`)

`config/models.json` `"provider"` picks the model company: **`gemini` for building and testing** (`roles`), **`anthropic` in production** (`anthropic.roles`, key `ANTHROPIC_API_KEY`). Both clients (`llm/gemini.mjs`, `llm/anthropic.mjs`) have the same `generate({ system, prompt, itemId })` call, share one token ledger and budget, and return JSON only; `llm/index.mjs` builds either from the config. The Claude client uses the official SDK (`@anthropic-ai/sdk`, pinned), sends no temperature (current Claude models reject non-default sampling), sets thinking depth with `effort`, and treats a refusal or a `max_tokens` stop as an error, never a half answer. `npm run test:anthropic` runs without a key; `npm run smoke:anthropic` makes one real call (pass a model id to try another) and must pass once before the provider is switched to `anthropic`.

## The Generator and Validator (`agents/`)

`node agents/run.mjs [run folder] [--item <id>]` takes a run folder that has a `diff.json` and, for every item the comparison step marked `material` or `new_entry_candidate`:

1. **Code writes what the record states exactly** (`derive.mjs`): title, short name, sponsor, signing and publication dates, status line, signing/publication events, and the section when a rule decides it (executive orders are section G). A model cannot get these wrong because it is never asked for them.
2. **The Generator** (an LLM) writes only what needs reading: what the item does, who it covers, penalties, and whether it is in scope. Every text field needs an evidence quote copied exactly from the source. It can never set status, type, level, jurisdiction or confidence: code sets those from rules (`rules.mjs`).
3. **The Validator** checks the draft in two independent layers. *Code:* schema, every quote found word for word in the source, every number and date present in the source, no "none located" claims, no leaked JSON syntax, no rambling fields. *An independent LLM reader* that sees only the source and a numbered list of claims, never the Generator's reasoning.
4. **Up to 3 rounds.** Every complaint is fed back to the Generator word for word. Outcomes: `publishable`, `out_of_scope` (both readers agree), or `held`.
5. **Before any AI (new items):** a LegiScan record that is a resolution or memorial, an amendment filed as its own record, or has a placeholder title is not written up (`agents/record-kind.mjs`); an item the tracker already has, under any id, any bill number written in any entry (J entries included), a LegiScan companion/amendment link, a Congress.gov identical bill, or a tracked bill named in its text, is not written up (`agents/dedupe.mjs`, also re-run by Tier B); a bill with no text is held without being judged on its title. Every new entry also needs the referee (Sonnet) to confirm its scope with a quote code finds in the text, and an A or B entry needs proved duty answers. An item held for its token budget or for running out of rounds gets ONE escalated pass (config/models.json `escalation`: the referee model writes, a larger budget, long bills read by section); still held after that, or held for a reason no retry fixes, it is marked `escalate` and read again only when its record changes.
6. **Held items** include: still failing after 3 rounds; the generator and reader disagree on scope (stops after one retry, recorded for the author); the bill text is not published yet (retried later); a source over 100,000 characters in which no frontier-AI section was found (judged on its opening); the model service failing.

**Long bills, section by section** (`sections.mjs`): a source over 100,000 characters (an omnibus bill) is split at the bill's own headings ("SEC. 2.", "Section 1.", "SECTION 164.", "Sec. 33.", chapter sections like "Section 3A." under the bill section that inserts them) and the models read only the sections that matter: definitions, coverage, duties, enforcement and penalties, whistleblower protections, effective dates, and any section naming frontier or AI terms, ranked and kept under 90,000 characters, in their original order, with a note listing what was left out. Sections are copied whole and word for word (one over the limit is split only at its own (a)/(b) subsections), and every code check still runs on the FULL text. MA S.3228 (600,000 characters) reads as chapter 93M, its effective-date sections and two other AI sections (40,000 characters). Tests: `npm run test:sections` (46), on trimmed real texts in `fixtures/long-bills/`.

Nothing is published here. It writes `results/<item>.json`, `results.json` and `llm-usage.json` into the run folder.

**Budgets and safety:** a token budget per run and per item (`config/models.json`), checked *before* each call; an oversized prompt is refused, never silently truncated; one failing item never stops the run, and three model-service failures in a row stop it cleanly.

**Models:** `config/models.json` names the model for each role, with optional `thinking_level`. Try others for one run without editing it: `--generator-model`, `--validator-model`, `--thinking-level low`, `--max-output-tokens`.

### What the real models did (7 Oct 2026, 15 real items: 14 new-bill candidates and the S. 2938 hearing)

| | `gemini-3.5-flash-lite` (the configured default) | `gemini-3.5-flash`, thinking `low` |
| --- | --- | --- |
| Out of scope | 10 | 11 |
| Publishable | 3 | 2 |
| Held | 2 (bill text not published yet) | 2 (same two) |
| Time / tokens | about 1m20s, 132k in / 10k out | about 2m20s, 120k in / 21k out |
| Problems seen | leaked JSON syntax in a field (now caught by a code check); occasional runaway output | none |

Both resolved every item without crashing. Held items are the safe outcome. With the default thinking setting `gemini-3.5-flash` failed (`RECITATION`, then runaway thinking), so it must be run at thinking `low`. **Borderline scope calls differ between runs and models** (for example H.R. 9183, an AI data-centre environmental-reporting bill; and EO 14434, which only renames "AI" as "Super Intelligence" in federal communications). Those are for the author's scope rule to settle.

## How one update run writes (staging, one promotion)

`update.mjs` never writes the live data step by step. It copies `web/data/v2`, the two identifiers files and the state files into `data/staging/<run id>/`; the grabber, each source's publish, courts, self-correction, links, news and `status.json` all write there. Then one final `checkPublish` runs from the run-start data to the staged data (the union of what each step may change; `max_entries_changed_per_run` counted over the whole run), plus schema, integrity and the parity check on the staged copy. Only if everything passes are the files promoted together (temp file, read back, rename; on any error the renamed files are put back), with `web/data/v2` and `docs/data/v2` verified byte for byte. A stop that names its item or entry (read only from the guards' own positions: `on KEY`, `entry KEY:`, `no such entry KEY`, ...) does not block the run: that item is held in `state/held-items.json`, the rest is promoted, and the Telegram report lists it under "on hold". A stop on a per-run limit alone (`max_entries_changed_per_run`, `max_new_entries_per_run`) keeps the first entries in a stable order (most important new event first, then key) and holds the rest; they go out on later runs. A held item is retried every run for the first day, then daily, always from fresh data: its hash and cursor in the staged grabber state are forgotten (`forgetItem` in `grabber/lib/state.mjs`) so the next grab fetches it again; its stored copy is published alone only while less than a day old. It leaves the list when it passes or when it comes back with nothing left to publish (a report line), and is dropped with a report line after 14 days. An entry put back takes everything with it: its news items, change-log records, the links this run added to it, its court-docket and self-correction state, the news leads drafted this run, its "checked" mark in `status.json` (written after the final check) and its lines in the commit message. An unexplained failure promotes nothing. Tests: `node test-update.mjs` (13 injected failures, each leaving every file byte-identical, plus the hold, limit and revert paths).

**State** lives in the committed `state/` folder so a fresh GitHub runner carries on: `state.json` (grabber cursors), `legiscan-seen.json`, `news-seen.json`, `courts-state.json`, `waiting-for-text.json`, `corrections.json` (promoted only on success), and `legiscan-usage.json` and `ledger/` (written at once: they count queries and money really spent). `data/` (runs, run reports, text cache, staging) is git-ignored. `--commit` stages the data files (web and docs), both identifiers files and `state/`; `status.json` alone is committed at most once a day; a real git error fails the run.

## Self-correction (`correct/`)

No person reviews published entries, so the pipeline re-reads them and fixes confirmed mistakes in the reading fields, on every entry, hand-written ones included (owner, 27 Oct 2026). `update.mjs` runs it after publishing, at most once a day (`config/publish.json` `self_correction`); by hand: `node correct/run.mjs [--dry-run] [--only k1,k2] [--max n] [--force]`.

- **Texts** (`correct/texts.mjs`, shared with `eval/fetch-texts.mjs`): every tracked bill's official text from Congress.gov or LegiScan (free; LegiScan queries count toward the monthly cap). 46 of the 97 entries have one (27 Oct 2026); executive actions, lawsuits, drafts and section J have none. Texts over 110,000 characters (MA S.3228, the CT omnibus) are read section by section (`agents/sections.mjs`): the reader and confirmer see the frontier-AI sections, code checks quotes and numbers against the full text; a long text with no such section stays `too_long`.
- **Which entries** (`correct/select.mjs`): the bill text changed since the last check (SHA-256 in `state/corrections.json`), then a failed check (up to 3 retries), then never checked (an empty reading field first), then the one checked longest ago (after 30 days). At most `max_entries_per_run` (3) a day.
- **Review** (`correct/review.mjs`): the reader (role `reviewer`, Haiku low) lists errors and omissions with the corrected field and quotes. Code checks: the field is mechanism, thresholds, or penalties in section A; every quote is in the text; every number is in the text or the old field; the text rules (`textProblems`), length, no debris. The confirmer (role `confirmer`, Sonnet low) must agree, and its own quote must be in the text.
- **Apply** (`correct/apply.mjs`): new text and evidence, entry becomes `mixed` / `agent`, one `changes.json` record per field (tier `C`, old -> new, the problem and the quote). The publisher's stop rules (`checkPublish` with `corrected`) still run: anything else changed stops the write and the entry is retried. The Telegram report lists each correction under "Self-check".
- Tests: `npm run test:correct` (56), scripted models on a copy of the real data.

## Record facts and sources added 28 Oct 2026

- **Congress.gov fallback** (`grabber/sources/congress.mjs` `listUpdated`): the date-filtered list (`bill?fromDateTime=...`) sometimes answers 503 for days while the plain list works. After the normal retries a 5xx switches to the plain list, newest first, paged until a bill is older than the cursor, kept to the 119th Congress and replayed oldest first: the same bills in the same order (a 4xx is never hidden). `grab-stats.json` gets `list_fallback` / `fallback_pages`, and the run report a note "fallback used". A run cut off before any bill keeps its cursor. Tests: `grabber/test-fallback.mjs`.
- **Waiting for text** (`state/waiting-for-text.json`): a new bill collected without a published text waits there. Publishing a text need not move a bill's `updateDate`, so it may never be listed again; each run asks up to 10 waiting bills (`bill/{id}/text`, least recently asked first) and collects those that now have a text as new candidates. A bill tracked meanwhile, or waiting over a year, leaves the list. Same test file.
- **Cosponsor totals** (Tier A): when Congress.gov's current cosponsor count (`bill.cosponsors.count`) differs from the total the entry states (`record_facts.cosponsors`, or the fixed-wording end of `sponsor_text`, "; 11 cosponsors in all (Congress.gov)"), compare reports `cosponsors_change` (material; the AI step skips it). Tier A stores `record_facts.cosponsors {count, as_of, source_url}` and replaces or adds only that fixed-wording end; hand-written wording is never parsed or rewritten, and entries covering several bills are skipped. The guard lets `sponsor_text` change only at that end, to the stored total. Tests: `publish/test-cosponsors.mjs`.
- **Court dockets** (`grabber/sources/courtlistener.mjs`, `publish/courts.mjs`, `config/courts.json`, state `state/courts-state.json`): `update.mjs` reads the docket entries filed since the last run for each tracked federal case (`COURTLISTENER_API_TOKEN`, at most 5 requests a minute, `config/publish.json` `courts.max_requests_per_run`). Orders, judgments, notices of appeal, minute orders setting deadlines and withdrawals become Litigation events in the court's words; orders, judgments and appeals also a status-text line and a fixed-wording news item. Appearances, transcripts, summons, pro hac vice, certificates, proposed orders, referrals and counsel withdrawals are dropped, as is any day a person already wrote up. A docket read for the first time starts at its entry's `last_checked`. Same stop rules as Tier A; a stopped or rolled-back run keeps the docket state. Tests: `grabber/test-courts.mjs` (recorded real responses in `fixtures/courts/`).

## News from feeds (`news/`)

`update.mjs` runs it after self-correction; by hand: `node news/run.mjs [--dry-run]` (`--dry-run` reads the feeds but makes no AI calls and saves nothing).

- **Sources** (`config/news-sources.json`): only feeds meant for automated reading, fetched with the pipeline's own honest user agent, and only where the site's `robots.txt` allows it (`news/feeds.mjs robotsAllows`; a site that refuses `robots.txt` is not read). Verified live 28 Oct 2026: Politico technology (press, `secondary`), NIST news (covers CAISI), FTC press releases, California Attorney General, and the House feeds of three tracked sponsors (Liccardo, Lieu, Casar) (`primary`). Rejected, with the reason, under `rejected`: every senate.gov feed (Senate Commerce, Cantwell, Cruz: 403), New York and Florida AGs (403), Lawfare (bot challenge), Tech Policy Press (no feed served), House Science, BIS, Illinois AG and the White House (no feed), stale member feeds. The Federal Register stays with its grabber.
- **Leads** (`news/leads.mjs`): items from the last `max_age_days` (14); links already on the news page (the item's own link or the release it points to), or seen on an earlier run (`state/news-seen.json`), are skipped; a code word screen (`NEWS_TERMS`), then the AI headline screen (role `screener`; only a confident "no" is dropped, a failed call keeps everything, a headline naming a tracked bill is always kept); then matched to tracked entries by bill number, the bill's name, or a sponsor's surname (a `tracker` key only when exactly one entry matches).
- **Writing** (`news/write.mjs`): only from a **primary** lead (the official body's own release, on the same site as its feed; op-eds on a member's site count as press). The release page is read (`releaseText`), the writer (role `generator`, prompts in `news/prompts.mjs`, style from recent hand-checked items) drafts title, body and date; code checks every quoted span and every number against the release (`containsQuote`, `digitRuns`), dates with years, no future or unsupported dates, length; the second reader (role `validator`, `VALIDATOR_SYSTEM`) must confirm the title and each sentence with a quote code finds in the release. Up to `max_rounds` (2), complaints fed back. The item: `origin: automated`, `verification` by the agent, evidence quotes from the release, `check`: "From the official release (<publisher>), quotes checked by code." A draft repeating an item already on the page (same entry and day, same title or same link) is dropped.
- **Press leads are never published**: the Telegram report lists them under "News leads".
- **Switch:** `config/publish.json` `auto_publish.news` (off). Off: drafted items are reported under "News drafted", nothing is written. On: they are added to `news.json` (and `docs/`) only if `checkPublish` and `checkNewsAdded` (`publish/guards.mjs`: only this run's drafts added, nothing edited or deleted, evidence from the item's own release, the fixed check line, no entry changed) pass. The eval gate reports the news switch but does not judge it by the bill test set.
- **Self-resolving:** a release that cannot be read or a model outage is retried on a later run (up to 3 times); leads over `max_drafts_per_run` (3) wait; a feed that fails is a warning in the report and the others are still read.
- Tests: `npm run test:news` (83), on feeds and a release recorded 28 Oct 2026 (`fixtures/news/`) and scripted models: invented quote, invented number, unconfirmed claim, press-only lead, duplicate, irrelevant headline, robots rules, stop rules, report sections.

## Tests

```bash
npm test        # schema 49, grabber 47, federal register 23, legiscan 70, compare 25 + 9, llm 25, derive 16, agents 77
```

Every test file was also checked by deliberately breaking the code and confirming a test fails.

## Not built yet

The held-item retry loop and the publisher (merge verified entries into the data, 24-hour delay, anomaly guard, rollback, heartbeat); the CourtListener Grabber; reading PDF bill text and plugging LegiScan into the compare/agents/derive steps; the GitHub workflows; and the UI reading v2.

## Links (`links/`): relationships formed automatically

`links/run.mjs` runs inside `update.mjs` after self-correction, for every entry the run added or changed. It proposes links in the `relationships.json` shape and, **while `auto_publish.relationships` is off (`config/publish.json`), only lists them in the run report under "Links proposed"**. When on, `links/apply.mjs` adds them, but **only links for entries the automation made** (`origin: automated`, or created this run, `created`); a link proposed for an entry the owner wrote or edited by hand is listed as "report only" and never added, so the owner's choice of links stands. Anything the code is unsure of (two actor nodes match one person, a repeal, a record sponsor the entry's text does not name, an edge whose reverse exists) is listed under "not proposed", never guessed.

- **Convention (`links/rules.mjs`, followed by the proposer and enforced by `checkLinks`):**
  - *Direction:* an edge reads "<from> <label> <to>"; `from` is the party that acts: legislator -> bill (sponsor), amending bill -> law (amendment). Two of the three hand-written amendment edges follow this (S10373 -> RAISE, S10456 -> RAISE); RAISE -> NYTERM "Would amend the RAISE Act" names its own `from` and is the odd one out (left as written). No edge is proposed when the network already links the pair in either direction.
  - *Labels:* actor edges are "Sponsor" for a bill, law, auditor bill or precursor and "Draft author" for a discussion draft (the network's own wording); no sponsor edge for other types. Amendments are "Would amend <law's node name>" (type `succession`).
  - *Evidence:* a code edge's quote is the tracker's own prose, so the edge says so: `src` = the quoted entry's node, `col` = the field (`sponsor_text`, `title`, `mechanism`), `source_url` = that entry's tracker page (`https://usfrontierlaw.com/#/bill/<id>`), never the bill's page. An AI edge quotes the official text: `col` = `text`, `source_url` = the text read.
- **By code (`links/propose.mjs`, facts the text states):**
  - *Sponsor*: from the official record when the step has it (`records`: Congress.gov `sponsors` with `bioguideId`; LegiScan primary sponsors, `sponsor_type_id` 1, with `people_id`), else the lead sponsor as the entry states it: the sponsor text must **start** with a title, full name and party ("Sen. Jerry Moran (R-KS)"), and only that first person is read (co-sponsors, "with", "cosponsored by", "supported by", "opposed by" never are). The person must match exactly one legislator node on first name, last name, chamber and state, and on party wherever the node states one (Congress nodes do; state nodes carry no party). The quote must name the person in full in the entry's sponsor text. `update.mjs` does not pass records yet, so production uses the text rule.
  - *Amends a tracked law* (type `succession`): an explicit "amends / would amend / amending / to amend" whose object (the words after the verb up to ",", " to ", " by " ... outside parentheses) starts with the enacted law's name ("Amends the RAISE Act", "Amends section 5 of the NAII Act") or contains a code citation another entry of the same jurisdiction occupies ("Section 1422 of the General Business Law", "chapter 93M", "Gov. Code §§11549.80–.86", "15 U.S.C. § 278h–1(b)"; a law occupies what its title's parentheses cite and what its enacting or "codified at" clauses cite); or "adds" whose direct object is such a citation ("Adds GBL §1425"). A law mentioned elsewhere in the clause ("Unlike TFAIA, adds duties") is no amendment, nor is a negated verb; a repeal is reported, never drawn as "would amend".
  - *Companions* (Congress.gov `relatedBills` "Identical bill", or a title naming another entry's bill as its companion) are **reported, never drawn**: the tracker keeps a bill and its companion in one entry, and the network has no companion link type.
  - Only types the network already uses are proposed. A changed entry with no node gets one: the column most nodes of its section (and level) use, keyed by its bill number as the network writes it (SB315, HR9917).
- **By AI (`links/prompts.mjs`):** "copies / modeled on" (type `template`, the existing label "Same template; common drafting source rather than sequential copying") and "overlaps" (type `succession`, label "Overlap: ..."). Needs the official text of both bills; the reader must give a word-for-word quote (20+ characters) from each, code finds each in its bill, and the validator must confirm from the two quotes. AI links are always dashed (unproven direction). Not called by `update.mjs` yet (code only).
- **Apply (`links/apply.mjs`, pure):** new edges after the old ones (origin `automated`, quote, source URL, `src`, `col`), only the new nodes those edges use; one link per pair and type in either direction; `checkIntegrity` must pass. Nothing old is edited or removed.
- **Stop rule (`publish/guards.mjs` `checkLinks`):** the network may change only by exactly the edges and nodes `apply.mjs` returned. Any edit, deletion, reordering, other addition, or a new edge not marked automated stops the run. Without that list, any change still stops it. Each added edge is also checked for meaning: both ends are nodes; the ends' kinds and the entry's type fit the label (a sponsor edge comes from a legislator node, with the label for the entry's type; an amendment stays in one jurisdiction and names the law at its end; any other label is refused); the quote is word for word in the source it names (field `col` of the entry at `src`, which must be an end of the edge, with that entry's tracker page as `source_url`; or, for `col: text`, the official text the step read); the entry is automated or created this run; and no edge, old or new, joins the pair the other way.
- **Backtest (`node links/backtest.mjs`):** for each of the 75 entries with links, all its links are removed (and, in a second pass, its node too) and the code proposer is run on it alone. Scoring is strict: right = same from, same to, same type and a label that means the same (`labelOk`: "Sponsor" is not "Cosponsor", "Coauthor" or "Draft author"); otherwise wrong label, wrong direction or false link; a proposal reversing a hand-written edge that breaks the convention itself (RAISE -> NYTERM) is listed as a conflict, never counted right. 28 Oct 2026: **25 proposals, 24 right, 0 false, 0 wrong direction, 0 wrong label, 1 conflict (NYTERM -> RAISE, not proposed in a real run because the reverse exists); recall 24 of 138 (17%)**: sponsors 23 of 58, succession 1 of 21 (S10373 -> RAISE), and 0 of the template, fedstate, executive, litigation and assurance links, which are judgements in prose that code cannot prove. The old proposer, scored the same way, made 36 proposals: 32 right, 3 wrong labels ("Sponsor" on the GAAIA and TRUMPAI drafts), 1 conflict. The script exits 1 on any false link, wrong direction or wrong label.
- **Link map (`node web/scripts/check-links.mjs`):** applies the proposals to the site data and builds the UI's model; every link end must be a node the map draws, no two nodes may stand for one entry, no link is listed twice. `web/scripts/parity-v2.mjs` skips links with origin `automated` (they have no v1 counterpart).
- Tests: `npm run test:links` (115), with every audit case of 28 Oct 2026 as a permanent test (section 8).
