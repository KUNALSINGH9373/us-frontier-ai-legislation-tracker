# Accuracy test set: latest report

Run 2026-10-30 09:04 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b136495d84f9 · 4 items · 190,401 tokens

Outcomes: held 2, published 2. Scope agreement 100%.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 4 | 2 | **50%** | 2 | 0 | 25% (2) |
| thresholds | 4 | 2 | **50%** | 2 | 0 | 100% (1) |
| penalties | 4 | 2 | **50%** | 1 | 0 | n/a (0) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | held | 3 | ok | fail (missing 30, 18) | fail | fail | thresholds is too long (1093 characters) |
| gain-ai-act-of-2025-s-3150 | held | 3 | ok | fail | fail | fail | thresholds is too long (1071 characters) |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| mi-hb-4668 | published | 1 | ok | pass | pass | pass |  |
