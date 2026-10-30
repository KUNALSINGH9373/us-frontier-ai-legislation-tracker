# Accuracy test set: latest report

Run 2026-10-30 08:26 UTC · provider **anthropic** · generator `claude-sonnet-5-5` · reader `claude-haiku-5-5` · prompts b136495d84f9 · 48 items · 2,899,686 tokens

Outcomes: published 40, out_of_scope 7, held 1. Scope agreement 100%.

Section (D, F or G.3, published federal bills): 89% of 19 (wrong: h-r-9914-s-5105-catsr, s-5471-ai-systems-transparency-act).

| Field | In-scope items | Passed | Pass rate | Published | Unsupported | Fact recall (items with provable facts) |
|---|---|---|---|---|---|---|
| mechanism | 41 | 40 | **98%** | 40 | 0 | 40% (23) |
| thresholds | 41 | 38 | **93%** | 31 | 0 | 89% (16) |
| penalties | 41 | 40 | **98%** | 22 | 0 | 100% (2) |

A field passes when the item was published (every code check and every claim confirmed by the independent reader), nothing in it is unsupported, and every number of the author's field that the official text contains is stated. Fact recall counts only numbers (thresholds, amounts, deadlines): it does not judge the wording of a mechanism.

## Items

| Entry | Outcome | Rounds | Scope | Mechanism | Thresholds | Penalties | Problem |
|---|---|---|---|---|---|---|---|
| ai-overwatch-act-fy27-ndaa | published | 3 | ok | pass | pass | pass |  |
| ca-ab-1405-auditor-registry | published | 1 | ok | pass | pass | pass |  |
| ca-sb-1119-adam-s-law-and-sb-867 | out_of_scope | 1 | ok | fail (missing 10, 1119, 1405) | fail | fail |  |
| ca-sb-53-tfaia | published | 3 | ok | pass | pass | pass |  |
| ca-sb-813-ivos | published | 3 | ok | pass | pass | pass |  |
| chip-security-act-h-r-3447-cotton-companion | published | 3 | ok | pass | pass | pass |  |
| ct-p-a-26-15-ivo-pilot | published | 2 | ok | pass | pass | pass |  |
| ct-p-a-26-15-omnibus | published | 1 | ok | pass | pass | pass |  |
| gain-ai-act-of-2025-s-3150 | published | 2 | ok | pass | pass | pass |  |
| h-r-10180-self-improving-ai-monitoring-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10189-defense-ai-reliability-act | published | 2 | ok | pass | pass | pass |  |
| h-r-10362-stop-rogue-ai-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9363-ai-security-and-innovation-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9477-ai-incident-reporting-act | published | 2 | ok | pass | pass | pass |  |
| h-r-9914-s-5105-catsr | published | 3 | ok | pass | pass | pass |  |
| h-r-9917-ai-kill-switch-act | published | 1 | ok | pass | pass | pass |  |
| h-r-9925-frontier-act | held | 3 | ok | fail (missing 72, 24, 45, 90) | fail (missing 10, 26, 50000000, 1000000000, 36, 5000000000, 10000000000) | fail | claim about mechanism ("A large frontier developer shall write, implement, comply with, and publish a frontier AI framework.") is not suppor |
| h-r-9965-atomic-act | published | 1 | ok | pass | fail (missing 5000000) | pass |  |
| il-hb-3506-2025 | published | 1 | ok | pass | pass | pass |  |
| il-hb-4705-sb-3261 | published | 3 | ok | pass | pass | pass |  |
| il-sb-315-p-a-104-0538 | published | 1 | ok | pass | pass | pass |  |
| il-sb-3312 | published | 1 | ok | pass | pass | pass |  |
| il-sb-3444 | published | 3 | ok | pass | pass | pass |  |
| ma-h-5576-s-3178 | published | 2 | ok | pass | fail (missing 1000000000) | pass |  |
| mi-hb-4668 | published | 1 | ok | pass | pass | pass |  |
| mi-sb-757-760-kids-over-clicks | out_of_scope | 1 | ok | fail | fail | fail |  |
| mn-hf-4532-no-threshold | published | 2 | ok | pass | pass | pass |  |
| nj-s-1802 | out_of_scope | 1 | ok | fail | fail | fail |  |
| nj-s-4446-a-5275 | published | 2 | ok | pass | pass | pass |  |
| ny-raise-act-ch-699-ch-96 | published | 2 | ok | pass | pass | pass |  |
| ny-s-10373-verification | published | 2 | ok | pass | pass | pass |  |
| ny-s-10456-minimum-standards | published | 1 | ok | pass | pass | pass |  |
| ny-s10642-a11560-responsible-data-center-development-act-and | out_of_scope | 1 | ok | fail (missing 14) | fail | fail |  |
| oh-hb-628 | published | 1 | ok | pass | pass | pass |  |
| pa-h-b-2705 | out_of_scope | 1 | ok | fail (missing 16) | fail | fail |  |
| pa-h-b-2800-ai-risk-prevention-act | published | 3 | ok | pass | pass | pass |  |
| ri-s-358-h-5224 | published | 1 | ok | pass | pass | pass |  |
| s-1792-h-r-3460-ai-whistleblower-protection-act | published | 1 | ok | pass | pass | pass |  |
| s-2938-ai-risk-evaluation-act | published | 1 | ok | pass | pass | pass |  |
| s-4656-military-ai-act | published | 3 | ok | pass | pass | pass |  |
| s-5061-secure-ai-development-act | published | 2 | ok | pass | pass | pass |  |
| s-5417-h-r-10567-ai-emergency-button-act | published | 1 | ok | pass | pass | pass |  |
| s-5471-ai-systems-transparency-act | published | 1 | ok | pass | pass | pass |  |
| s-5493-h-r-10538-ban-artificial-superintelligence-act | published | 2 | ok | pass | pass | pass |  |
| s-5541-cyber-and-ai-board-of-investigations | published | 2 | ok | pass | pass | pass |  |
| texas-traiga-hb-149 | out_of_scope | 1 | ok | fail | fail | fail |  |
| va-ch-425-426-jcots-study | published | 1 | ok | pass | pass | pass |  |
| washington-sb-5395 | out_of_scope | 1 | ok | fail | fail | fail |  |
