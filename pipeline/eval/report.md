# Accuracy test set: latest report

Run 2026-10-16 08:46 UTC · provider **gemini** · generator `gemini-3.5-flash-lite` · reader `gemini-3.5-flash-lite` · prompts e5eef3ab37bf · 48 items · 1,248,142 tokens

Outcomes: held 23, out_of_scope 7, published 15, too_long 3. Scope agreement 100%.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 15 | **37%** | 15 | 0 | 2% (25) |
| thresholds | 41 | 13 | **32%** | 5 | 0 | 19% (16) |
| penalties | 41 | 15 | **37%** | 1 | 0 | 0% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | held | 3 | ok | fail (missing 30, 18) | fail | fail | number 25 in thresholds is not in the source |
| ca-ab-1405-auditor-registry | held | 3 | ok | fail (missing 10, 12) | fail | fail | claim about mechanism ("Requires the Government Operations Agency to establish an AI Auditor Registry allowing AI auditors t") is not suppor |
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | held | 3 | ok | fail (missing 15, 24) | fail (missing 10, 26, 50) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| ca-sb-813-ivos | published | 2 | ok | pass | pass | pass |  |
| chip-security-act-h-r-3447-cotton-companion | published | 1 | ok | pass | pass | pass |  |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | held | 3 | ok | fail | fail | fail | claim about thresholds ("4,800 or more; 2,400 or more; 1,600 or more; 1,400 gigabytes per second or more; 1,100 gigabytes per") is not suppo |
| h-r-10180-self-improving-ai-monitoring-act | published | 1 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | held | 3 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| h-r-10362-stop-rogue-ai-act | held | 1 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| h-r-9363-ai-security-and-innovation-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | published | 3 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 15, 48) | fail | fail | the independent reader gave an unusable answer |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | evidence quote for thresholds is not in the source: "1,000,000,000 in AI-related development expenditures" |
| h-r-9965-atomic-act | held | 3 | ok | fail (missing 90) | fail (missing 10, 26, 50) | fail | thresholds is too long (600 characters) |
| il-hb-3506-2025 | published | 1 | ok | pass | fail (missing 12) | pass |  |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | number 500000000 in thresholds is not in the source |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 10, 90, 30, 15, 72, 24, 17, 18, 50, 20, 35, 11, 21) | fail (missing 10, 26, 50, 25) | fail (missing 1000, 10) | evidence quote for mechanism is not in the source: "Beginning January 1, 2028, a large frontier developer shall write, implement, co" |
| il-sb-3312 | held | 3 | ok | fail (missing 3312) | fail (missing 10, 26) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| il-sb-3444 | published | 2 | ok | pass | pass | pass |  |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 434496 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | published | 2 | ok | pass | fail (missing 12) | pass |  |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | held | 1 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | scope disagreement: generator out, reader in |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | published | 3 | ok | pass | pass | pass |  |
| ny-raise-act-ch-699-ch-96 | held | 3 | ok | fail (missing 44, 1420, 1421, 1422, 1425) | fail (missing 10, 26, 1420, 1423) | fail (missing 1421) | evidence quote for thresholds is not in the source: "greater than 10^26" |
| ny-s-10373-verification | held | 3 | ok | fail (missing 1425) | fail | fail | evidence quote for penalties is not in the source: "civil penalty in an amount not to exceed one million dollars for a first violati" |
| ny-s-10456-minimum-standards | published | 1 | ok | pass | pass | pass |  |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | held | 1 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 500000000, 50, 1000000000) | fail | number 300 in thresholds is not in the source |
| ri-s-358-h-5224 | held | 1 | ok | fail | fail (missing 10, 26, 25) | fail | scope disagreement: generator out, reader in |
| s-1792-h-r-3460-ai-whistleblower-protection-act | held | 3 | ok | fail | fail | fail | an independent reader judged this item out of scope: no answer |
| s-2938-ai-risk-evaluation-act | held | 3 | ok | fail | fail (missing 10, 26) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| s-4656-military-ai-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 1 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 1 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | held | 3 | ok | fail | fail | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | published | 1 | ok | pass | pass | pass |  |
| s-5541-cyber-and-ai-board-of-investigations | held | 3 | ok | fail | fail | fail | evidence quote for mechanism is not in the source: "establish as an independent establishment" |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | held | 2 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
