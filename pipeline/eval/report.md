# Accuracy test set: latest report

Run 2026-10-30 06:20 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts b3f9a256901c · 20 items · 1,977,397 tokens

Outcomes: out_of_scope 3, published 6, held 11. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 75% of 4 (wrong: h-r-9965-atomic-act).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 17 | 6 | **35%** | 6 | 0 | 15% (10) |
| thresholds | 17 | 6 | **35%** | 6 | 0 | 25% (12) |
| penalties | 17 | 6 | **35%** | 5 | 0 | 0% (1) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 2 | ok | pass | pass | pass |  |
| gain-ai-act-of-2025-s-3150 | published | 3 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 15, 48) | fail | fail | thresholds is too long (667 characters) |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | mechanism is too long (912 characters) |
| h-r-9965-atomic-act | published | 2 | ok | pass | pass | pass |  |
| il-hb-3506-2025 | held | 3 | ok | fail (missing 90) | fail (missing 100, 12) | fail | thresholds is too long (571 characters) |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | thresholds is too long (797 characters) |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 90, 30, 72, 24, 50, 11, 21) | fail (missing 10, 26, 50) | fail (missing 1000) | mechanism is too long (1047 characters) |
| il-sb-3312 | held | 3 | ok | fail (missing 3312) | fail (missing 10, 26) | fail | claim about mechanism ("Section 10: large frontier developers must publish a frontier AI framework. Section 10: frontier dev") is not suppor |
| il-sb-3444 | held | 3 | ok | fail | fail | fail | mechanism is too long (958 characters) |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | mechanism is too long (921 characters) |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | held | 3 | ok | fail | fail (missing 10, 26, 100, 25) | fail | mechanism is too long (1029 characters) |
| ny-raise-act-ch-699-ch-96 | held | 3 | ok | fail (missing 44) | fail (missing 10, 26) | fail | mechanism is too long (957 characters) |
| oh-hb-628 | published | 3 | ok | pass | pass | pass |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 26, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 26, 500000000, 50, 1000000000) | fail | thresholds is too long (916 characters) |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 3 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
