# Drafting duty fields (session backfill)

Read the bill's stored official text and write `pipeline/duties/drafts/<key>.json`. A worked example that passes the checker: `drafts/ca-sb-53-tfaia.json`. Schema: `schema/entry.schema.json` → `duties`.

```
cd pipeline
node duties/stamp.mjs <key>      # fills source_url, text hash, and source_url on each answer
node duties/check.mjs <key>      # must print "ok"; fix every problem it lists
```

Text: `pipeline/data/eval/texts/<key>.txt` (the official text, git-ignored). Read it with the Read tool in pieces if long.

## Draft shape

```
{ "duties": { <13 answers> }, "notes": "optional, for the reviewer" }
```

Write no `source_url` or `basis`; `stamp.mjs` adds them. All 13 answers are required: `framework`, `transparency_report`, `incident_reporting`, `imminent_risk_reporting`, `third_party_audit`, `whistleblower`, `registration`, `shutdown`, `compute_threshold`, `revenue_threshold`, `harm_threshold`, `penalties`, `effective_date`.

Each answer is `{ value, summary, section, quote }`:

- **value**
  - `yes`: the bill imposes or sets it.
  - `partial`: it does, with a limit the summary states (for example "describes third-party testing, no audit required"; "applies only to federal agencies"; "study only").
  - `no`: the bill expressly excludes or negates it (a quote of that exclusion is required).
  - `not_in_bill`: the text is silent. No section, no quote.
- **summary**: one plain-English line, at most 240 characters. A reader with no legal background should follow it. Say who must do what.
- **section**: the section as the bill numbers it (`Sec. 4(b)`, `22757.12(a)`, `R.S. 51:3111.4`).
- **quote**: ONE exact span copied from the text, 8 to 400 characters, that proves the answer. Copy it character for character (case, spacing and line breaks may differ; wording, numbers and punctuation inside the words may not). Prefer the operative sentence ("shall report ... within 15 days"), not a heading. Do not join two passages with "...".

## What each duty means

| Key | `yes` when the bill... |
|---|---|
| `framework` | requires a developer to write, publish or follow a safety / risk-management / security framework, plan or protocol |
| `transparency_report` | requires a public report or disclosure about a model (system card, risk summary) |
| `incident_reporting` | requires reporting safety or security incidents to a government body (state the window) |
| `imminent_risk_reporting` | sets a shorter window for incidents posing imminent risk of death or serious injury |
| `third_party_audit` | requires an independent audit, evaluation or verification (`partial` when third-party testing is only described or optional) |
| `whistleblower` | protects employees who report risks or violations |
| `registration` | requires registering, licensing, permitting or notifying a regulator before developing or deploying |
| `shutdown` | requires a shutdown, kill-switch, stop or containment capability |
| `compute_threshold` | defines coverage by training compute (operations / FLOPs) |
| `revenue_threshold` | defines coverage by revenue, spending or users |
| `harm_threshold` | defines catastrophic or covered harm by deaths, injuries or damages |
| `penalties` | states penalties, fines or enforcement remedies (say who enforces) |
| `effective_date` | the text itself states when it takes effect or becomes operative. If the text says nothing, use `not_in_bill`; never fill in a date from outside knowledge. |

## Hard rules (the checker enforces most of them)

1. **Only what the text says.** No outside knowledge, no inference about intent. If a duty is implied but not stated, it is `not_in_bill`.
2. **Every number in a summary or quote must occur in the text.** Write figures the way the text writes them (`$500,000,000`, `10^26`, `24 hours`); a number the text spells out (`fifteen days`) may be written as digits.
3. **Duties are the bill's own requirements** on developers, deployers or agencies, not findings, purposes or definitions of terms nobody must act on. A definition counts only for the three thresholds.
4. **Resolutions, studies and grants:** a bill that only orders a study or report by an agency is `partial` at most, and the summary must say who has the duty (for example "the Secretary must study ..., no duty on developers").
5. **Amendments to existing law** (the bill edits another statute): describe what the new text requires; the quote is the new text.
6. **Long or multi-part texts:** search the text (Grep) for the key terms (`report`, `incident`, `audit`, `evaluat`, `whistleblower`, `register`, `license`, `shut`, `terminate`, `kill`, `penalt`, `civil`, `fine`, `effective`, `take effect`, `operative`, `computing power`, `operations`, `revenue`, `gross`, `catastrophic`) and then read the matching sections in full before answering. Do not answer from the digest or the title alone.
7. **Two bills in one entry** (a House and a Senate bill): the stored text is the first bill. Draft from it and say in `notes` if the entry names a companion whose text you did not read.
8. Use `notes` to tell the reviewer anything that needs a human eye: the text is a draft substitute, a section looks garbled, the existing entry (`web/data/v2/entries.json`, fields `mechanism`, `thresholds`, `penalties`) says something the text does not, or the bill is out of the usual shape.

Do not edit any file other than your drafts. Do not commit.
