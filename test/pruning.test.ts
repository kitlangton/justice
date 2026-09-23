import { expect, it } from "vitest";
import { defaults, prepare, solve, withHyphenation, withOpticalMargins, type Options, type Prepared } from "../src/engine";

type Edges = (text: string, word: number) => { start: number; end: number };

// Enumerate every partition independently of the DP and its fragment matrices.
// Candidate advances are measured directly from the displayed source slices.
function exhaustive(p: Prepared, width: readonly number[], measure: (text: string) => number, o: Options, edges?: Edges, emergency = false): number {
  const nodes = [{ word: 0, offset: 0, generated: false }];
  p.words.forEach((word, index) => {
    const parts = p.hyphenation?.[index];
    parts?.offsets.slice(1, -1).forEach((offset, part) => nodes.push({ word: index, offset, generated: !parts.explicit?.[part + 1] }));
    nodes.push({ word: index + 1, offset: 0, generated: false });
  });
  let best = Infinity;
  function visit(start: number, total: number, lineIndex: number, previousFitness: number) {
    if (start === nodes.length - 1) { best = Math.min(best, total); return; }
    for (let end = start + 1; end < nodes.length; end++) {
      const a = nodes[start], b = nodes[end], lastWord = b.offset ? b.word : b.word - 1;
      const pieces = p.words.slice(a.word, lastWord + 1);
      if (b.offset) pieces[pieces.length - 1] = pieces.at(-1)!.slice(0, b.offset);
      if (a.offset) pieces[0] = pieces[0].slice(a.offset);
      if (b.generated) pieces[pieces.length - 1] += "-";
      const last = end === nodes.length - 1, gaps = pieces.length - 1, chars = pieces.join(" ").length;
      const natural = pieces.reduce((sum, text) => sum + measure(text), 0) + gaps * p.space;
      const opening = edges ? edges(p.words[a.word].slice(a.offset), a.word).start * o.protrusion : 0;
      const hanging = edges ? edges(b.offset ? "-" : p.words[lastWord], lastWord).end * o.protrusion : 0;
      const targetWidth = width[Math.min(lineIndex, width.length - 1)], target = targetWidth + opening + hanging;
      const delta = last && natural <= target ? 0 : target - natural;
      const capacity = gaps * p.space * (delta < 0 ? o.shrink : o.stretch) + chars * o.tracking;
      const ratio = capacity ? Math.min(1, Math.abs(delta) / capacity) : 0;
      const signed = capacity ? delta / capacity : delta === 0 ? 0 : Math.sign(delta) * Infinity;
      const fitness = signed < -.5 ? 0 : signed <= .5 ? 1 : signed <= 1 ? 2 : 3;
      let residual = delta - Math.sign(delta) * ratio * capacity;
      let strain = o.mode === "balanced"
        ? 100 * (ratio + Math.abs(residual) / Math.max(capacity, gaps * p.space, p.space)) ** 3 : ratio ** 3 * 100;
      if (emergency && delta > 0) {
        const extra = Math.min(targetWidth * o.emergencyStretch, gaps * p.space);
        strain = 100 * (delta / Math.max(p.space, capacity + extra)) ** 3;
      }
      if (o.mode === "balanced" && gaps) {
        const spacing = Math.sign(delta) * ratio * p.space * (delta < 0 ? o.shrink : o.stretch);
        residual -= (Math.max(-p.space * o.shrink, spacing + residual / gaps) - spacing) * gaps;
      }
      if (o.mode === "balanced" && o.emergencyStretch > 0 && !emergency && (delta > capacity * Math.cbrt(2) + .01 || Math.abs(residual) > .01)) continue;
      let cost = 1 + strain * (delta < 0 ? o.compressionPenalty : 1);
      if (Math.abs(residual) > .01) cost += o.mode === "balanced" && residual < 0 ? 1e6 + residual ** 2 * 1e4 : 1e4 + residual ** 2 * 100;
      if (last && start) {
        const missing = Math.max(0, o.lastLine * targetWidth - natural);
        cost += o.ending === "soft" ? o.widowPenalty * (missing / targetWidth) ** 2
          : o.widowPenalty / 300 * Math.min(10000, 100 * (missing / Math.max(p.space, gaps * p.space * o.stretch + chars * o.tracking)) ** 3);
      }
      cost += b.generated ? o.hyphenPenalty + (a.generated ? o.consecutiveHyphenPenalty : 0)
        : b.offset ? o.explicitHyphenPenalty : last && a.generated ? o.finalHyphenPenalty : 0;
      if (start && Math.abs(previousFitness - fitness) > 1) cost += o.adjacentPenalty;
      visit(end, total + cost, lineIndex + 1, fitness);
    }
  }
  visit(0, 0, 0, 1);
  return best === Infinity && !emergency ? exhaustive(p, width, measure, o, edges, true) : best;
}

it("keeps the exhaustive optimum with arbitrary fragment shaping, optical credits, and per-line widths", () => {
  let seed = 971;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let sample = 0; sample < 180; sample++) {
    const widths = new Map<string, number>(), optical = new Map<string, { start: number; end: number }>();
    const measure = (text: string) => {
      if (text === " ") return 4;
      if (!widths.has(text)) widths.set(text, sample % 3 ? text.length * 8 - random() * 3 : random() * 100);
      return widths.get(text)!;
    };
    const edges: Edges | undefined = sample % 3 ? undefined : (text, word) => {
      const key = `${word}:${text}`;
      if (!optical.has(key)) optical.set(key, { start: random() * 70, end: random() * 20 });
      return optical.get(key)!;
    };
    const text = sample % 5 ? "abcdef ghijkl mnopqr" : "ab-cde fg-hij";
    let p = withHyphenation(prepare(text, measure), word => [word.slice(0, 2), word.slice(2)], measure);
    if (edges) p = withOpticalMargins(p, edges);
    const width = 15 + random() * 170, measures = sample % 2 ? [width] : [width * .7, width * 1.2, width];
    const options: Options = { ...defaults, mode: sample % 2 ? "balanced" : "strict", ending: sample % 4 ? "fit" : "soft",
      tracking: sample % 7 ? random() : random() * 20, shrink: random(), adjacentPenalty: sample % 4 ? random() * 100 : 0,
      emergencyStretch: sample % 6 ? .15 : 0, protrusion: random() };
    expect(solve(p, measures, options).cost, `sample ${sample}`).toBeCloseTo(exhaustive(p, measures, measure, options, edges), 5);
  }
});

it("avoids quadratic candidate growth when complete preceding words guarantee overflow", () => {
  const measure = (text: string) => text === " " ? 4 : text.length * 8;
  const p = withHyphenation(prepare(Array(160).fill("abcdefgh").join(" "), measure), () => ["abcd", "efgh"], measure);
  const result = solve(p, 140, { tracking: 0 });
  expect(result.lines.length).toBeGreaterThan(1);
  expect(result.candidates).toBeLessThan(320 * 12);
});

it("falls back to full search when a suffix or gap can shrink below zero", () => {
  const measure = (text: string) => text === " " ? 4 : text === "efgh" ? 1 : text.length * 8;
  const p = withHyphenation(prepare("abcdefgh abcdefgh abcdefgh", measure), () => ["abcd", "efgh"], measure);
  // Every complete word remains positive at maximum tracking, but one measured
  // continuation does not. Strict mode reaches every node, so all 21 pairs run.
  expect(solve(p, 40, { mode: "strict", tracking: 2 }).candidates).toBe(21);
  const ordinary = withHyphenation(prepare("abcdefgh abcdefgh abcdefgh", text => text.length * 8), () => ["abcd", "efgh"], text => text.length * 8);
  expect(solve(ordinary, 40, { mode: "strict", tracking: 1, shrink: 1 }).candidates).toBe(21);
});

it("keeps ASCII and Unicode preparation counts equal to grapheme segmentation", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const p = withHyphenation(prepare("ABC09-xyz_:\u0000\u000b\u007f fiancée ábcde 👩‍💻x 漢字 10\u00a0km a\r\nb", text => text.length * 8), word => {
    const units = [...segmenter.segment(word)].map(part => part.segment);
    return units.length > 2 ? [units.slice(0, 2).join(""), units.slice(2).join("")] : [word];
  }, text => text.length * 8);
  p.words.forEach((word, index) => {
    expect(p.characters[index + 1] - p.characters[index]).toBe([...segmenter.segment(word)].length);
    const parts = p.hyphenation?.[index];
    if (!parts) return;
    const n = parts.offsets.length;
    for (let from = 0; from < n - 1; from++) for (let to = from + 1; to < n; to++) {
      expect(parts.characters[from * n + to]).toBe([...segmenter.segment(word.slice(parts.offsets[from], parts.offsets[to]))].length);
    }
  });
});

it.each([
  { name: "whole words", lengths: [6, 2, 16, 19, 11, 17, 7, 14, 8, 9], widths: [58, 100, 6], hyphenate: false, optimum: 6763008 },
  { name: "hyphenated words", lengths: [6, 2, 17, 18, 12, 10, 16, 11], widths: [108, 112, 41, 40], hyphenate: true, optimum: 2482208 },
])("retains different line-index states when pruning $name", ({ lengths, widths, hyphenate, optimum }) => {
  const measure = (text: string) => text === " " ? 4 : text.length * 8;
  let p = prepare(lengths.map(length => "a".repeat(length)).join(" "), measure);
  if (hyphenate) p = withHyphenation(p, word => word.length > 2 ? [word.slice(0, 1), word.slice(1)] : [word], measure);
  const options: Options = { ...defaults, mode: "strict", tracking: 0, shrink: .5, adjacentPenalty: 0 };
  // An initially expensive path can preserve a wider measure for a later word.
  // A cheaper tight path with a different line count must not prune that state.
  const expected = exhaustive(p, widths, measure, options);
  expect(expected).toBe(optimum);
  expect(solve(p, widths, options).cost).toBe(expected);
});
