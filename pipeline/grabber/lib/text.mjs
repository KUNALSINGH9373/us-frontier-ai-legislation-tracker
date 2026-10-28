// Turns the HTML that official sites wrap around a document's text into the words a reader sees, so quotes can be
// checked against exactly that.
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<sup[^>]*>\s*(\d{1,3})\s*<\/sup>/gi, '^$1') // 10<sup>26</sup> is 10^26, not 1026
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bill text as some legislatures publish it carries the printed line numbers inside the words: Illinois runs them inline
// ("with respect to 8which the person"), New York at the start of each line ("15 gence technology"). A quote copied
// from the bill then never matches. A number is removed only when it continues the count (the last one + 1, or a
// new page starting at 1 or 2), and only when the document is mostly numbered that way, so the bill's own numbers
// (sections, amounts, "(1)") stay. Then words split across a line break ("intelli-\ngence") are rejoined.
// Massachusetts numbers every line of a bill continuously ("3219 “Catastrophic risk”, ..."), up to five digits, at the start of
// the line. Taken off only when most numbered lines follow the one before, so a list of amounts or years is never touched.
function stripContinuousNumbering(t) {
  const lines = t.split('\n'), nums = lines.map((l) => { const m = /^(\d{1,5}) \S/.exec(l); return m ? +m[1] : null; });
  const numbered = nums.filter((n) => n !== null);
  if (numbered.length < 40) return t;
  let steps = 0;
  for (let i = 1; i < numbered.length; i++) if (numbered[i] === numbered[i - 1] + 1) steps++;
  if (steps < numbered.length * 0.8) return t;
  return lines.map((l, i) => (nums[i] !== null ? l.replace(/^\d{1,5} /, '') : l)).join('\n');
}

export function stripLineNumbering(text) {
  const t = stripContinuousNumbering(String(text || ''));
  const re = /(?<![\d(,$§^\-\/])(?<!\d\.)(\d{1,2})(?![\d,.:%)\-\/]|\s*(?:st|nd|rd|th)\b)/g;
  const cut = [];
  let last = 0, m;
  while ((m = re.exec(t))) {
    const n = +m[1];
    // glued to the next word ("24foundation") is always a line number: take it and pick the count up from there
    const glued = /[a-z]/.test(t[m.index + m[1].length] || '') && /[\s.;:"”]/.test(t[m.index - 1] || ' ');
    if (glued || n === last + 1 || n === last + 2 || (n <= 2 && last >= 10)) { cut.push([m.index, m[1].length]); last = n; }
  }
  const words = (t.match(/\S+/g) || []).length;
  if (cut.length < 40 || cut.length < words / 40) return t; // not a numbered print
  let out = '', at = 0;
  for (const [i, len] of cut) { out += t.slice(at, i); at = i + len; }
  out += t.slice(at);
  return out.replace(/([a-z])-[ \t]*\r?\n[ \t]*([a-z])/g, '$1$2').replace(/[ \t]+/g, ' ').replace(/ *\r?\n */g, '\n');
}
