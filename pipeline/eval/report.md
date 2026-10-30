# Accuracy test set: latest report

Run 2026-10-30 07:51 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b136495d84f9 · 9 items · 713,921 tokens

Outcomes: held 2, published 6, out_of_scope 1. Scope agreement 100%.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 8 | 6 | **75%** | 6 | 0 | 23% (7) |
| thresholds | 8 | 5 | **63%** | 5 | 0 | 63% (4) |
| penalties | 8 | 6 | **75%** | 5 | 0 | n/a (0) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ct-p-a-26-15-ivo-pilot | held | 3 | ok | fail (missing 30) | fail | fail | claim about thresholds ("Frontier developer: uses or intends to use computing power greater than ten to the twenty-sixth powe") is not suppo |
| ct-p-a-26-15-omnibus | published | 1 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 2 | ok | fail (missing 10, 100000000, 15, 48, 2000000, 20000000) | fail (missing 100000000, 500000000) | fail | the referee did not confirm the scope with a quote found in the text (the referee gave an unusable answer: the model did not return valid JS |
| il-hb-3506-2025 | published | 2 | ok | pass | pass | pass |  |
| ma-h-5576-s-3178 | published | 2 | ok | pass | fail (missing 1000000000) | pass |  |
| mn-hf-4532-no-threshold | published | 1 | ok | pass | pass | pass |  |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| ny-raise-act-ch-699-ch-96 | published | 1 | ok | pass | pass | pass |  |
| oh-hb-628 | published | 2 | ok | pass | pass | pass |  |
