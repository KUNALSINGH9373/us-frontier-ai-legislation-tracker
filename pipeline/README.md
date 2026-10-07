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
- **What it keeps:** bills we already track (matched by `identifiers.external.congress_gov`) and new bills whose title passes the draft word list in `config/scope.draft.json`. Everything else is counted and dropped. **The word list is a draft for the author to confirm.**
- **Unchanged bills cost nothing:** a saved fingerprint per bill means a bill that has not changed is skipped, so a quiet run is one request.
- **Budget:** a hard cap on requests per run (default 400). If it is reached, the run stops cleanly and the next run resumes exactly where it stopped.
- **Failures:** rate limits and server errors are retried with growing waits; anything else fails the run. A failed run saves no state, so the next run starts from the same point and nothing is lost.
- **Outputs (git-ignored for now):** `data/runs/<run id>/changeset.json`, the raw text under `raw/`, and `data/state.json`.

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

## The Generator and Validator (`agents/`)

`node agents/run.mjs [run folder] [--item <id>]` takes a run folder that has a `diff.json` and, for every item the comparison step marked `material` or `new_entry_candidate`:

1. **Code writes what the record states exactly** (`derive.mjs`): title, short name, sponsor, signing and publication dates, status line, signing/publication events, and the section when a rule decides it (executive orders are section G). A model cannot get these wrong because it is never asked for them.
2. **The Generator** (an LLM) writes only what needs reading: what the item does, who it covers, penalties, and whether it is in scope. Every text field needs an evidence quote copied exactly from the source. It can never set status, type, level, jurisdiction or confidence: code sets those from rules (`rules.mjs`).
3. **The Validator** checks the draft in two independent layers. *Code:* schema, every quote found word for word in the source, every number and date present in the source, no "none located" claims, no leaked JSON syntax, no rambling fields. *An independent LLM reader* that sees only the source and a numbered list of claims, never the Generator's reasoning.
4. **Up to 3 rounds.** Every complaint is fed back to the Generator word for word. Outcomes: `publishable`, `out_of_scope` (both readers agree), or `held`.
5. **Held items** include: still failing after 3 rounds; the generator and reader disagree on scope (stops after one retry, recorded for the author); the bill text is not published yet (retried later); a source too long for one call (judged on its opening); the model service failing.

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

## Tests

```bash
npm test        # schema 49, grabber 41, federal register 23, compare 25 + 9, llm 25, derive 16, agents 77
```

Every test file was also checked by deliberately breaking the code and confirming a test fails.

## Not built yet

The held-item retry loop and the publisher (merge verified entries into the data, 24-hour delay, anomaly guard, rollback, heartbeat); the LegiScan and CourtListener Grabbers (waiting on keys); the GitHub workflows; and the UI reading v2.
