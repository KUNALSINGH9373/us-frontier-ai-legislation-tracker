# Accuracy test set: latest report

Run 2026-10-30 08:54 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b136495d84f9 · 9 items · 413,781 tokens

Outcomes: published 7, held 2. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 75% of 4 (wrong: h-r-9914-s-5105-catsr).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 9 | 7 | **78%** | 7 | 0 | 25% (6) |
| thresholds | 9 | 7 | **78%** | 7 | 0 | 50% (4) |
| penalties | 9 | 7 | **78%** | 3 | 0 | n/a (0) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | published | 3 | ok | pass | pass | pass |  |
| gain-ai-act-of-2025-s-3150 | published | 2 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | published | 1 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | published | 2 | ok | pass | pass | pass |  |
| il-hb-3506-2025 | held | 0 | ok | fail (missing 90) | fail (missing 5000000, 100000000, 12) | fail | an amendment was adopted since the bill text was printed (held, as production does: agents/process-item.mjs) |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| mi-hb-4668 | published | 1 | ok | pass | pass | pass |  |
| mn-hf-4532-no-threshold | published | 2 | ok | pass | pass | pass |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 26, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 26, 500000000) | fail | claim about mechanism ("Beginning January 1, 2027, a large frontier developer may not operate a frontier model in Pennsylvan") is not suppor |
