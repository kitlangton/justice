/** American English hyphenation for `withHyphenation`: Liang's algorithm with
 * TeX's patterns (hyph-utf8's hyph-en-us, about 17 KB gzipped), kept out of the core. */
import { exceptions, patterns } from "./english-patterns.js";

export interface EnglishOptions {
  /** Shortest letter run to hyphenate. */
  minWord?: number;
  /** Fewest letters before the first break and after the last (TeX: 2 and 3). */
  left?: number;
  right?: number;
}

let table: Map<string, number[]> | undefined;
let known: Map<string, number[]> | undefined;

/** Odd-valued break points within a lowercase ASCII word: an offset k breaks before letter k. */
function points(word: string): number[] {
  if (!table) {
    table = new Map(patterns.split(" ").map(pattern => {
      const values = [0];
      for (const c of pattern) c >= "0" && c <= "9" ? values[values.length - 1] = +c : values.push(0);
      return [pattern.replace(/\d/g, ""), values];
    }));
    known = new Map(exceptions.split(" ").map(entry => {
      const offsets: number[] = [];
      entry.split("-").reduce((at, part) => (offsets.push(at + part.length), at + part.length), 0);
      return [entry.replace(/-/g, ""), offsets.slice(0, -1)];
    }));
  }
  const exception = known!.get(word);
  if (exception) return exception;
  const dotted = `.${word}.`, values = new Array<number>(dotted.length + 1).fill(0);
  for (let i = 0; i < dotted.length; i++) for (let j = i + 1; j <= dotted.length; j++) {
    table.get(dotted.slice(i, j))?.forEach((value, k) => values[i + k] = Math.max(values[i + k], value));
  }
  return word.split("").map((_, k) => k).filter(k => k > 0 && values[k + 1] % 2);
}

/** A hyphenate callback for `withHyphenation`. Leading and trailing punctuation
 * stay on the edge fragments; each run of plain ASCII letters between source
 * hyphens or apostrophes is hyphenated on its own. Words with digits, symbols,
 * inner capitals (code, acronyms, URLs) or other scripts stay whole. */
export function hyphenator({ minWord = 5, left = 2, right = 3 }: EnglishOptions = {}): (word: string) => string[] {
  return word => {
    const core = word.match(/^([\p{Ps}\p{Pi}"']*)(\p{L}[\p{L}'’\-‐]*?)(\p{P}*)$/u);
    if (!core) return [word];
    const breaks: number[] = [];
    for (const run of core[2].matchAll(/[^'’\-‐]+/g)) {
      const offset = core[1].length + run.index;
      if (/\p{L}[-‐]$/u.test(word.slice(0, offset))) breaks.push(offset);
      if (!/^[A-Za-z][a-z]*$/.test(run[0]) || run[0].length < minWord) continue;
      for (const k of points(run[0].toLowerCase())) if (k >= left && k <= run[0].length - right) breaks.push(offset + k);
    }
    return [0, ...breaks].map((from, i) => word.slice(from, breaks[i] ?? word.length));
  };
}

/** TeX's defaults for English: words of five letters or more, two letters before a break and three after. */
export const hyphenate = hyphenator();
