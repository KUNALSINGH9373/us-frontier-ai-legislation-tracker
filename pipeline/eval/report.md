# Accuracy test set: latest report

Run 2026-10-30 06:38 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts b3f9a256901c · 20 items · 1,798,301 tokens

Outcomes: out_of_scope 3, published 11, held 6. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 75% of 4 (wrong: s-5061-secure-ai-development-act).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 17 | 11 | **65%** | 11 | 0 | 33% (10) |
| thresholds | 17 | 8 | **47%** | 10 | 0 | 49% (12) |
| penalties | 17 | 11 | **65%** | 8 | 0 | 0% (1) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 3 | ok | pass | pass | pass |  |
| gain-ai-act-of-2025-s-3150 | published | 2 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 15, 48) | fail | fail | thresholds is too long (745 characters) |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | penalties is too long (759 characters) |
| h-r-9965-atomic-act | published | 2 | ok | pass | fail (missing 50) | pass |  |
| il-hb-3506-2025 | published | 1 | ok | pass | fail (missing 12) | pass |  |
| il-hb-4705-sb-3261 | published | 3 | ok | pass | fail (missing 25) | pass |  |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 90, 30, 72, 24, 50, 11, 21) | fail (missing 10, 26, 50) | fail (missing 1000) | evidence quote for mechanism is not in the source: "Beginning January 1, 2028, a large frontier developer shall write, implement, co" |
| il-sb-3312 | held | 3 | ok | fail (missing 3312) | fail (missing 10, 26) | fail | claim about thresholds ("Frontier model: Foundation model trained with greater than 10^26 integer or floating-point operation") is not suppo |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | evidence quote for mechanism is not in the source: "within 72 hours of the date the developer learns of the safety incident or withi" |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | held | 2 | ok | fail | fail (missing 10, 26, 100, 25) | fail | the referee did not confirm the scope with a quote found in the text |
| ny-raise-act-ch-699-ch-96 | published | 1 | ok | pass | pass | pass |  |
| oh-hb-628 | published | 1 | ok | pass | pass | pass |  |
| pa-h-b-2800-ai-risk-prevention-act | published | 3 | ok | pass | pass | pass |  |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
