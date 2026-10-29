# Accuracy test set: latest report

Run 2026-10-29 06:23 UTC · provider **anthropic** · generator `claude-haiku-5-5` · reader `claude-haiku-5-5` · prompts d8ff84f3e483 · 48 items · 2,865,247 tokens

Outcomes: published 32, too_long 3, held 8, out_of_scope 5. Scope agreement 96% (wrong: ca-sb-1119-adam-s-law-and-sb-867, nj-s-1802).

Section (D, F or G.3, published federal bills): 89% of 18 (wrong: h-r-9914-s-5105-catsr, s-5471-ai-systems-transparency-act).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 30 | **73%** | 30 | 0 | 25% (22) |
| thresholds | 41 | 25 | **61%** | 26 | 0 | 52% (16) |
| penalties | 41 | 30 | **73%** | 16 | 0 | 0% (1) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | published | 3 | ok | pass | pass | pass |  |
| ca-ab-1405-auditor-registry | published | 2 | ok | pass | pass | pass |  |
| ca-sb-1119-adam-s-law-and-sb-867 | published | 2 | **wrong** | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 1 | ok | pass | fail (missing 50) | pass |  |
| ca-sb-813-ivos | published | 3 | ok | pass | pass | pass |  |
| chip-security-act-h-r-3447-cotton-companion | published | 1 | ok | pass | pass | pass |  |
| ct-p-a-26-15-ivo-pilot | too_long | 0 | ok | fail (missing 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| ct-p-a-26-15-omnibus | too_long | 0 | ok | fail (missing 39, 10, 26, 30) | fail | fail | 137606 characters: needs section-by-section reading (not built yet) |
| gain-ai-act-of-2025-s-3150 | held | 3 | ok | fail | fail | fail | mechanism is too long (740 characters) |
| h-r-10180-self-improving-ai-monitoring-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | published | 1 | ok | pass | pass | pass |  |
| h-r-10362-stop-rogue-ai-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9363-ai-security-and-innovation-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | published | 2 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | published | 3 | ok | pass | pass | pass |  |
| h-r-9925-frontier-act | published | 3 | ok | pass | fail (missing 50) | pass |  |
| h-r-9965-atomic-act | published | 1 | ok | pass | fail (missing 50) | pass |  |
| il-hb-3506-2025 | published | 3 | ok | pass | fail (missing 12) | pass |  |
| il-hb-4705-sb-3261 | published | 2 | ok | pass | fail (missing 25) | pass |  |
| il-sb-315-p-a-104-0538 | held | 3 | ok | fail (missing 90, 30, 72, 24, 50, 11, 21) | fail (missing 10, 26, 50) | fail (missing 1000) | the referee did not confirm the scope with a quote found in the text |
| il-sb-3312 | published | 2 | ok | pass | pass | pass |  |
| il-sb-3444 | held | 3 | ok | fail | fail | fail | mechanism is too long (726 characters) |
| ma-h-5576-s-3178 | too_long | 0 | ok | fail (missing 120) | fail (missing 500, 50) | fail | 630351 characters: needs section-by-section reading (not built yet) |
| mi-hb-4668 | published | 1 | ok | pass | pass | pass |  |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | held | 3 | ok | fail (missing 72) | fail (missing 25, 1000000) | fail | claim about mechanism ("A developer must not deploy an artificial intelligence model if doing so creates an unreasonable ris") is not suppor |
| nj-s-1802 | published | 2 | **wrong** | fail | fail | fail |  |
| nj-s-4446-a-5275 | held | 2 | ok | fail | fail (missing 10, 26, 100, 25) | fail | the referee did not confirm the scope with a quote found in the text |
| ny-raise-act-ch-699-ch-96 | published | 2 | ok | pass | pass | pass |  |
| ny-s-10373-verification | published | 3 | ok | pass | pass | pass |  |
| ny-s-10456-minimum-standards | published | 3 | ok | pass | pass | pass |  |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | held | 3 | ok | fail | fail | fail | mechanism is too long (763 characters) |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | held | 3 | ok | fail (missing 3904, 26, 30, 72, 24, 1000000, 3000000) | fail (missing 10, 26, 500000000, 50, 1000000000) | fail | mechanism is too long (754 characters) |
| ri-s-358-h-5224 | published | 1 | ok | pass | pass | pass |  |
| s-1792-h-r-3460-ai-whistleblower-protection-act | published | 1 | ok | pass | pass | pass |  |
| s-2938-ai-risk-evaluation-act | held | 2 | ok | fail | fail (missing 10, 26) | fail | the referee did not confirm the scope with a quote found in the text |
| s-4656-military-ai-act | published | 1 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 2 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | published | 2 | ok | pass | pass | pass |  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | published | 2 | ok | pass | pass | pass |  |
| s-5541-cyber-and-ai-board-of-investigations | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | published | 3 | ok | pass | pass | pass |  |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
