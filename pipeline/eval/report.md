# Accuracy test set: latest report

Run 2026-10-30 07:07 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b3f9a256901c · 20 items · 1,523,259 tokens

Outcomes: out_of_scope 4, held 5, published 11. Scope agreement 95% (wrong: mn-hf-4532-no-threshold).

Section (D, F or G.3, published federal bills): 100% of 5.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 17 | 11 | **65%** | 11 | 0 | 24% (11) |
| thresholds | 17 | 6 | **35%** | 11 | 0 | 48% (13) |
| penalties | 17 | 11 | **65%** | 9 | 0 | 50% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | held | 3 | ok | fail (missing 15, 24) | fail (missing 10, 26, 500000000, 50, 1000000000) | fail (missing 1000000) | mechanism is too long (1111 characters) |
| gain-ai-act-of-2025-s-3150 | published | 2 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 100000000, 15, 48, 2000000, 20000000) | fail (missing 100000000, 500000000) | fail | the referee did not confirm the scope with a quote found in the text |
| h-r-9925-frontier-act | published | 3 | ok | pass | fail (missing 50) | pass |  |
| h-r-9965-atomic-act | published | 1 | ok | pass | fail (missing 50, 100000000) | pass |  |
| il-hb-3506-2025 | published | 1 | ok | pass | fail (missing 12) | pass |  |
| il-hb-4705-sb-3261 | published | 2 | ok | pass | pass | pass |  |
| il-sb-315-p-a-104-0538 | published | 2 | ok | pass | fail (missing 50, 1000000000) | pass |  |
| il-sb-3312 | held | 3 | ok | fail (missing 3312) | fail (missing 10, 26, 500000000) | fail | mechanism is too long (1206 characters) |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| mn-hf-4532-no-threshold | out_of_scope | 1 | **wrong** | fail (missing 72, 10000000, 30000000) | fail (missing 25, 1000000) | fail |  |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | held | 1 | ok | fail | fail (missing 10, 26, 25) | fail | the referee did not confirm the scope with a quote found in the text |
| ny-raise-act-ch-699-ch-96 | published | 1 | ok | pass | pass | pass |  |
| oh-hb-628 | held | 3 | ok | fail | fail | fail | the referee did not confirm the scope with a quote found in the text |
| pa-h-b-2800-ai-risk-prevention-act | published | 2 | ok | pass | fail (missing 50, 1000000000) | pass |  |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
