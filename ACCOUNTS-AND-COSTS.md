# US Frontier Law: accounts, keys and costs

Written 26 Nov 2026. Key **names** only. Never paste a key value into a file, a chat, an issue or a commit.

## 1. Where keys are kept

| Where | Used by | How to change |
|---|---|---|
| GitHub Actions secrets (repo → Settings → Secrets and variables → Actions) | The 4-hourly update (`.github/workflows/update.yml`) | Edit the secret on GitHub. The next run uses it. |
| `E:\uslegislation\.env` (outside the repo, never committed) | Runs on a computer (`node update.mjs`, tests that call real services, one-off scripts) | Edit the file. It is read by `pipeline/grabber/lib/env.mjs`, which searches upward from `pipeline/` and never prints values. |

The local `.env` holds: `CONGRESS_API_KEY`, `LEGISCAN_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_ACCESS_TOKEN`, `TELEGRAM_CHAT_ID`,
`COURTLISTENER_API_TOKEN`, `PLURAL_API_KEY`, `NYSENATE_API_KEY`.

The workflow passes these secrets to the update step: the same eight, plus the optional `HEALTHCHECK_URL` (heartbeat step).
The checks workflow (`check.yml`) uses no secrets.

If a key leaks: make a new key at the provider, update the GitHub secret and the local `.env`, then delete the old key.

## 2. Every account

| Service | Key name(s) | What it is used for (code) | Limits | Cost |
|---|---|---|---|---|
| Anthropic (Claude API) | `ANTHROPIC_API_KEY` | Every AI role (`pipeline/llm/anthropic.mjs`, built by `llm/make.mjs`): new-bill writer and reviewer, scope checks, self-correction, page fields, news review, press review, title screening, weekly completeness check | The pipeline's own monthly cap: **$50** (`pipeline/config/models.json` `monthly_cost_cap_usd`); warning at 80% (`monthly_warn_fraction`). Per run: 600,000 tokens; per item: 250,000 tokens (`limits`) | Paid, per token (section 3) |
| Congress.gov API | `CONGRESS_API_KEY` | Federal bills (`grabber/run.mjs`, `grabber/sources/congress.mjs`), end of Congress (`publish/congress-end.mjs`), bill texts for self-correction (`correct/run.mjs`) and tests (`eval/fetch-texts.mjs`), committee meetings and CRS reports for news (`news/sources/congress_extra.mjs`). The same api.data.gov key is also the fallback key for GovInfo (`news/sources/govinfo.mjs`) and Regulations.gov (`news/sources/regulations_gov.mjs`) | About 5,000 requests an hour (stated in `grabber/sources/congress.mjs`). Per run: the grabber has its own request cap; the end-of-Congress step at most 200 | Free |
| LegiScan | `LEGISCAN_API_KEY` | State bills (`grabber/run-legiscan.mjs`), end of state sessions (`publish/session-end.mjs`), bill texts (`correct/run.mjs`, `eval/fetch-texts.mjs`) | Pipeline cap **10,000 queries a month** (`pipeline/config/legiscan.json` `monthly_cap`; the free plan is listed as 10,000 or 30,000, the lower figure is used), `per_run_budget` 100. Counted in `pipeline/state/legiscan-usage.json`. At the cap, LegiScan is skipped until next month | Free plan |
| CourtListener | `COURTLISTENER_API_TOKEN` | Court dockets of tracked lawsuits (`grabber/sources/courtlistener.mjs`, step "court dockets" in `update.mjs`) | 5 a minute, 50 an hour, 125 a day (stated in `courtlistener.mjs`); the pipeline paces at 5 a minute and at most 12 per run (`publish.json` `courts.max_requests_per_run`). It answers HTTP 429 when busy: space out calls | Free |
| NY Senate Open Legislation | `NYSENATE_API_KEY` | Actions and votes of tracked New York bills, for news (`news/sources/nysenate.mjs`) | Not stated in the code | Free |
| Open States (Plural) | `PLURAL_API_KEY` | Actions, votes and events of tracked state bills, for news (`news/sources/openstates.mjs`) | About 500 a day (stated in the code); the pipeline uses at most 60 per run and 400 a day, 1 request a second | Free |
| Telegram bot | `TELEGRAM_ACCESS_TOKEN` (or `TELEGRAM_BOT_TOKEN`), `TELEGRAM_CHAT_ID` | The run report and workflow warnings (`notify/telegram.mjs`). `node notify/telegram.mjs --whoami / --find-chat / --test` checks the setup | Messages over 4,000 characters are split | Free |
| Healthcheck (optional) | `HEALTHCHECK_URL` | Heartbeat after each successful real run (workflow step "Heartbeat"). Suggested setup in `update.yml`: period 4 h, grace 4 h, so it alerts when no run succeeds for 8 hours, even if GitHub stops the schedule | Set only if you use a service such as healthchecks.io | Usually free |
| Federal Register | none | Executive orders and rules (`grabber/run-federal-register.mjs`) | None needed | Free |
| GitHub | built-in `github.token` | Commits and pushes to `main`; the backup schedule reads past runs | Actions minutes on the repo's plan | Repo owner's plan |

Not used in production: `GEMINI_API_KEY` (only when `models.json` `provider` is `gemini`, for testing; production is `anthropic`).

## 3. AI models and prices

From `pipeline/config/models.json` (`provider: "anthropic"`, `anthropic.roles`).

| Role | Model | Effort | Job |
|---|---|---|---|
| `writer` | claude-sonnet-5-5 | medium | Writes a new bill's entry from the whole bill; writes lawsuit entries |
| `bill_reviewer` | claude-opus-5-5 | low | Independent fact-check of new entries; also reviews page fields, press links, lawsuit entries, press-based news |
| `scope_judge` | claude-opus-5-5 | medium | Separate scope check for new bills |
| `scorer` | claude-opus-5-5 | low | Test runs only (new-bills and press-based news tests); never in a daily run |
| `generator` | claude-sonnet-5-5 | low | Older new-entry loop; page fields; press-based news writer |
| `validator` | claude-haiku-5-5 | low | Independent review of every automated news item (`news/review.mjs`); independent reader in the older loop; press-based news grouper |
| `referee` | claude-opus-5-5 | low | Second opinion on scope in the older loop; escalation writer |
| `reviewer` | claude-haiku-5-5 | low | Self-correction reader |
| `confirmer` | claude-sonnet-5-5 | low | Self-correction: must agree before a fix |
| `auditor` | claude-sonnet-5-5 | medium | Weekly completeness check with web search |
| `screener` | claude-haiku-5-5 | low | Title and headline screens |
| `scope_checker` | claude-haiku-5-5 | low | One-off scope check tool (`scope-check/run.mjs`), not part of the daily run |

Prices, USD per million tokens (`prices_per_million_tokens`):

| Model | Input | Output |
|---|---|---|
| claude-haiku-5-5 | $0.10 ($0.50 if the prompt is over 100,000 tokens) | $0.50 ($2.50 if the prompt is over 100,000 tokens) |
| claude-sonnet-5-5 | $2 | $10 |
| claude-opus-5-5 | $4 | $20 |

Web search (completeness check only): $10 per 1,000 searches (note in `models.json`); at most 10 searches a week.

## 4. Real spend so far

Every AI call is written to `pipeline/state/ledger/<YYYY-MM>.jsonl` (one line per call: time, role, model, tokens, cost).
Totals below are summed from those files on 26 Nov 2026.

| Month | Calls | Total | Notes |
|---|---|---|---|
| October 2026 (ledger starts 27 Oct) | 466 | **$1.47** | Five days only |
| November 2026 (1–26 Nov) | 1,071 | **$21.92** | Includes about $6 of one-off page-field backfill on 11–12 Nov |

November by role: bill_reviewer $7.70, writer $6.74, generator $4.30, confirmer $1.71, referee $0.63, scope_judge $0.53,
reviewer $0.17, validator $0.08, screener $0.05, scorer $0.01.

November by model: Sonnet $12.76, Opus $8.87, Haiku $0.30.

November by kind of work: new federal bills (Congress.gov items) $9.47, page fields $7.54, self-correction $1.88, Federal
Register items $1.17, duties $0.94, executive-action checklists $0.43, press review $0.29, other under $0.15 each.

Busiest days: 11 Nov $6.86 (page-field backfill), 19 Nov $4.73 (new federal bills), 12 Nov $2.95. Most other days were under $1.

The weekly completeness check had not yet run on 26 Nov (no `auditor` calls on the ledger).

### Expected monthly spend

- Normal month, from November without the one-off backfill: about **$16–20**. This depends mostly on how many new federal
  bills appear (each new bill costs roughly $0.50–$1.50 for writer + reviewer).
- Add a few dollars a month if `lawsuits` or `press_news` are switched on, and about $1–3 per paid gate test run.
- The $50 cap leaves room. At $40 (80%) a warning appears in the report. At $50 AI work stops until the 1st of next month.

These are estimates from the ledger, not a promise.

## 5. How to see current spend

- **Every Telegram report**: "📅 This month $X of $50.00 (Y%)", and "💰 AI cost" for that run.
- **On disk**: `pipeline/state/ledger/<YYYY-MM>.jsonl` (committed with each run). LegiScan use: `pipeline/state/legiscan-usage.json`.
- **At the provider**: the Anthropic console shows the account's real bill. The pipeline's figure is its own estimate from token
  counts and the prices in `models.json`. If Anthropic changes its prices, update `prices_per_million_tokens`, or the cap will
  count wrong.
