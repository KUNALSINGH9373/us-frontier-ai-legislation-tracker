// The news lane's word lists, from config/news-lexicon.json, each compiled once at load. Code only, no AI.
import fs from 'fs';

const LEX = JSON.parse(fs.readFileSync(new URL('../config/news-lexicon.json', import.meta.url), 'utf8'));
const words = (list, flags) => new RegExp(`\\b(${list.join('|')})\\b`, flags);

// news/writer.mjs: refused unless the fact sheet itself uses them (evaluative, causal, predictive); superlatives need a milestone fact
export const SUPERLATIVE = words(LEX.writer.superlative, 'gi');
export const EVALUATIVE = words(LEX.writer.evaluative, 'gi');
export const CAUSAL = words(LEX.writer.causal, 'gi');
export const PREDICTIVE = words(LEX.writer.predictive, 'gi');
export const COLOUR = words(LEX.writer.colour, 'gi');
// titles before a person's name: the word after one must be in the sheet (case does not matter)
export const TITLE_NAME = new RegExp(`\\b(?:${LEX.writer.title_name.titles.join('|')})\\s+([a-z][a-z'’-]{2,})`, 'gi');
export const AFTER_TITLE_OK = new RegExp(`^(?:${LEX.writer.after_title_ok.words.join('|')})$`, 'i');
export const COMMON = new Set(LEX.writer.common.words);

// news/attach.mjs: headline keywords and the classes each is compatible with; headlines that are not a report of the event
export const KEYWORDS = LEX.attach.keywords.map((k) => [new RegExp(k.pattern, 'i'), k.classes]);
export const NOT_A_REPORT = new RegExp(LEX.attach.not_a_report.pattern, 'i');
// a chamber word followed by a capitalized word not in this list names one of its committees ("passes House Judiciary")
export const CHAMBER_COMMITTEE = new RegExp(`\\b(Senate|House|Assembly)\\s+(?!(${LEX.attach.chamber_next_ok.words.join('|')})\\b)[A-Z][a-z]`);

// news/strict.mjs: words a roll-call line may hold
export const VOTE_WORDS = new Set(LEX.strict.vote_words.words);
