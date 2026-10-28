// The month's AI spend, saved to disk after every call (state/ledger/<YYYY-MM>.jsonl, one line per call).
// The grabber and the agents run as separate processes, so a per-process total would be lost; the run report and the monthly cap
// both read this file. Plain code, no AI.
import fs from 'fs';
import path from 'path';

// What each model role is called in reports.
export const STEP_LABEL = { screener: 'title screen', scope_checker: 'scope check', generator: 'writer', validator: 'checker', referee: 'scope referee', reviewer: 'self-check reader', confirmer: 'self-check confirmer', smoke: 'smoke test' };
export const stepOf = (role) => STEP_LABEL[role] || role;

export const monthOf = (d) => new Date(d).toISOString().slice(0, 7);
const round = (n) => Math.round(n * 1e6) / 1e6;

// Totals over a list of call records: overall, by step and by model. A call whose model had no price counts as `unpriced_calls`.
export function summarize(records) {
  const t = { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0, by_step: {}, by_model: {} };
  const add = (o, k, r) => { const x = (o[k] = o[k] || { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 }); x.calls++; x.input_tokens += r.input; x.output_tokens += r.output; x.cost_usd += r.cost || 0; };
  for (const r of records) {
    t.calls++; t.input_tokens += r.input; t.output_tokens += r.output; t.cost_usd += r.cost || 0;
    if (r.cost == null) t.unpriced_calls++;
    add(t.by_step, stepOf(r.role), r); add(t.by_model, r.model, r);
  }
  t.cost_usd = round(t.cost_usd);
  for (const o of [t.by_step, t.by_model]) for (const x of Object.values(o)) x.cost_usd = round(x.cost_usd);
  return t;
}

export function createSpend({ dir, now = () => new Date() }) {
  const file = (month) => path.join(dir, month + '.jsonl');
  const read = (month = monthOf(now())) => {
    const f = file(month);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  };
  return {
    file,
    read,
    // One line per call, written immediately so a crash loses nothing.
    append(rec) {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file(monthOf(now())), JSON.stringify({ at: now().toISOString(), ...rec }) + '\n');
    },
    monthTotal: (month) => round(read(month).reduce((s, r) => s + (r.cost || 0), 0)),
    // The calls made in [from, to] (ISO strings or dates): what one run spent.
    between(from, to = now()) {
      const a = +new Date(from), b = +new Date(to);
      return read(monthOf(from)).filter((r) => +new Date(r.at) >= a && +new Date(r.at) <= b);
    },
    // Where the month stands against the cap: { spent, cap, warn, over }. No cap configured means never over.
    status({ cap = null, warnFraction = 0.8 } = {}) {
      const spent = this.monthTotal();
      return { month: monthOf(now()), spent, cap, warn: !!cap && spent >= cap * warnFraction, over: !!cap && spent >= cap };
    }
  };
}
