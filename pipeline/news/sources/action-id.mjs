// A stable id for one action in one bill record: the record, the date and a hash of the official words. news/confirm.mjs matches an
// event to its official record by source_id, so each action needs its own.
import crypto from 'crypto';
export const actionId = (record, date, text) => `${record}#${date}#${crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 8)}`;
