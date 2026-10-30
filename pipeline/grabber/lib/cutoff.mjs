// The data cutoff, written once in config/publish.json (data_cutoff.date) and shared by every grabber.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'publish.json');
const date = ((JSON.parse(fs.readFileSync(file, 'utf8')).data_cutoff) || {}).date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error(`config/publish.json: data_cutoff.date missing or not YYYY-MM-DD`);
export const CUTOFF_DATE = date; // YYYY-MM-DD
export const CUTOFF_ISO = date + 'T00:00:00Z';
