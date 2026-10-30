// The escalated pass's own token budget for one item. The ledger (llm/gemini.mjs createLedger) caps every item at max_tokens_per_item;
// an item that ran out of it (a 35,000-character bill read for 3 rounds plus its duties) gets ONE more pass with a larger budget,
// escalation.max_tokens_per_item in config/models.json. The extra budget is spent under the item's own sub-keys ("<id>#esc1", "#esc2",
// ...), each under the per-item cap, so the ledger's run-wide limit and the monthly cost cap still apply to every call.
import { BudgetExceeded } from '../llm/gemini.mjs';
import { PIPELINE } from './pipeline-config.mjs';

export function escalationBudget({ ledger, perItem, total }) {
  // move to the next sub-key well before the ledger's own per-item cap would refuse a call (config/pipeline.json escalation)
  const SWITCH = PIPELINE.escalation.switch_fraction, MAX_KEYS = PIPELINE.escalation.max_sub_keys;
  const keys = (id) => { const out = []; for (let k = 1; k < MAX_KEYS; k++) { const key = `${id}#esc${k}`; out.push(key); if (ledger.itemTokens(key) < perItem * SWITCH) break; } return out; };
  const spent = (id) => keys(id).reduce((t, k) => t + ledger.itemTokens(k), 0);
  const keyFor = (id) => {
    if (spent(id) >= total) throw new BudgetExceeded(`${total} tokens for item ${id} (escalated pass)`, 'item');
    const ks = keys(id); return ks[ks.length - 1];
  };
  return {
    spent,
    // The same client, with every call counted under the item's escalation sub-key.
    wrap: (llm) => (llm ? { ...llm, role: llm.role, model: llm.model, generate: (req) => llm.generate({ ...req, itemId: req.itemId ? keyFor(req.itemId) : req.itemId }) } : null)
  };
}
