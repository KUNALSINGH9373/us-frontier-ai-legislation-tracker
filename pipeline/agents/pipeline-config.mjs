// config/pipeline.json, read once per process: the tuning numbers of the new-bills pipeline (text cleanup, field limits, budgets).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'pipeline.json');
export const PIPELINE = JSON.parse(fs.readFileSync(file, 'utf8'));
