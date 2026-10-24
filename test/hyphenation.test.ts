import { describe, expect, it } from "vitest";
import { defaults, lineText, prepare, solve, withHyphenation, withOpticalMargins, type Options } from "../src/engine";

// Deliberately non-additive shaping: measuring the hyphen separately is wrong.
const measure = (s: string) => [...s].reduce((n, c) => n + (c === " " ? 4 : 8), 0) - (s.match(/a-/g)?.length ?? 0) * 2;
const split = (word: string) => word.match(/.{1,3}/gu)!;
type Optical = (text: string, index: number) => { start: number; end: number };

// Enumerate partitions over source offsets, independently of the engine's word
// matrices and dynamic-programming nodes. Measure each displayed line directly.
function exhaustive(text: string, width: number, o: Options, emergency = false, optical?: Optical, count?: number): number {
  const breaks = [{ end: 0, next: 0, hyphen: false }];
  for (const match of text.matchAll(/[^ ]+/g)) {
    const parts = split(match[0]);
    let offset = match.index;
    for (const part of parts.slice(0, -1)) {
      offset += part.length;
      breaks.push({ end: offset, next: offset, hyphen: true });
    }
    const end = match.index + match[0].length;
    breaks.push({ end, next: Math.min(text.length, end + 1), hyphen: false });
  }
  let best = Infinity;
  function visit(start: number, total: number, previousFitness = 1, lines = 0) {
    if (start === breaks.length - 1) { if (count === undefined || lines === count) best = Math.min(best, total); return; }
    for (let end = start + 1; end < breaks.length; end++) {
      const a = breaks[start], b = breaks[end];
      const visible = text.slice(a.next, b.end) + (b.hyphen ? "-" : "");
      const last = end === breaks.length - 1, gaps = visible.split(" ").length - 1;
      const chars = [...visible].length, natural = measure(visible);
      const firstIndex = text.slice(0, a.next).split(" ").length - 1;
      const lastIndex = text.slice(0, b.end).split(" ").length - 1;
      const hanging = Math.max(b.hyphen ? 0 : measure(visible.match(/[.,;:!?…’”'"]+$/u)?.[0] ?? "") * o.hanging,
        (optical?.(visible.split(" ").at(-1)!, lastIndex).end ?? 0) * o.protrusion);
      const opening = optical ? optical(visible.split(" ")[0], firstIndex).start * o.protrusion
        : measure(visible.match(/^[“‘"'«‹]/u)?.[0] ?? "") * o.opening;
      const target = width + hanging + opening;
      const delta = last && natural <= target ? 0 : target - natural;
      const capacity = gaps * 4 * (delta < 0 ? o.shrink : o.stretch) + chars * o.tracking;
      const ratio = capacity ? Math.min(1, Math.abs(delta) / capacity) : 0;
      const signed = capacity ? delta / capacity : delta === 0 ? 0 : Math.sign(delta) * Infinity;
      const fitness = signed < -0.5 ? 0 : signed <= 0.5 ? 1 : signed <= 1 ? 2 : 3;
      let residual = delta - Math.sign(delta) * ratio * capacity;
      let strain = 100 * ratio ** 3;
      if (o.mode === "balanced") {
        strain = 100 * (ratio + Math.abs(residual) / Math.max(capacity, gaps * 4, 4)) ** 3;
        if (gaps) {
          const before = Math.sign(delta) * ratio * 4 * (delta < 0 ? o.shrink : o.stretch);
          residual -= (Math.max(-4 * o.shrink, before + residual / gaps) - before) * gaps;
        }
      }
      if (emergency && delta > 0) {
        const extra = Math.min(width * o.emergencyStretch, gaps * measure(" "));
        strain = 100 * (delta / Math.max(measure(" "), capacity + extra)) ** 3;
      }
      if (o.mode === "balanced" && o.emergencyStretch > 0 && !emergency && (delta > capacity * Math.cbrt(2) + 0.01 || Math.abs(residual) > 0.01)) continue;
      let cost = 1 + strain * (delta < 0 ? o.compressionPenalty : 1);
      if (Math.abs(residual) > 0.01) cost += o.mode === "balanced" && residual < 0
        ? 1e6 + 1e4 * residual ** 2 : 1e4 + 100 * residual ** 2;
      if (last && start > 0) {
        const missing = Math.max(0, width * o.lastLine - natural);
        cost += o.ending === "soft" ? o.widowPenalty * (missing / width) ** 2
          : o.widowPenalty / 300 * Math.min(10000, 100 * (missing / Math.max(4, gaps * 4 * o.stretch + chars * o.tracking)) ** 3);
      }
      cost += b.hyphen ? o.hyphenPenalty + (a.hyphen ? o.consecutiveHyphenPenalty : 0)
        : last && a.hyphen ? o.finalHyphenPenalty : 0;
      if (start && Math.abs(fitness - previousFitness) > 1) cost += o.adjacentPenalty;
      visit(end, total + cost, fitness, lines + 1);
    }
  }
  visit(0, 0);
  return best === Infinity && !emergency ? exhaustive(text, width, o, true, optical, count) : best;
}

describe("optional hyphenation", () => {
  it("matches exhaustive partitions including shaping, adjacency costs, and both fitting passes", () => {
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 100; i++) {
      const text = Array.from({ length: 2 + i % 3 }, () => "a".repeat(3 + Math.floor(random() * 7))).join(" ");
      const width = 30 + random() * 150;
      const o: Options = { ...defaults, mode: i % 2 ? "strict" : "balanced", ending: i % 3 ? "fit" : "soft", tracking: random(), shrink: random(), hyphenPenalty: random() * 100, consecutiveHyphenPenalty: random() * 300, finalHyphenPenalty: random() * 300 };
      const hyphenated = withHyphenation(prepare(text, measure), split, measure);
      const optical: Optical | undefined = i % 3 ? undefined : (text, index) => ({ start: 0.3 * (text.charCodeAt(0) % 5) + index * 0.1, end: text.endsWith("-") ? 2.5 : 0.4 * index });
      const p = optical ? withOpticalMargins(hyphenated, optical) : hyphenated;
      const result = solve(p, width, o);
      expect(result.cost, `case ${i}`).toBeCloseTo(exhaustive(text, width, o, false, optical), 5);
      let source = "";
      for (const [j, line] of result.lines.entries()) {
        const visible = lineText(p, line);
        if (j && !result.lines[j - 1].hyphenated) source += " ";
        source += line.hyphenated ? visible.slice(0, -1) : visible;
        expect(line.natural).toBeCloseTo(measure(visible), 8);
        expect(Math.abs(line.tracking)).toBeLessThanOrEqual(o.tracking + 1e-9);
        expect(line.wordSpacing).toBeGreaterThanOrEqual(-4 * o.shrink - 1e-9);
        if (!line.last || line.natural > width + line.hanging + line.opening) {
          expect(line.natural + line.wordSpacing * (line.end - line.start - 1) + line.tracking * [...visible].length + line.residual).toBeCloseTo(width + line.hanging + line.opening, 7);
        }
      }
      expect(source).toBe(text);
    }
  });

  it("matches exhaustive partitions with exactly the requested number of lines", () => {
    let seed = 23;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 60; i++) {
      const text = Array.from({ length: 2 + i % 3 }, () => "a".repeat(3 + Math.floor(random() * 7))).join(" ");
      const width = 30 + random() * 150;
      const p = withHyphenation(prepare(text, measure), split, measure);
      const breaks = p.words.length + p.hyphenation!.reduce((n, f) => n + (f ? f.offsets.length - 2 : 0), 0);
      const count = 1 + Math.floor(random() * Math.min(5, breaks));
      const o: Options = { ...defaults, mode: i % 2 ? "strict" : "balanced", tracking: random(), shrink: random() };
      const result = solve(p, width, { ...o, lines: count });
      expect(result.lines.length, `case ${i}`).toBe(count);
      expect(result.cost, `case ${i}`).toBeCloseTo(exhaustive(text, width, o, false, undefined, count), 5);
    }
  });

  it("can split one word on successive lines and retains exact source offsets", () => {
    const p = withHyphenation(prepare("abcdefghijklmnopqr", measure), split, measure);
    const result = solve(p, 56, { tracking: 0 });
    expect(result.lines.map(l => lineText(p, l))).toEqual(["abcdef-", "ghijkl-", "mnopqr"]);
    expect(result.lines.map(l => [l.startOffset ?? 0, l.endOffset ?? 18])).toEqual([[0, 6], [6, 12], [12, 18]]);
    expect(result.lines.every(l => l.residual === 0)).toBe(true);
    const unpenalized = solve(p, 56, { tracking: 0, hyphenPenalty: 0, consecutiveHyphenPenalty: 0, finalHyphenPenalty: 0 });
    expect(result.cost - unpenalized.cost).toBe(2 * defaults.hyphenPenalty + defaults.consecutiveHyphenPenalty + defaults.finalHyphenPenalty);
  });

  it("retains whole-word choices and reuses all fragment measurements across solves", () => {
    const original = prepare("aaa bbbbbbb ccc", measure);
    const unchanged = withHyphenation(original, word => [word], measure);
    expect(solve(unchanged, 70)).toEqual(solve(original, 70));
    let calls = 0;
    const p = withHyphenation(original, split, text => { calls++; return measure(text); });
    const measured = calls;
    expect(solve(p, 500).lines.map(l => lineText(p, l))).toEqual(["aaa bbbbbbb ccc"]);
    solve(p, 80); solve(p, 120);
    expect(calls).toBe(measured);
    expect(p.words).toEqual(original.words);
  });

  it("rejects corrupt word partitions and grapheme splits, preserving NBSP tokens", () => {
    expect(() => withHyphenation(prepare("word", measure), () => ["wrong"], measure)).toThrow(RangeError);
    expect(() => withHyphenation(prepare("word", measure), () => ["", "word"], measure)).toThrow(RangeError);
    expect(() => withHyphenation(prepare("ábc", measure), () => ["a", "́bc"], measure)).toThrow(RangeError);
    expect(() => withHyphenation(prepare("abcdef", measure), split, () => NaN)).toThrow(RangeError);
    const p = withHyphenation(prepare("10\u00a0km", measure), () => { throw new Error("Must stay indivisible"); }, measure);
    expect(p.hyphenation).toEqual([undefined]);
  });
});
