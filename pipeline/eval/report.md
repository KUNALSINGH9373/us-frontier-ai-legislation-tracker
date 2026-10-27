# Accuracy test set: latest report

Run 2026-10-27 11:32 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts 9078f17c7092 · 48 items · 1,943,977 tokens

Outcomes: held 18, out_of_scope 12, published 15, too_long 3. Scope agreement 90% (wrong: ca-sb-813-ivos, h-r-10362-stop-rogue-ai-act, s-1792-h-r-3460-ai-whistleblower-protection-act, s-5541-cyber-and-ai-board-of-investigations, va-ch-425-426-jcots-study).

Section (D or F, published federal bills): 100% of 9.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 15 | **37%** | 15 | 0 | 5% (25) |
| thresholds | 41 | 12 | **29%** | 15 | 0 | 40% (16) |
| penalties | 41 | 15 | **37%** | 10 | 0 | 0% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | held | 3 | ok | fail (missing 30, 18) | fail | fail | your answer was unusable: the model stopped early: max_tokens. |
| ca-ab-1405-auditor-registry | held | 3 | ok | fail (missing 10, 12) | fail | fail | an independent reader judged this item out of scope: The source does not mention frontier or large-scale AI developers or any size, compute, |
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 2 | ok | pass | fail (missing 50) | pass |  |
| ca-sb-813-ivos | out_of_scope | 2 | **wrong** | fail (missing 8898.4) | fail | fail |  |
| chip-security-act-h-r-3447-cotton-companion | held | 3 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | held | 3 | ok | fail | fail | fail | claim about thresholds ("Advanced integrated circuits with total processing performance of 4,800 or more; 2,400 or more with ") is not suppo |
| h-r-10180-self-improving-ai-monitoring-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | held | 3 | ok | fail | fail | fail | an independent reader judged this item out of scope: SOURCE does not state that the bill concerns frontier, large-scale, or advanced AI deve |
| h-r-10362-stop-rogue-ai-act | out_of_scope | 1 | **wrong** | fail | fail | fail |  |
| h-r-9363-ai-security-and-innovation-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | held | 1 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| h-r-9917-ai-kill-switch-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | your answer was unusable: the model stopped early: max_tokens. |
| h-r-9965-atomic-act | published | 3 | ok | pass | fail (missing 50) | pass |  |
| il-hb-3506-2025 | held | 3 | ok | fail (missing 90) | fail (missing 100, 12) | fail | claim about thresholds ("Developer: has trained a foundation model with computing power costing at least $100,000,000 at prev") is not suppo |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | your JSON does not match the required shape: (root) must NOT have additional properties |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 10, 90, 30, 15, 72, 24, 17, 18, 50, 20, 35, 11, 21) | fail (missing 10, 26, 50, 25) | fail (missing 1000, 10) | your answer was unusable: the model stopped early: max_tokens. |
| il-sb-3312 | published | 2 | ok | pass | fail (missing 10, 26) | pass |  |
| il-sb-3444 | published | 1 | ok | pass | pass | pass |  |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 630351 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | published | 2 | ok | pass | pass | pass |  |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | evidence quote for mechanism is not in the source: "A developer must disclose each safety incident affecting the artificial intellig" |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | published | 2 | ok | pass | pass | pass |  |
| ny-raise-act-ch-699-ch-96 | held | 3 | ok | fail (missing 44, 1420, 1429, 1421, 1422, 1428, 1425, 1426, 1427) | fail (missing 10, 26, 1420, 1423) | fail (missing 1427, 1421) | your JSON does not match the required shape: (root) must NOT have additional properties |
| ny-s-10373-verification | held | 3 | ok | fail (missing 1425) | fail | fail | claim about penalties ("Civil penalty not to exceed one million dollars for a first violation and three million dollars per ") is not suppor |
| ny-s-10456-minimum-standards | held | 3 | ok | fail (missing 1430) | fail | fail | claim about events_add[0] ("On 2028-07-01 (Search date / deadline / scheduled): Deadline for the office to adopt regulations") is not suppor |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | held | 3 | ok | fail | fail | fail | evidence quote for mechanism is not in the source: "The attorney general may license an applicant as an independent verification org" |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 500000000, 50, 1000000000) | fail | your answer was unusable: the model stopped early: max_tokens. |
| ri-s-358-h-5224 | published | 3 | ok | pass | pass | pass |  |
| s-1792-h-r-3460-ai-whistleblower-protection-act | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| s-2938-ai-risk-evaluation-act | published | 2 | ok | pass | pass | pass |  |
| s-4656-military-ai-act | held | 3 | ok | fail (missing 72) | fail | fail | your answer was unusable: the model stopped early: max_tokens. |
| s-5061-secure-ai-development-act | published | 3 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 1 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | held | 3 | ok | fail | fail | fail | claim about thresholds ("Covered model: generative AI model deployed in covered systems with not fewer than 1,000,000 unique ") is not suppo |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | published | 2 | ok | pass | pass | pass |  |
| s-5541-cyber-and-ai-board-of-investigations | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | out_of_scope | 3 | **wrong** | fail | fail | fail |  |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
