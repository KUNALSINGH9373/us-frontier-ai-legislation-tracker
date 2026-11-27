# pipeline/: the automatic update for US Frontier Law

Technical guide, updated 26 Nov 2026. For the owner's plain-English guide see `../OWNER-HANDBOOK.md`; for keys, limits and
spend see `../ACCOUNTS-AND-COSTS.md`.

The pipeline is plain Node (ES modules, Node 22 in CI). It reads official sources, updates the site data in `web/data/v2/`
(copied byte for byte to `docs/data/v2/`, which GitHub Pages serves), commits to `main`, and sends a Telegram report. AI
(Claude) is used only behind code checks, an independent reviewer and a test gate. Every file starts with a comment that says
what it does; read it before changing the file.

---

## 1. Architecture

```
.github/workflows/update.yml  every 4 h (+ backup schedule)  ->  pipeline/update.mjs --commit  ->  push to main
.github/workflows/check.yml   every PR / human push to main  ->  tracking check, schemas, site check, npm test

update.mjs (one run)
  gate (eval/gate.mjs) -> staging copy (lib/staging.mjs)
  -> grab: grabber/run.mjs  (congress_gov, federal_register, legiscan; a child process, state in staging)
  -> per source: compare/run.mjs -> agents (AI step) -> publish/run.mjs (Tier A, then Tier B)
  -> held items -> court dockets (publish/courts.mjs) -> end of Congress (publish/congress-end.mjs)
  -> end of state sessions (publish/session-end.mjs) -> self-correction (correct/) -> page fields (pagefields/step.mjs)
  -> links (links/run.mjs) -> news (news/run.mjs) -> lawsuits (publish/lawsuits.mjs) -> press-based news (news/press-news.mjs)
  -> in the press (news/press.mjs) -> final check (publish/guards.mjs checkPublish + schema + integrity + web/scripts/site-check.mjs)
  -> status.json -> promote (all files at once) -> git commit -> run report (report/build.mjs) -> Telegram (report/html.mjs)
```

The workflow (`update.yml`):
- Regular cron `17 */4 * * *` (00:17, 04:17 … UTC). Backup cron `47 2-22/4 * * *` (02:47, 06:47 … UTC): job `decide` reads the
  last successful runs from the GitHub API and runs `node pipeline/lib/backup-due.mjs runs.json 3`; the update runs only if no
  run succeeded in the last 3 hours (or the list cannot be read). Any other trigger always runs.
- `workflow_dispatch` defaults to a dry run (`--dry-run --notify`).
- Concurrency group `tracker-update`: never two runs at once.
- Before the run: a Telegram warning if `web/data/v2/status.json` `last_checked` is over 12 hours old.
- After the run (also after a failed run, so spend counters are saved): push to `main`. If `main` changed `web`, `pipeline` or
  `docs/data` during the run, the run's commit is dropped (Telegram ⚠️) and never rebased or force-pushed.
- Heartbeat to `HEALTHCHECK_URL` if set. The run report is uploaded as an artifact (30 days).

## 2. Folders

| Folder / file | What it holds |
|---|---|
| `update.mjs` | The whole run (section 3). `node update.mjs [--dry-run] [--commit] [--source <congress_gov\|federal_register\|legiscan\|all>] [--no-search] [--no-ai] [--no-notify] [--notify]` |
| `grabber/` | Official-source readers: `run.mjs` (Congress.gov, and dispatches the others), `run-federal-register.mjs`, `run-legiscan.mjs`, `sources/` (API clients incl. `courtlistener.mjs`), `intent.mjs` (AI title screen), `screen.mjs`, `map-ids*.mjs` (identifier mapping), `recall-*.mjs` (recall tests), `lib/` (http with retries and secret scrubbing, env loader, state, PDF text) |
| `compare/` | Record vs entry: verdicts `new_entry_candidate`, `material`, `minor`, `unchanged` (code only) |
| `agents/` | New-bill AI step: `newbill.mjs` (engine "simple": writer + reviewer + scope judge, `config/pipeline.json` `new_bills.engine`), the older generator/validator/referee loop (`process-item.mjs`, `run.mjs`), `derive.mjs` (facts code writes from the record), `rules.mjs` (sections and statuses), `sections.mjs` (long bills), `dedupe.mjs`, `lawsuit.mjs` |
| `publish/` | Writers of site data: `run.mjs` (Tier A `tier-a.mjs`, Tier B `tier-b.mjs`, `loadData`/`writeData`), `courts.mjs`, `congress-end.mjs`, `session-end.mjs`, `lawsuits.mjs`, `guards.mjs` (stop rules) |
| `correct/` | Self-correction (reader `reviewer`, confirmer `confirmer`, code checks) |
| `pagefields/` | Entry-page fields (summary line, 30-second boxes, Key facts, display name); backfill tools |
| `links/` | Relationship links (only record-proved sponsor links are ever applied) |
| `news/` | News: feeds and official adapters (`sources/`), events (`events.mjs`), fixed-phrase writer (`phrasebank.mjs`, `writer.mjs`), independent review (`review.mjs`), open-leads register (`open-leads.mjs`), in the press (`press.mjs`), press-based news (`press-news.mjs`). Contract: `news/CONTRACT.md` |
| `audit/` | Weekly completeness check (`completeness.mjs`, role `auditor`, Claude web search) |
| `llm/` | Model clients (`anthropic.mjs`, `gemini.mjs` for testing), factory `make.mjs`, spend ledger `spend.mjs`, schema adapter `schema.mjs` |
| `eval/` | The accuracy gate (`gate.mjs`, `hash.mjs`) and every gate measure (section 7); reports in `eval/reports/` |
| `schema/` | JSON schemas, `validate.mjs`, `integrity.mjs`, `tracking.mjs` (section 6) |
| `report/` | Run report (`build.mjs`), plain text (`format.mjs`), Telegram HTML (`html.mjs`) |
| `notify/` | Telegram client |
| `lib/` | `staging.mjs`, `congress.mjs` (current Congress from the date), `backup-due.mjs`, `test-cleanup.mjs` |
| `config/` | Settings (section 4.2). `identifiers.json` and `identifiers-legiscan.json` are the tracked-bill lists, rewritten by runs |
| `state/` | Committed run-to-run state (cursors, seen lists, held items, open leads, spend ledger, LegiScan usage) |
| `fixtures/` | Frozen data for tests: `live-2026-11-26/` (site data and config as of 26 Nov 2026), `correct/` (12 Nov 2026 copy), recorded API answers |
| `data/` | Git-ignored: run folders, run reports, staging, text cache |
| `out/` | Git-ignored: one-off scripts (data edits, checks). Never commit |
| `duties/`, `scope-check/` | Duty-question tools; one-off LegiScan scope catch-up |

## 3. How one run writes (staging, promote, rollback)

From `update.mjs` and `lib/staging.mjs`:

1. **Lock**: `data/update.lock`; a second run exits (a lock older than 6 hours is ignored).
2. **Gate**: `gateInputsFor` and `refreshNewsMeasures` re-run the free measures that are stale (links; news + news writer;
   page fields; press), then `applyGate` turns off every switch whose measure does not pass. `publish.json` is never edited.
3. **Staging**: `web/data/v2`, both identifiers files and the state files (`grabber/lib/state.mjs` `PROMOTED_STATE`, plus
   `held-items.json` and `agent-memo.json`) are copied to `data/staging/<run id>/`. Every step writes only there.
4. **Steps** in the order of section 1. Each publishing step runs its own guards before writing to staging.
5. **Final check**: `checkPublish` from the run-start data to the staged data, with the union of what each step was allowed
   to change and `max_entries_changed_per_run` / `max_new_entries_per_run` counted over the whole run; schema and integrity;
   then `web/scripts/site-check.mjs` (the staged data builds, and everything not claimed builds exactly as before).
6. **Holds instead of failing**: a problem that names an item or entry (read only from the guards' own positions: `on KEY`,
   `entry KEY:` …) puts that entry back as it was (with its news items, change-log records, links, court and correction
   state) and holds it in `state/held-items.json`; the rest is promoted. A per-run limit alone holds the lowest-ranked entries.
   A held item is retried every run for its first day, then daily, from a fresh copy (its grabber hash is forgotten); a stored
   copy is replayed only while under a day old; after `HELD_DAYS` (14) it is dropped with an "expired, needs attention" note.
   A problem that names nothing promotes nothing.
7. **status.json** is written after the final check (only entries really read count as "checked").
8. **Promote**: temp file, read back, rename, all files together. `web/data/v2` and `docs/data/v2` are then compared byte for
   byte; any difference rolls every promoted file back and fails the run.
9. **Commit** (`--commit`): data files, docs copies, identifiers files and `state/`. `status.json` alone is committed at most
   once a day. Never pushes (the workflow pushes).
10. **Failure**: the run report says the step and error; nothing is promoted. With `--commit`, only the spend counters
    (`state/legiscan-usage.json`, `state/ledger/`) are committed, because that money and those queries were really spent.

A dry run (`--dry-run`) fetches and compares, makes no AI calls and promotes nothing.

## 4. Run and test locally

Keys come from `E:\uslegislation\.env` (`grabber/lib/env.mjs` `loadEnv`, searching upward). Never print them.

```bash
cd pipeline
npm ci
npm test                         # every test file, about 10 minutes; must end with no failure
node update.mjs --dry-run        # a real read of the sources; saves nothing, no AI
node eval/gate.mjs               # which switches meet their bar now (exit 1 if a switch is on without a passing report)
node eval/gate.mjs --how         # the commands that make reports that count
```

Do not run `node update.mjs --commit` locally against the real repo unless you mean to: it commits to the checked-out branch.
Production commits come from the workflow.

The PR checks (`.github/workflows/check.yml`, skipped for the bot's own commits), from `pipeline/`:

```bash
node schema/tracking.mjs                                    # every pending bill is followed by a grabber
for s in entry news relationships site content changes status; do   # every data file against its schema
  node schema/validate.mjs $s ../web/data/v2/<file>.json            # entry -> entries.json, others by name
done
# site check against the data before the change (from the repo root):
#   git show <base>:web/data/v2/{entries,news,relationships,site}.json into a temp folder, then
node web/scripts/site-check.mjs <tempdir> web/data/v2 auto
npm test
```

`site-check auto` claims every changed entry; it fails if a news item disappears from an entry that did not change. When you
remove a news item on purpose, also record a real check on that entry (for example `last_checked`).

### 4.1 Gate measures (rerun each)

| Measure | Switch | Command | Cost |
|---|---|---|---|
| News event set | `news` | `node eval/news-set.mjs [--no-write]` | free; runs on its own snapshot (`eval/news-set/*.snapshot.json`) |
| News writer set | `news` | `node eval/news-writer-set.mjs [--no-write]` (`--record` makes live calls) | free in replay |
| Page-fields set | `page_fields` | `node eval/pagefields-set.mjs --write` | free |
| Press set | `press` | `node eval/press-set.mjs --write` | free |
| Links measure | `relationships` | `node eval/links-measure.mjs [--no-write]` | free |
| Tier B replay | `new_entries` | `node eval/tierb-set.mjs [--no-write]` | free |
| New bills | `new_entries` | `node eval/newbill-eval.mjs --set test` and `--set unseen --gold … --sources … --texts … --references …` (unseen set outside the repo, pinned in `config/eval-sets.json`) | paid, about $3 |
| Lawsuits | `lawsuits` | `node eval/lawsuits-set.mjs --write [--only id,id]` | paid, about 2 calls per case |
| Press-based news | `press_news` | `node eval/press-news-set.mjs --write [--only id,id]` | paid, a few calls per case |
| Field eval (old) | `mechanism`, `thresholds`, `penalties` | `node eval/fetch-texts.mjs && node eval/run.mjs --provider anthropic` | paid |
| Links suite | (part of links measure) | `node links/test.mjs` | free; reads live data on purpose |

A report counts only if it covers the whole case set (or `new_bills_gate.min_items` for new bills), was made with the
production models for its roles, and carries the current `checks_hash`. `--only` runs never count. As of 26 Nov 2026 there is
no lawsuits or press-based-news report in `eval/reports/`, so those two switches cannot pass yet even if turned on.
Ask the owner before any paid run over about $1.

### 4.2 Config files

| File | What |
|---|---|
| `config/publish.json` | Switches and per-step limits (explained in `OWNER-HANDBOOK.md` section 3) |
| `config/models.json` | Provider, roles, prices, token limits, `monthly_cost_cap_usd` (50), escalation |
| `config/pipeline.json` | Structured pipeline settings incl. `new_bills.engine` ("simple") |
| `config/legiscan.json` | LegiScan search phrases, per-run and monthly caps |
| `config/news-sources.json` | News feeds (and rejected feeds with reasons) |
| `config/courts.json` | Tracked federal court cases (CourtListener dockets) |
| `config/announced-bills.json` | Federal bills announced without a number (end of Congress, tracking check) |
| `config/identifiers.json`, `identifiers-legiscan.json` | Tracked bills (federal map; state bills with LegiScan ids and sessions) |
| `config/actor-ids.json` | Official member ids for legislator nodes (links) |
| `config/recall-outside.json` | Bills found outside the pipeline that the screen must catch |
| `config/eval-sets.json` | Pinned size and fingerprints of the unseen new-bills set |
| `config/scope.draft.json`, `jurisdictions.json`, `news-lexicon.json` | Title screen words, jurisdictions, news words |

## 5. How to add things

**A source.** Add a client under `grabber/sources/` (bill records) or `news/sources/` (news adapters, contract in
`news/CONTRACT.md`) using `grabber/lib/http.mjs` (`createHttp` with `secrets: [key]` so the key is scrubbed, `maxRequests`).
Respect robots.txt and refusals: never work around a block. Record real responses in `fixtures/` and test on them (no network
in tests). A news feed goes in `config/news-sources.json` only after you have verified it works; failed candidates go under
`rejected` with the reason. A new key needs: the `.env` entry, a GitHub secret, and the `env:` line in `update.yml`.

**An entry (by hand).** Write a script in `pipeline/out/` (git-ignored) that: loads with `publish/run.mjs` `loadData`;
makes the change from official sources read in that session; validates with `schema/validate.mjs`, `schema/integrity.mjs`
`checkIntegrity` and `web/scripts/site-check.mjs` `siteCheck`; re-stamps `page_verification.basis_sha256` with
`pagefields/layout.mjs` `basisOf` where the checked text changed; writes with `writeData`; copies to `docs/data/v2/`.
`out/apply-patches.mjs` does this for field patches. Tracking rules (`schema/tracking.mjs`, run in CI):
- a federal entry whose title names a bill must carry `identifiers.external.congress_gov` (e.g. `119/hr/9925`);
- a pending federal bill with no id must be in `config/announced-bills.json`;
- a pending state bill must be in `config/identifiers-legiscan.json`, with the same ids in `identifiers.external.legiscan`.
Then run section 4's checks and open a PR. Merge `main` into the branch right before pushing: the pipeline commits to `main`
every 4 hours (expect conflicts in `pipeline/state/*.json` and `web/data/v2/*.json`).

**A rule.** Section and status rules: `agents/rules.mjs`. Stop rules: `publish/guards.mjs`. Cross-file rules:
`schema/integrity.mjs`. Shape rules: `schema/*.schema.json`. Add a test that fails on the old code and passes on the new.
Remember that any change under `pipeline/` makes every gate report stale (section 8).

**A gate measure.** A script under `eval/` that runs the production code over a fixed `cases.json`, scores by code, and
writes its report with `eval/gate.mjs` `writeMeasureReport` carrying `checks_hash` from `eval/hash.mjs`. Then: add the
measure to `MEASURE_INPUTS` in `hash.mjs`, map the switch in `gate.mjs` `MEASURED`, add its case-set size in
`readGateInputs` `expected`, add its rule in `gate()`, add the command to `HOW`, and add tests in `eval/test.mjs`.

## 6. Data and schema rules

- Site data (`web/data/v2/`): `entries.json`, `news.json`, `relationships.json`, `site.json`, `content.json`, `changes.json`,
  `status.json`. Schemas: `schema/entry.schema.json` (with `common.schema.json`), `news`, `relationships`, `site`, `content`,
  `changes`, `status`, and `pipeline.schema.json` for the pipeline's own files. Check one file:
  `node schema/validate.mjs <schema> <file>`.
- Automated entries (`origin: automated` or `mixed`) need identifiers, a source, evidence quotes with source URLs, and
  `verification` by the agent; confidence level must match its basis.
- `schema/integrity.mjs` (`checkIntegrity`, `pageFieldProblems`, `pressProblems`): every reference between files points at a
  real entry, dates are real, page fields and press links follow their rules.
- `publish/guards.mjs`: `checkPublish` (no status goes backwards; nothing deleted or edited outside what the step may change;
  per-run limits; source hashes unchanged), `checkNewEntry`, `checkLinks`.
- `schema/tracking.mjs`: every pending bill is followed (section 5).
- Every fact comes from an official source read in the session. A source that cannot be read leaves the fact out.
- `web/data/v2` and `docs/data/v2` must always hold the same bytes.

## 7. Components (short reference)

- **Grabber.** Congress.gov: bills updated since the cursor, tracked bills matched by `identifiers.external.congress_gov`,
  new bills through the title screen (`config/scope.draft.json`, then the AI intent check `grabber/intent.mjs`, which drops
  only a confident "no"); the official title is read when the list title is only a short name; a 5xx on the date-filtered list
  falls back to the plain list. Federal Register: phrase searches; entries carry `identifiers.external.federal_register`, and
  documents citing them are found. LegiScan: master lists per open session, `change_hash`, two bulk full-text searches
  (`precise_phrases`, `wide_query`), monthly cap in `state/legiscan-usage.json`. Bills without text wait in
  `state/waiting-for-text.json`.
- **Compare.** Code only. Verdicts as above; cosponsor count changes are `material` and handled by Tier A.
- **Tier A** (`publish/tier-a.mjs`). Official facts in fixed wording: events, status the record proves, cosponsor totals,
  Federal Register record facts (a revoke/amend/rescind document raises "may need updating" via `needs_reading`). It returns
  `disagreements` (record vs entry) which the report lists; it never overwrites them.
- **Tier B** (`publish/tier-b.mjs`). New entries from the AI step, only when `auto_publish.new_entries` is on; at most
  `max_new_entries_per_run`; adds the bill to the identifiers file.
- **Court dockets** (`publish/courts.mjs`). CourtListener entries since the last run for `config/courts.json` cases.
- **End of Congress / sessions.** See `OWNER-HANDBOOK.md` section 6. Both are code only, read each record first, and count
  against `max_entries_changed_per_run`.
- **Self-correction** (`correct/`). Once a day, up to 3 entries; reader + confirmer + code checks; fields mechanism,
  thresholds, penalties. By hand: `node correct/run.mjs [--dry-run] [--only k1,k2] [--max n] [--force]`.
- **Page fields** (`pagefields/`). Writer `generator`, reviewer `bill_reviewer`, code checks; up to 3 entries per run.
- **Links** (`links/`). Proposals for changed entries; only record-proved sponsor links are applied (`checkLinks`).
  Backtest: `node links/backtest.mjs`.
- **News** (`news/run.mjs`). Official adapters and feeds → events (`news/events.mjs`) rendered by the phrase bank → every
  automated item reviewed by `news/review.mjs` (role `validator`) before it is added → leads not covered go to the open-leads
  register (`state/news-open-leads.json`): each ends covered, rejected with a reason, or raised and expired. The weekly
  completeness check runs here (defaults: every 7 days, 10 days back, 10 searches; no `completeness` block in `publish.json`).
  All news state files are written together at the end of the news step.
- **Lawsuits** (`publish/lawsuits.mjs`, `agents/lawsuit.mjs`). Open official leads announcing a lawsuit → G.2 entry
  (writer + reviewer, facts quoted from the release); state `state/lawsuits.json`; up to 3 tries per lead. Off now.
- **Press-based news** (`news/press-news.mjs`). Groups leads from approved outlets and official sources; publishes when an
  official source confirms or two outlets of different owners report; the item's `check` line says "From press reports (…)"
  or "From the official release (…)", which the site shows under "How we checked". State `state/press-news.json`. Off now.
- **In the press** (`news/press.mjs`). Headline, outlet, date, link on one entry; max 5 per entry.
- **Spend.** Every AI call is appended to `state/ledger/<YYYY-MM>.jsonl`; the monthly cap stops all AI work when reached.

## 8. Traps (read before changing anything)

- **Every change under `pipeline/` makes every gate report stale.** `eval/hash.mjs` hashes all of `pipeline/` (code, prompts,
  config, case sets, fixtures, tests) except `node_modules/`, `data/`, `out/`, `state/`, `eval/reports/`, `eval/report.md`,
  `.env`, the identifiers files, and the `auto_publish` / `gate_override` blocks of `publish.json`. Free measures re-run
  themselves at the start of a run; paid ones (new bills, lawsuits, press-based news) must be re-run by hand or their switch
  stays off. No `gate_override` is set (the last one, for new bills, was removed on 26 Nov 2026).
- **Tests use frozen data**: `fixtures/live-2026-11-26/` and `fixtures/correct/`. Never read `web/data/v2` in a code test; live
  data changes every 4 hours and has broken tests three times. `links/test.mjs` is the one deliberate exception (it checks the
  real network).
- **Windows line endings**: many files are CRLF. Normalise `\r\n` before multi-line matches. Prefer the Edit tool.
- **Shell quoting**: `\b`, `\n` and quotes in bash heredocs and `node -e` get mangled. Write scripts to files; check for stray
  control characters (`grep -c $'\x08' file`).
- **State files are written only at the end of a news run** (`news/run.mjs` saves events, open leads and seen leads together).
  Never write state midway. Tests must pass temp paths, never the real `pipeline/state/`. Never commit a test-written
  `state/news-open-leads.json`.
- **Re-running a GitHub check reuses the old merge snapshot.** Use "Update branch", or close and reopen the PR.
- **Removed news items can come back** if their event stays in `state/news-events.json`. Remove the item and fix its cause
  (and for a linking bug, remove the wrongly keyed event).
- **`site-check auto`** fails if a news item disappears from an unchanged entry; record a real check on that entry.
- **Pages redeploy** a few minutes after a merge; check the live JSON with a cache-busting query string.
- **CourtListener** rate-limits (HTTP 429): space out calls. **Congress.gov** list titles are often short names: use
  `/titles` for the official title.
- Never commit `pipeline/out/`.
- Never print a key. `createHttp` scrubs listed secrets from errors; `update.mjs` scrubs error text before reporting it.

## 9. Tests

`npm test` runs every test file in sequence (the list is in `package.json`), each with `lib/test-cleanup.mjs`. Single areas:
`npm run test:schema`, `test:grabber`, `test:legiscan`, `test:compare`, `test:publish`, `test:update`, `test:correct`,
`test:links`, `test:news`, `test:report`, or `node <file>` for any test file (e.g. `node publish/test-congress-end.mjs`,
`node publish/test-session-end.mjs`, `node lib/test-backup-due.mjs`, `node news/test-press-news.mjs`,
`node publish/test-lawsuits.mjs`, `node audit/test.mjs`). Tests use recorded responses and scripted models: no network, no AI
spend (except `links/test.mjs`, which reads the live site data, and the explicit `smoke:` scripts).
