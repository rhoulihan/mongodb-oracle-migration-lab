// Reflow SQL (and the query line beside it) to a frame's width, so the
// console's "Query and SQL" view reads without sideways scrolling. Only
// whitespace changes, at break points: every token stays, in order.
//   1. A line wider than the frame breaks before its top-level clauses
//      (from, where, group by, order by, having, fetch), at the same indent.
//   2. A line still too wide breaks at the last point that fits: after a
//      comma, or before passing / returning / and / or / keep / on, or before
//      && and || (inside JSON path literals too, where whitespace is free);
//      failing that, at any space outside quotes. Continuation lines get the
//      line's indent plus 4; alignment runs of spaces in such a line close up.
//   3. A quoted token wider than the frame is left whole (CSS wraps it).
// Lines that already fit are left alone. No DOM code: unit tested.

const CLAUSE = /^(from|where|group\s+by|order\s+by|having|fetch)(?![\w$#])/i;
const KEYWORD = /^(passing|returning|and|or|keep|on|when|then|else|join)(?![\w$#])/i;
// "error on error", "null on empty": the on is part of a clause, not a join.
const NOT_JOIN_ON = /(error|null|empty|default|true|false)\s+$/i;
const CONT = 4;
// Either side of the on in "error on error" or "null on empty".
const inOnPhrase = (line, i) => (/^on\b/i.test(line.slice(i)) && NOT_JOIN_ON.test(line.slice(0, i)))
  || /(error|null|empty|default|true|false)\s+on\s+$/i.test(line.slice(0, i))
  // and never a keyword left dangling at a line's end
  || /\b(passing|returning|and|or|keep|on|when|then|else|join)\s+$/i.test(line.slice(0, i));

const indentOf = (line) => line.match(/^ */)[0].length;

/** Quote state and paren depth before each character of one line. */
function scan(line) {
  const quote = [], depth = [];
  let q = null, d = 0;
  for (let i = 0; i < line.length; i++) {
    quote.push(q); depth.push(d);
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === "'" || c === '"') q = c;
    else if (c === '(') d++;
    else if (c === ')') d--;
  }
  return { quote, depth };
}

// Pass 1: break before the line's own top-level clauses.
function clauseBreaks(line) {
  const { quote, depth } = scan(line);
  const ind = indentOf(line);
  const cuts = [];
  for (let i = ind + 1; i < line.length; i++) {
    if (quote[i] || depth[i] !== 0 || !/\s/.test(line[i - 1])) continue;
    if (CLAUSE.test(line.slice(i))) cuts.push(i);
  }
  if (!cuts.length) return [line];
  const pad = ' '.repeat(ind);
  const out = [];
  let start = 0;
  for (const c of cuts) {
    const piece = line.slice(start, c).trim();
    if (piece) out.push(pad + piece);
    start = c;
  }
  out.push(pad + line.slice(start).trim());
  return out;
}

// Pass 2: where a line may break (the index the next line starts at).
// strong: after a comma, before a keyword or && / ||. weak: any space
// outside quotes, for lines with no strong point that fits.
function breakPoints(line) {
  const { quote } = scan(line);
  const strong = [], weak = [];
  for (let i = 1; i < line.length; i++) {
    const prevSpace = line[i - 1] === ' ';
    if (!quote[i] && line[i - 1] === ',' && !quote[i - 1]) strong.push(i);
    else if (prevSpace && !quote[i] && KEYWORD.test(line.slice(i))
      && !(/^on\b/i.test(line.slice(i)) && NOT_JOIN_ON.test(line.slice(0, i)))) strong.push(i);
    else if (prevSpace && quote[i] !== '"' && (line.startsWith('&&', i) || line.startsWith('||', i))) strong.push(i);
    else if (prevSpace && line[i] !== ' ' && !quote[i] && !inOnPhrase(line, i)) weak.push(i);
  }
  return { strong, weak };
}

// Column-alignment runs (2+ spaces after the indent, outside quotes) become
// one space in a line too wide to keep its alignment anyway, and a deep
// alignment indent comes back to a third of the width.
function squeeze(line, width) {
  const { quote } = scan(line);
  const ind = indentOf(line);
  let out = ' '.repeat(Math.min(ind, Math.max(4, Math.floor(width / 3))));
  for (let i = ind; i < line.length; i++) {
    if (line[i] === ' ' && line[i - 1] === ' ' && !quote[i] && i > ind) continue;
    out += line[i];
  }
  return out;
}

function greedy(line, width) {
  if (line.length <= width) return [line];
  line = squeeze(line, width);
  if (line.length <= width) return [line];
  const ind = indentOf(line);
  const ok = (p) => p > ind && line.slice(ind, p).trim();
  const bp = breakPoints(line);
  const strong = bp.strong.filter(ok), any = [...strong, ...bp.weak.filter(ok)].sort((a, b) => a - b);
  if (!any.length) return [line];
  const out = [];
  const cont = ' '.repeat(Math.min(ind + CONT, Math.max(ind, Math.floor(width / 3))));
  let start = 0;
  for (;;) {
    const head = start === 0 ? line.slice(0, ind) : cont;
    const rest = line.slice(start).trim();
    if (head.length + rest.length <= width) { out.push(head + rest); break; }
    const len = (p) => head.length + line.slice(start, p).trim().length;
    const after = (pts) => pts.filter((p) => p > start && line.slice(start, p).trim());
    const s = after(strong).filter((p) => len(p) <= width).pop();
    const w = after(any).filter((p) => len(p) <= width).pop();
    // A strong point unless it leaves the line less than half full.
    const cut = s !== undefined && (w === undefined || len(s) >= width / 2) ? s : w ?? after(any)[0];
    if (cut === undefined) { out.push(head + rest); break; }
    out.push(head + line.slice(start, cut).trim());
    start = cut;
  }
  return out;
}

/**
 * @param {string} text SQL or a query line, any number of lines
 * @param {number} width columns available
 * @returns {string} the same text, reflowed to fit where it can
 */
export function wrapSql(text, width) {
  if (!text || !(width > 0)) return text;
  return text.split('\n').flatMap((line) => {
    if (line.length <= width) return [line];
    return clauseBreaks(line.trimEnd()).flatMap((l) => greedy(l, width));
  }).join('\n');
}
