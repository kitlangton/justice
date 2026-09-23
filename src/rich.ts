import type { Line, Prepared, WordFragments } from "./engine.js";

/** Opaque marks can describe links, nested tags, fonts, or framework props.
 * Reuse mark identities to share measurements. Text is never parsed as HTML. */
export interface RichRun<T> {
  text: string;
  marks: T;
  /** Only generated display hyphens have this flag; exclude them from copying. */
  generated?: boolean;
}

export interface RichPrepared<T> extends Prepared {
  wordRuns: RichRun<T>[][];
  spaceRuns: RichRun<T>[];
}

export interface RichOptions {
  /** One positive, uniform interword advance, rendered as an explicit gap. */
  space: number;
  hyphenate?: (word: string, index: number) => readonly string[];
}

export interface RichPiece<T> {
  kind: "word" | "space";
  runs: RichRun<T>[];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function append<T>(runs: RichRun<T>[], text: string, marks: T) {
  const last = runs.at(-1);
  if (last && last.marks === marks) last.text += text;
  else runs.push({ text, marks });
}

/** Slice by source offsets, never by searching for fragment text: repeated
 * syllables may have different marks. Keep a generated hyphen distinguishable. */
function slice<T>(runs: readonly RichRun<T>[], start: number, end: number, hyphen = false): RichRun<T>[] {
  const out: RichRun<T>[] = [];
  let at = 0;
  for (const run of runs) {
    const next = at + run.text.length;
    if (next > start && at < end) out.push({ text: run.text.slice(Math.max(0, start - at), end - at), marks: run.marks });
    at = next;
    if (at >= end) break;
  }
  if (hyphen && out.length) out.push({ text: "-", marks: out.at(-1)!.marks, generated: true });
  return out;
}

/** Prepare styled words once; the ordinary solver and static compiler need no
 * changes. Measure a complete piece with the same inline shaping used to render
 * it. Render separators at `space + line.wordSpacing + line.tracking`, regardless
 * of their marks' native space advance. Pass hard-break segments separately. */
export function prepareRich<T>(runs: readonly RichRun<T>[], measure: (runs: readonly RichRun<T>[]) => number,
  options: RichOptions): RichPrepared<T> {
  const { space, hyphenate } = options;
  if (!Number.isFinite(space) || space <= 0) throw new RangeError("Space width must be positive");
  const wordRuns: RichRun<T>[][] = [], spaceRuns: RichRun<T>[] = [];
  let current: RichRun<T>[] = [], pending: RichRun<T> | undefined;
  for (const run of runs) for (const text of run.text.split(/([ \t\r\n\f]+)/)) {
    if (!text) continue;
    if (/^[ \t\r\n\f]/.test(text)) {
      if (current.length) { wordRuns.push(current); current = []; }
      if (wordRuns.length) pending ??= { text: " ", marks: run.marks };
    } else {
      if (pending) { spaceRuns.push(pending); pending = undefined; }
      append(current, text, run.marks);
    }
  }
  if (current.length) wordRuns.push(current);
  const words = wordRuns.map(runs => runs.map(run => run.text).join(""));
  const widths = new Float64Array(words.length + 1), characters = new Float64Array(words.length + 1);
  const endHangs = new Float64Array(words.length), startHangs = new Float64Array(words.length);
  // Length-prefixed keys preserve arbitrary text and mark identity without
  // serializing caller metadata. Caches are released after preparation.
  const identities = new Map<T, number>(), cache = new Map<string, number>();
  const counts = new Map<string, number>();
  const count = (text: string) => {
    // ASCII words cannot contain CRLF (whitespace is already split).
    if (!/[^\x00-\x7f]/.test(text)) return text.length;
    let value = counts.get(text);
    if (value === undefined) {
      value = 0;
      for (const _ of graphemes.segment(text)) value++;
      counts.set(text, value);
    }
    return value;
  };
  const widthOf = (runs: readonly RichRun<T>[]) => {
    let key = "";
    for (const run of runs) {
      let id = identities.get(run.marks);
      if (id === undefined) { id = identities.size; identities.set(run.marks, id); }
      key += `${id}:${run.generated ? 1 : 0}:${run.text.length}:${run.text}`;
    }
    let width = cache.get(key);
    if (width === undefined) {
      width = measure(runs);
      if (!Number.isFinite(width) || width < 0) throw new RangeError("Invalid measured rich text width");
      cache.set(key, width);
    }
    return width;
  };
  let hyphenation: (WordFragments | undefined)[] | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i], runs = wordRuns[i], width = widthOf(runs);
    const charactersInWord = count(word);
    widths[i + 1] = widths[i] + width;
    characters[i + 1] = characters[i] + charactersInWord;
    const punctuation = word.match(/[.,;:!?…’”'"]+$/u)?.[0];
    if (punctuation) endHangs[i] = Math.min(width, widthOf(slice(runs, word.length - punctuation.length, word.length)));
    const quote = word.match(/^[“‘"'«‹]/u)?.[0];
    if (quote) startHangs[i] = Math.min(width, widthOf(slice(runs, 0, quote.length)));
    if (word.includes("\u00a0")) continue;
    // Most words have no break candidates; avoid allocating their offset sets.
    if (!hyphenate && !/[-\u2010]/.test(word)) continue;
    const explicitAt = new Set([...word.matchAll(/(?<=[\p{L}\p{N}])[-\u2010](?=[\p{L}\p{N}])/gu)].map(m => m.index + 1));
    const offsets = new Set([0, ...explicitAt, word.length]);
    if (hyphenate) {
      const parts = hyphenate(word, i);
      if (!parts.length || parts.some(part => !part.length) || parts.join("") !== word) throw new RangeError("Hyphenation must partition the source word");
      const legal = charactersInWord === word.length ? undefined : new Set([...graphemes.segment(word)].map(part => part.index));
      let offset = 0;
      for (const part of parts.slice(0, -1)) {
        offset += part.length;
        if (legal && !legal.has(offset)) throw new RangeError("Hyphenation must not split a grapheme");
        offsets.add(offset);
      }
    }
    if (offsets.size === 2) continue;
    const sorted = [...offsets].sort((a, b) => a - b), n = sorted.length;
    const measured = new Float64Array(n * n), hyphens = new Float64Array(n * n), chars = new Float64Array(n * n);
    const explicit = sorted.map(offset => explicitAt.has(offset));
    for (let from = 0; from < n - 1; from++) for (let to = from + 1; to < n; to++) {
      const start = sorted[from], end = sorted[to], cell = from * n + to;
      measured[cell] = from === 0 && to === n - 1 ? width : widthOf(slice(runs, start, end));
      if (to < n - 1) hyphens[cell] = explicit[to] ? measured[cell] : widthOf(slice(runs, start, end, true));
      chars[cell] = charactersInWord === word.length ? end - start : count(word.slice(start, end));
    }
    hyphenation ??= new Array(words.length);
    hyphenation[i] = { offsets: sorted, widths: measured, hyphenWidths: hyphens, characters: chars, explicit: explicit.some(Boolean) ? explicit : undefined };
  }
  const p: RichPrepared<T> = { words, widths, characters, endHangs, startHangs, space, wordRuns, spaceRuns };
  if (hyphenation) p.hyphenation = hyphenation;
  return p;
}

/** Return only the selected source slices, retaining mark identities. Each word
 * must be shaped as a unit, with its runs inline. Space pieces are explicit gaps.
 * This does no measurement and scans only words included in the requested line. */
export function lineRuns<T>(p: RichPrepared<T>, line: Line): RichPiece<T>[] {
  const pieces: RichPiece<T>[] = [];
  for (let i = line.start; i < line.end; i++) {
    if (i > line.start) pieces.push({ kind: "space", runs: [{ ...p.spaceRuns[i - 1] }] });
    pieces.push({ kind: "word", runs: slice(p.wordRuns[i], i === line.start ? line.startOffset ?? 0 : 0,
      i === line.end - 1 ? line.endOffset ?? p.words[i].length : p.words[i].length,
      i === line.end - 1 && line.hyphenated) });
  }
  return pieces;
}
