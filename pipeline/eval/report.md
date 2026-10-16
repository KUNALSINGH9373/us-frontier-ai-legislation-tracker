# Accuracy test set: latest report

Run 2026-10-16 07:37 UTC · provider **gemini** · generator `gemini-3.5-flash-lite` · reader `gemini-3.5-flash-lite` · prompts e44238988cf5 · 48 items · 1,361,973 tokens

Outcomes: held 26, published 12, too_long 3, error 3, out_of_scope 4. Scope agreement 100%.

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 12 | **29%** | 12 | 0 | 2% (25) |
| thresholds | 41 | 12 | **29%** | 0 | 0 | 0% (16) |
| penalties | 41 | 12 | **29%** | 0 | 0 | 0% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | held | 3 | ok | fail (missing 30, 18) | fail | fail | evidence quote for thresholds is not in the source: "an integrated circuit, computer, or other product-- (I) classified under Export " |
| ca-ab-1405-auditor-registry | published | 2 | ok | pass | pass | pass |  |
| ca-sb-1119-adam-s-law-and-sb-867 | held | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail | scope disagreement: generator out, reader in |
| ca-sb-53-tfaia | held | 3 | ok | fail (missing 15, 24) | fail (missing 10, 26, 50) | fail | thresholds is too long (19953 characters) |
| ca-sb-813-ivos | held | 3 | ok | fail (missing 8898.4) | fail | fail | claim about mechanism ("The Government Operations Agency must develop application requirements for designation as an indepen") is not suppor |
| chip-security-act-h-r-3447-cotton-companion | held | 3 | ok | fail | fail | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | held | 3 | ok | fail | fail | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| h-r-10180-self-improving-ai-monitoring-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10362-stop-rogue-ai-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9363-ai-security-and-innovation-act | published | 3 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | published | 2 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | held | 3 | ok | fail (missing 10, 15, 48) | fail | fail | thresholds is too long (2797 characters) |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50, 36) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| h-r-9965-atomic-act | held | 3 | ok | fail (missing 90) | fail (missing 10, 26, 50) | fail | number 100 in thresholds is not in the source |
| il-hb-3506-2025 | held | 3 | ok | fail (missing 90) | fail (missing 100, 12) | fail | evidence quote for thresholds is not in the source: ""Developer" means a person that has trained at least one foundation model with a" |
| il-hb-4705-sb-3261 | held | 3 | ok | fail | fail (missing 10, 26, 25) | fail | evidence quote for thresholds is not in the source: "frontier model that was trained using a quantity of computing power greater than" |
| il-sb-315-p-a-104-0538 | error | 0 | ok | fail (missing 10, 90, 30, 15, 72, 24, 17, 18, 50, 20, 35, 11, 21) | fail (missing 10, 26, 50, 25) | fail (missing 1000, 10) | LLM budget reached: 60000 tokens for item il-sb-315-p-a-104-0538 |
| il-sb-3312 | error | 0 | ok | fail (missing 3312) | fail (missing 10, 26) | fail | LLM budget reached: 60000 tokens for item il-sb-3312 |
| il-sb-3444 | held | 3 | ok | fail | fail | fail | evidence quote for thresholds is not in the source: ""Frontier model" means an artificial intelligence model that: (1) is trained usi" |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 434496 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | held | 3 | ok | fail (missing 90, 100) | fail (missing 100, 12) | fail | evidence quote for mechanism is not in the source: "Requires large developers to implement safety and security protocols" |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | held | 1 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | scope disagreement: generator out, reader in |
| nj-s-1802 | held | 1 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| nj-s-4446-a-5275 | held | 3 | ok | fail | fail (missing 10, 26, 100, 25) | fail | stray code or JSON syntax in thresholds |
| ny-raise-act-ch-699-ch-96 | held | 3 | ok | fail (missing 44, 1420, 1421, 24, 1422, 50, 1425) | fail (missing 10, 26, 1420, 50, 1423) | fail (missing 1421) | evidence quote for mechanism is not in the source: "Before deploying a frontier model, the large developer of such frontier model sh" |
| ny-s-10373-verification | held | 3 | ok | fail (missing 1425) | fail | fail | evidence quote for mechanism is not in the source: "A large frontier developer shall annually retain, contract, or otherwise engage " |
| ny-s-10456-minimum-standards | held | 3 | ok | fail (missing 1430) | fail | fail | evidence quote for events_add[0] is not in the source: "The office shall adopt regulations no later than July first, two thousand twenty" |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | held | 3 | ok | fail | fail | fail | evidence quote for mechanism is not in the source: "create an independent verification organization license for verifying artificial" |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 500000000, 50, 1000000000) | fail | thresholds is too long (999 characters) |
| ri-s-358-h-5224 | held | 1 | ok | fail | fail (missing 10, 26, 25) | fail | scope disagreement: generator out, reader in |
| s-1792-h-r-3460-ai-whistleblower-protection-act | published | 3 | ok | pass | pass | pass |  |
| s-2938-ai-risk-evaluation-act | held | 3 | ok | fail | fail (missing 10, 26) | fail | no evidence quote for mechanism |
| s-4656-military-ai-act | published | 2 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 2 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | held | 3 | ok | fail | fail | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | held | 3 | ok | fail (missing 30, 24, 20, 10) | fail (missing 10, 25) | fail | your answer was unusable: the model stopped early: MAX_TOKENS. It was far too long. Keep every field to one to three short sentences and do  |
| s-5541-cyber-and-ai-board-of-investigations | held | 3 | ok | fail | fail | fail | scope disagreement: generator out, reader in |
| texas-traiga-hb-149 | error | 0 | ok | fail | fail | fail | LLM budget reached: 60000 tokens for item texas-traiga-hb-149 |
| va-ch-425-426-jcots-study | published | 2 | ok | pass | pass | pass |  |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
