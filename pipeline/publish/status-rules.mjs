// Status rules shared by Tier A, Tier B and the guards, written once.
//
// EVENT_RANK: the event types (grabber/sources typeOf), most advanced first. Tier B names a new entry's current status by it;
// the two final types settle a bill's status for good.
export const EVENT_RANK = { 'Signed / enacted': 100, 'Vetoed / failed / rescinded': 90, 'Passed / advanced': 80, Effective: 70, 'Referred / stalled / hearing': 40, 'Introduced / published': 30 };
const FINAL = { 'Signed / enacted': 'enacted', 'Vetoed / failed / rescinded': 'failed' };
// Entry statuses a bill can still leave ("stalled" is an authored judgement call, so it may become "pending" again), and the
// final ones it can reach. Every other status (executive, litigation, export, excluded) never moves.
const OPEN = ['pending', 'stalled'];
const FINAL_STATUSES = [...new Set(Object.values(FINAL))];
// A status may only move forward: from an open status to another open one or to a final one; a final status stays.
export const statusMayMove = (from, to) => OPEN.includes(from) && from !== to && [...OPEN, ...FINAL_STATUSES].includes(to);
// A failed bill may still become law, but only on a record that says so: a veto overridden (override / overrode / overridden),
// or the bill became (public) law. Read clause by clause (split at ; and sentence ends): a clause about an override that
// failed or a veto sustained does not count, and does not cancel another clause ("Veto overridden; motion to reconsider failed").
const OVERRIDE_YES = /\bover (?:the )?(?:\w+'s )?veto\b|\bveto(?:es)? (?:was |is |were )?overr(?:id|od)\w*|\boverr(?:id|od)\w* (?:of )?(?:the )?(?:\w+'s )?vetoe?s?\b|\boverr(?:idden|ode)\b|\bbecame (?:public )?law\b/i;
const OVERRIDE_NO = /\bfail\w*\b|\bsustain\w*\b|\bnot (?:be )?overr\w*|\bunsuccessful\b/i;
const clauses = (q) => String(q || '').split(/;|\.\s+(?=[A-Z])/);
export const saysOverride = (quote) => clauses(quote).some((c) => OVERRIDE_YES.test(c) && !OVERRIDE_NO.test(c));
