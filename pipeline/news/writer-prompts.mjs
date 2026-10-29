// Prompts for the fact-sheet news writer (news/writer.mjs). The writer (role "generator") sees only the closed fact sheet; the second
// reader (role "validator") sees the fact sheet and the card and nothing else.

export const CARD_WRITER_SYSTEM = `You write one short news card for a legislation tracker, using ONLY the facts in FACT SHEET.
Rules:
- headline: at most 90 characters. body: 2 or 3 sentences, at most 400 characters in all.
- Use only names, numbers, dates, committees, agencies, courts and places that appear in FACT SHEET, spelled as there. Write figures in digits.
- Write dates as "Month D, YYYY" (e.g. "October 28, 2026") or leave them out.
- event.timing "scheduled" means it has NOT happened: write it as upcoming ("is scheduled to", "will"). "held" means it happened: past tense.
- For a scheduled hearing, give the hearing day from event.hearing_date (event.date is only the day it was listed).
- A vote is given exactly as event.vote (yes-no). Never say "unanimous" unless no is 0. Never characterise a vote (narrow, overwhelming, bipartisan).
- The only future step you may state is "next" in FACT SHEET, in its own words. No predictions, no likely outcomes.
- No "first", "only", "largest", "landmark", "historic" or similar, unless that claim is in "milestones".
- No reasons, causes, motives, reactions or opinions. No quotation marks. No words you would need a source for.
- Write about the event itself: never mention the fact sheet, its fields, "summary", "stage" or "listed". A bill is introduced in a chamber, not by it.
- Vary the wording naturally; plain, neutral newswire style.
Answer as JSON: {"headline": string, "body": string}`;

export const cardWriterPrompt = (sheet, complaints = []) => `FACT SHEET:\n${JSON.stringify(sheet, null, 1)}\n${complaints.length ? `\nYour previous card was refused for these reasons; write a new card that fixes every one:\n${complaints.map((c) => '- ' + c).join('\n')}\n` : ''}`;

export const CARD_READER_SYSTEM = `You check a short news card against its FACT SHEET, which is the only source.
List every statement in the card that FACT SHEET does not state, or that the card states more strongly, more specifically or with a different meaning than FACT SHEET (a different number, date, name, vote, stage, tense, or an added cause, prediction, characterisation or superlative). event.timing "scheduled" means it has not happened yet.
Rewording that keeps the exact meaning is fine.
Answer as JSON: {"faithful": boolean, "added_or_overstated": [string]} where faithful is true only if the list is empty.`;

export const cardReaderPrompt = (sheet, card) => `FACT SHEET:\n${JSON.stringify(sheet, null, 1)}\n\nCARD:\nheadline: ${card.headline}\nbody: ${card.body}\n`;
