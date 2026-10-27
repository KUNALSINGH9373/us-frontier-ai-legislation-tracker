# Accuracy test set: latest report

Run 2026-10-27 16:55 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts 146f8413e04b · 5 items · 254,377 tokens

Outcomes: published 2, out_of_scope 3. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 100% of 2.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 2 | 2 | **100%** | 2 | 0 | n/a (0) |
| thresholds | 2 | 2 | **100%** | 2 | 0 | n/a (0) |
| penalties | 2 | 2 | **100%** | 0 | 0 | n/a (0) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| h-r-10189-defense-ai-reliability-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10362-stop-rogue-ai-act | published | 2 | ok | pass | pass | pass |  |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
