# Accuracy test set: latest report

Run 2026-10-27 16:44 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts b1599af437d2 · 15 items · 896,741 tokens

Outcomes: published 10, out_of_scope 4, held 1. Scope agreement 87% (wrong: h-r-10189-defense-ai-reliability-act, h-r-10362-stop-rogue-ai-act).

Section (D or F, published federal bills): 89% of 9 (wrong: h-r-9914-s-5105-catsr).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 13 | 10 | **77%** | 10 | 0 | 18% (5) |
| thresholds | 13 | 8 | **62%** | 9 | 0 | 56% (4) |
| penalties | 13 | 9 | **69%** | 5 | 0 | 0% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | published | 2 | ok | pass | pass | pass |  |
| chip-security-act-h-r-3447-cotton-companion | published | 1 | ok | pass | pass | pass |  |
| gain-ai-act-of-2025-s-3150 | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | out_of_scope | 1 | **wrong** | fail | fail | fail |  |
| h-r-10362-stop-rogue-ai-act | out_of_scope | 1 | **wrong** | fail | fail | fail |  |
| h-r-9914-s-5105-catsr | published | 2 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | published | 3 | ok | pass | pass | pass |  |
| h-r-9925-frontier-act | published | 2 | ok | pass | fail (missing 50) | pass |  |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 10, 90, 30, 15, 72, 24, 17, 18, 50, 20, 35, 11, 21) | fail (missing 10, 26, 50, 25) | fail (missing 1000, 10) | claim about events_add[1] ("On 2028-01-01 (Effective): Frontier AI framework duty for large frontier developers begins") is not supported: t |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| ny-raise-act-ch-699-ch-96 | published | 2 | ok | pass | fail (missing 1420, 1423) | fail (missing 1427, 1421) |  |
| s-1792-h-r-3460-ai-whistleblower-protection-act | published | 1 | ok | pass | pass | pass |  |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
