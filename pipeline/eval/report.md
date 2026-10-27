# Accuracy test set: latest report

Run 2026-10-27 11:51 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts 64c0412d08f7 · 48 items · 2,407,772 tokens

Outcomes: published 30, out_of_scope 10, too_long 3, held 5. Scope agreement 94% (wrong: h-r-10362-stop-rogue-ai-act, h-r-9914-s-5105-catsr, s-1792-h-r-3460-ai-whistleblower-protection-act).

Section (D or F, published federal bills): 92% of 13 (wrong: s-5471-ai-systems-transparency-act).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 30 | **73%** | 30 | 0 | 16% (25) |
| thresholds | 41 | 23 | **56%** | 28 | 0 | 51% (16) |
| penalties | 41 | 28 | **68%** | 17 | 0 | 25% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | published | 3 | ok | pass | pass | pass |  |
| ca-ab-1405-auditor-registry | published | 2 | ok | pass | pass | pass |  |
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 2 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 2 | ok | pass | fail (missing 50) | pass |  |
| ca-sb-813-ivos | published | 2 | ok | pass | pass | pass |  |
| chip-security-act-h-r-3447-cotton-companion | published | 2 | ok | pass | pass | pass |  |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | published | 3 | ok | pass | pass | pass |  |
| h-r-10180-self-improving-ai-monitoring-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | held | 3 | ok | fail | fail | fail | an independent reader judged this item out of scope: SOURCE does not state any scope classification. It never mentions frontier or advanced  |
| h-r-10362-stop-rogue-ai-act | out_of_scope | 1 | **wrong** | fail | fail | fail |  |
| h-r-9363-ai-security-and-innovation-act | published | 3 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | out_of_scope | 1 | **wrong** | fail | fail | fail |  |
| h-r-9917-ai-kill-switch-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9925-frontier-act | published | 3 | ok | pass | fail (missing 50, 36) | pass |  |
| h-r-9965-atomic-act | published | 2 | ok | pass | fail (missing 50) | pass |  |
| il-hb-3506-2025 | published | 3 | ok | pass | fail (missing 12) | pass |  |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | claim about thresholds ("Frontier model: greater than 10^26 integer or floating-point operations. Large frontier developer: r") is not suppo |
| il-sb-315-p-a-104-0538 | published | 3 | ok | pass | fail (missing 10, 26, 25) | fail (missing 10) |  |
| il-sb-3312 | published | 2 | ok | pass | fail (missing 10, 26) | pass |  |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 630351 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | published | 2 | ok | pass | pass | pass |  |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | claim about mechanism ("Requires developers to implement a written safety and security protocol and conspicuously publish it") is not suppor |
| nj-s-1802 | out_of_scope | 2 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | published | 1 | ok | pass | pass | pass |  |
| ny-raise-act-ch-699-ch-96 | published | 2 | ok | pass | fail (missing 1420, 1423) | fail (missing 1427, 1421) |  |
| ny-s-10373-verification | published | 2 | ok | pass | pass | pass |  |
| ny-s-10456-minimum-standards | published | 2 | ok | pass | pass | pass |  |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | held | 3 | ok | fail | fail | fail | evidence quote for mechanism is not in the source: "rebuttable presumption against liability if all of the following apply" |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 500000000, 50, 1000000000) | fail | claim about events_add[2] ("On 2027-01-01 (Effective): Large frontier developers may not develop, deploy or operate a frontier m") is not su |
| ri-s-358-h-5224 | published | 3 | ok | pass | pass | pass |  |
| s-1792-h-r-3460-ai-whistleblower-protection-act | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| s-2938-ai-risk-evaluation-act | published | 2 | ok | pass | pass | pass |  |
| s-4656-military-ai-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 1 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | published | 2 | ok | pass | pass | pass |  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | published | 3 | ok | pass | pass | pass |  |
| s-5541-cyber-and-ai-board-of-investigations | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | published | 2 | ok | pass | pass | pass |  |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
