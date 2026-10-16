# Accuracy test set: latest report

Run 2026-10-16 07:44 UTC · provider **gemini** · generator `gemini-3.5-flash` · reader `gemini-3.5-flash` · prompts e44238988cf5 · 48 items · 1,538,771 tokens

Outcomes: held 23, out_of_scope 16, too_long 3, published 6. Scope agreement 81% (wrong: ca-ab-1405-auditor-registry, chip-security-act-h-r-3447-cotton-companion, h-r-10189-defense-ai-reliability-act, h-r-10362-stop-rogue-ai-act, h-r-9914-s-5105-catsr, mn-hf-4532-no-threshold, oh-hb-628, s-1792-h-r-3460-ai-whistleblower-protection-act, s-5541-cyber-and-ai-board-of-investigations).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 6 | **15%** | 6 | 0 | 0% (25) |
| thresholds | 41 | 6 | **15%** | 2 | 0 | 0% (16) |
| penalties | 41 | 6 | **15%** | 1 | 0 | 0% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | held | 3 | ok | fail (missing 30, 18) | fail | fail | thresholds is too long (3485 characters) |
| ca-ab-1405-auditor-registry | out_of_scope | 1 | **wrong** | fail (missing 10, 12) | fail | fail |  |
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | held | 3 | ok | fail (missing 15, 24) | fail (missing 10, 26, 50) | fail | thresholds is too long (697 characters) |
| ca-sb-813-ivos | held | 2 | ok | fail (missing 8898.4) | fail | fail | scope disagreement: generator out, reader in |
| chip-security-act-h-r-3447-cotton-companion | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | published | 1 | ok | pass | pass | pass |  |
| h-r-10180-self-improving-ai-monitoring-act | held | 3 | ok | fail (missing 15, 278) | fail | fail | evidence quote for mechanism is not in the source: "Amends the National Institute of Standards and Technology Act to authorize certa" |
| h-r-10189-defense-ai-reliability-act | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| h-r-10362-stop-rogue-ai-act | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| h-r-9363-ai-security-and-innovation-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 15, 48) | fail | fail | no evidence quote for mechanism |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | evidence quote for thresholds is not in the source: "incurred not less than $1,000,000,000 in AI-related development expenditures." |
| h-r-9965-atomic-act | held | 3 | ok | fail (missing 90) | fail (missing 10, 26, 50) | fail | claim about thresholds ("Models trained using over 10^26 operations; developers expending at least $2,000,000,000 on AI inves") is not suppo |
| il-hb-3506-2025 | held | 3 | ok | fail (missing 90) | fail (missing 100, 12) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | evidence quote for thresholds is not in the source: "quantity of computing power greater than 10^26 integer or floating-point operati" |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 10, 90, 30, 15, 72, 24, 17, 18, 50, 20, 35, 11, 21) | fail (missing 10, 26, 50, 25) | fail (missing 1000, 10) | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| il-sb-3312 | held | 3 | ok | fail (missing 3312) | fail (missing 10, 26) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| il-sb-3444 | held | 3 | ok | fail | fail | fail | evidence quote for thresholds is not in the source: "trained using greater than 10^26 computational operations, such as integer or fl" |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 434496 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | held | 3 | ok | fail (missing 90, 100) | fail (missing 100, 12) | fail | stray code or JSON syntax in thresholds |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | out_of_scope | 2 | **wrong** | fail (missing 72) | fail (missing 25, 1000000) | fail |  |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | held | 3 | ok | fail | fail (missing 10, 26, 100, 25) | fail | claim about mechanism ("Requires large frontier developers with users in New Jersey to write and implement technical and org") is not suppor |
| ny-raise-act-ch-699-ch-96 | held | 3 | ok | fail (missing 44, 1420, 1421, 24, 1422, 50, 1425) | fail (missing 10, 26, 1420, 50, 1423) | fail (missing 1421) | evidence quote for mechanism is not in the source: "conduct an annual review of any safety and security protocol" |
| ny-s-10373-verification | published | 2 | ok | pass | pass | pass |  |
| ny-s-10456-minimum-standards | held | 3 | ok | fail (missing 1430) | fail | fail | an independent reader judged this item out of scope: The tracker's specific definition of coverage and scope rules are not stated in the SOU |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 500000000, 50, 1000000000) | fail | thresholds is too long (7764 characters) |
| ri-s-358-h-5224 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | an independent reader judged this item out of scope: The claim refers to the scope of an external tracker, which is not mentioned in or supp |
| s-1792-h-r-3460-ai-whistleblower-protection-act | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| s-2938-ai-risk-evaluation-act | held | 3 | ok | fail | fail (missing 10, 26) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| s-4656-military-ai-act | published | 2 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | held | 2 | ok | fail (missing 90, 16) | fail | fail | scope disagreement: generator out, reader in |
| s-5471-ai-systems-transparency-act | held | 3 | ok | fail | fail | fail | an independent reader judged this item out of scope: SOURCE does not mention 'the tracker' or state criteria for inclusion in a tracker; it  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | held | 3 | ok | fail (missing 30, 24, 20, 10) | fail (missing 10, 25) | fail | thresholds is too long (21780 characters) |
| s-5541-cyber-and-ai-board-of-investigations | out_of_scope | 2 | **wrong** | fail | fail | fail |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | held | 1 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
