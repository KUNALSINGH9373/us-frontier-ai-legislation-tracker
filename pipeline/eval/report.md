# Accuracy test set: latest report

Run 2026-10-30 07:21 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b136495d84f9 · 9 items · 455,279 tokens

Outcomes: published 5, held 3, out_of_scope 1. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 100% of 1.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 8 | 5 | **63%** | 5 | 0 | 17% (6) |
| thresholds | 8 | 5 | **63%** | 5 | 0 | 83% (6) |
| penalties | 8 | 5 | **63%** | 5 | 0 | 100% (1) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ca-sb-53-tfaia | published | 1 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 1 | ok | fail (missing 10, 100000000, 15, 48, 2000000, 20000000) | fail (missing 100000000, 500000000) | fail | the referee did not confirm the scope with a quote found in the text (the referee gave an unusable answer: the model did not return valid JS |
| il-sb-3312 | published | 2 | ok | pass | pass | pass |  |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72, 10000000, 30000000) | fail | fail | claim about mechanism ("Before deploying an artificial intelligence model, a developer must implement a written safety and s") is not suppor |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | published | 1 | ok | pass | pass | pass |  |
| ny-raise-act-ch-699-ch-96 | published | 2 | ok | pass | pass | pass |  |
| oh-hb-628 | held | 2 | ok | fail | fail | fail | the referee did not confirm the scope with a quote found in the text (the referee gave an unusable answer: the model did not return valid JS |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
