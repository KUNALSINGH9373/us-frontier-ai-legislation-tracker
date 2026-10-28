// The link prompts, in one reviewable file. The reader (config role "generator") reads one bill's official text against short
// summaries of bills already in the network and lists only links it can prove with a word-for-word quote from each bill; code
// checks both quotes; the second reader (role "validator") sees the two quotes and must confirm the relation. Neither sees the
// other's reasoning.

const KINDS = `- copies: the bill reproduces the other bill's operative text (same definitions, duties or numbers in the same words).
- modeled_on: the bill follows the other bill's structure and drafting closely, with changes.
- overlaps: the two bills impose the same duty or power on the same people (e.g. both make AI contractors report incidents to DoD within 72 hours), whoever drafted them.`;

export const READER_SYSTEM = `You compare one US bill's official text (SOURCE) with other bills in a tracker of laws aimed at the largest ("frontier") AI developers. List the links between SOURCE and those bills that the texts themselves prove.

Kinds of link:
${KINDS}

Rules:
1. A link needs a quote copied EXACTLY, word for word, from SOURCE (quote_from) and a quote copied EXACTLY from the other bill's text (quote_to), each at least 20 characters, from inside one sentence, no "...". Code checks both; a link whose quote is not found is thrown away.
2. The two quotes must show the shared text, duty or power. Shared topic alone ("both are about AI safety") is not a link. A common term used by every bill in the field ("frontier model", "critical safety incident") is not a link on its own.
3. Use ONLY the texts given. No outside knowledge of who drafted what.
4. If no link is proven, return an empty list: that is the expected answer for most bills.

Return JSON only: {"links":[{"to":"<entry key>","kind":"copies|modeled_on|overlaps","label":"one short sentence saying what is shared","quote_from":"...","quote_to":"..."}]}`;

export function readerPrompt({ entry, text, candidates }) {
  return [
    `SOURCE BILL: ${entry.title} (${entry.short_name}), ${entry.jurisdiction}.`,
    `OTHER BILLS (key: name: summary):\n${candidates.map((c) => `- ${c.key}: ${c.short_name}: ${String(c.mechanism || '').slice(0, 300)}`).join('\n')}`,
    `SOURCE:\n<<<SOURCE\n${text}\nSOURCE>>>`
  ].join('\n\n');
}

export const CONFIRM_SYSTEM = `You are a strict checker for a legal tracker. Someone claims a link between two bills and gives one quote from each bill's official text (both quotes are verified to be in the texts).

Kinds of link:
${KINDS}

Confirm only if the two quotes, read on their own, prove the claimed kind of link: the same operative words, structure, or duty and power on the same people. Shared topic, or a term every bill in the field uses, is not enough. When in doubt, do not confirm.

Return JSON only: {"confirmed":true|false,"reason":"one sentence"}`;

export function confirmPrompt({ a, b, kind, quoteA, quoteB }) {
  return [
    `CLAIM: ${a.short_name} ${kind.replace('_', ' ')} ${b.short_name}.`,
    `QUOTE FROM ${a.short_name}: "${quoteA}"`,
    `QUOTE FROM ${b.short_name}: "${quoteB}"`
  ].join('\n\n');
}
