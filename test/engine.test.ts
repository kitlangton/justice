import { describe, expect, it } from "vitest";
import { defaults, lineText, prepare, solve, withHyphenation, withOpticalMargins, type Measure, type Options, type Prepared } from "../src/engine";

const measure = (text: string) => Array.from(text).reduce((n, c) => n + (c === " " ? 4 : 8), 0);

// Enumerate every partition independently. This oracle deliberately has no pruning,
// prefix sums, or dynamic programming, so unsafe early exits cannot hide in both.
function exhaustive(p: Prepared, measure_: Measure, o: Options, emergency = false, count?: number): number {
  const widths = typeof measure_ === "number" ? [measure_] : measure_;
  let best = Infinity;
  function visit(start: number, total: number, previousFitness = 1, line = 0) {
    if (start === p.words.length) { if (count === undefined || line === count) best = Math.min(best, total); return; }
    const width = widths[Math.min(line, widths.length - 1)];
    for (let end = start + 1; end <= p.words.length; end++) {
      const text = p.words.slice(start, end).join(" ");
      const natural = measure(text);
      const suffix = text.match(/[.,;:!?…’”'"]+$/u)?.[0] ?? "";
      const quote = text.match(/^[“‘"'«‹]/u)?.[0] ?? "";
      const target = width + Math.max(measure(suffix) * o.hanging, (p.endProtrusions?.[end - 1] ?? 0) * o.protrusion)
        + (p.startProtrusions ? p.startProtrusions[start] * o.protrusion : measure(quote) * o.opening);
      const delta = end === p.words.length && natural <= target ? 0 : target - natural;
      const capacity = (end - start - 1) * p.space * (delta < 0 ? o.shrink : o.stretch) + Array.from(text).length * o.tracking;
      const ratio = capacity ? Math.min(1, Math.abs(delta) / capacity) : 0;
      const signed = capacity ? delta / capacity : delta === 0 ? 0 : Math.sign(delta) * Infinity;
      const fitness = signed < -0.5 ? 0 : signed <= 0.5 ? 1 : signed <= 1 ? 2 : 3;
      let residual = delta - Math.sign(delta) * ratio * capacity;
      let cost = 1 + 100 * ratio ** 3;
      if (o.mode === "balanced") {
        const gaps = end - start - 1;
        cost = 1 + 100 * (ratio + Math.abs(residual) / Math.max(capacity, gaps * p.space, p.space)) ** 3;
        if (gaps) {
          const before = Math.sign(delta) * ratio * p.space * (delta < 0 ? o.shrink : o.stretch);
          const after = Math.max(-p.space * o.shrink, before + residual / gaps);
          residual -= (after - before) * gaps;
        }
      }
      if (emergency && delta > 0) {
        const extra = Math.min(width * o.emergencyStretch, (end - start - 1) * p.space);
        cost = 1 + 100 * (delta / Math.max(p.space, capacity + extra)) ** 3;
      }
      if (o.mode === "balanced" && o.emergencyStretch > 0 && !emergency && (delta > capacity * Math.cbrt(2) + 0.01 || Math.abs(residual) > 0.01)) continue;
      if (delta < 0) cost = 1 + (cost - 1) * o.compressionPenalty;
      if (Math.abs(residual) > 0.01) cost += o.mode === "balanced" && residual < 0
        ? 1e6 + 1e4 * residual ** 2 : 10000 + 100 * residual ** 2;
      if (end === p.words.length && start > 0) {
        const deficit = Math.max(0, width * o.lastLine - natural);
        const flex = (end - start - 1) * p.space * o.stretch + Array.from(text).length * o.tracking;
        cost += o.ending === "soft" ? o.widowPenalty * (deficit / width) ** 2
          : o.widowPenalty / 300 * Math.min(10000, 100 * (deficit / Math.max(p.space, flex)) ** 3);
      }
      if (start && Math.abs(fitness - previousFitness) > 1) cost += o.adjacentPenalty;
      visit(end, total + cost, fitness, line + 1);
    }
  }
  visit(0, 0);
  return best === Infinity && !emergency ? exhaustive(p, measure_, o, true, count) : best;
}

describe("Justice's layout contract", () => {
  it("matches the global exhaustive optimum across widths, limits, and impossible fits", () => {
    let seed = 42;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 500; i++) {
      const text = Array.from({ length: 2 + Math.floor(random() * 8) }, () => (random() < 0.2 ? "“" : "") + "w".repeat(1 + Math.floor(random() * 14)) + ["", "", ".", ",", ".”"][Math.floor(random() * 5)]).join(" ");
      const original = prepare(text, measure);
      const p = i % 3 ? original : withOpticalMargins(original, (_, index) => ({ start: (index % 3) * 1.7, end: (index % 2) * 2.1 }));
      const width = 20 + Math.floor(random() * 300);
      const o: Options = { ...defaults, mode: "strict", ending: i % 2 ? "soft" : "fit", emergencyStretch: i % 3 ? random() * 0.2 : 0, opening: random(), stretch: random() * 2, shrink: random(), tracking: i % 10 === 0 ? 10 : random(), compressionPenalty: random() * 4, hanging: random(), lastLine: random(), widowPenalty: random() * 3000 };
      const result = solve(p, width, o);
      expect(result.cost, `case ${i}`).toBeCloseTo(exhaustive(p, width, o), 5);
      expect(result.lines.map(l => lineText(p, l)).join(" ")).toBe(text);
      for (const l of result.lines) {
        expect(Math.abs(l.tracking)).toBeLessThanOrEqual(o.tracking + 1e-9);
        expect(l.wordSpacing).toBeLessThanOrEqual(p.space * o.stretch + 1e-9);
        expect(l.wordSpacing).toBeGreaterThanOrEqual(-p.space * o.shrink - 1e-9);
        const rendered = l.natural + l.wordSpacing * (l.end - l.start - 1) + l.tracking * Array.from(lineText(p, l)).length;
        if (!l.last || l.natural > width + l.hanging + l.opening) expect(rendered + l.residual).toBeCloseTo(width + l.hanging + l.opening, 6);
      }
      const balanced = solve(p, width, { ...o, mode: "balanced" });
      expect(balanced.cost, `balanced case ${i}`).toBeCloseTo(exhaustive(p, width, { ...o, mode: "balanced" }), 5);
      expect(balanced.lines.map(l => lineText(p, l)).join(" ")).toBe(text);
      for (const l of balanced.lines) {
        expect(Math.abs(l.tracking)).toBeLessThanOrEqual(o.tracking + 1e-9);
        expect(l.wordSpacing).toBeGreaterThanOrEqual(-p.space * o.shrink - 1e-9);
        const rendered = l.natural + l.wordSpacing * (l.end - l.start - 1) + l.tracking * Array.from(lineText(p, l)).length;
        if (!l.last || l.natural > width + l.hanging + l.opening) expect(rendered + l.residual).toBeCloseTo(width + l.hanging + l.opening, 6);
        if (!l.last && l.end - l.start > 1) expect(l.residual).toBeLessThanOrEqual(1e-9);
      }
    }
  });
  it("matches the exhaustive optimum for per-line measures, and records each line's width", () => {
    let seed = 7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 200; i++) {
      const text = Array.from({ length: 3 + Math.floor(random() * 8) }, () => (random() < 0.2 ? "“" : "") + "w".repeat(1 + Math.floor(random() * 12)) + ["", "", ".", ","][Math.floor(random() * 4)]).join(" ");
      const p = prepare(text, measure);
      const widths = Array.from({ length: 1 + Math.floor(random() * 4) }, () => 30 + Math.floor(random() * 200));
      const o: Options = { ...defaults, mode: i % 2 ? "strict" : "balanced", emergencyStretch: i % 3 ? random() * 0.2 : 0, stretch: random() * 2, shrink: random(), tracking: random(), opening: random(), hanging: random(), lastLine: random(), widowPenalty: random() * 2000, adjacentPenalty: i % 4 ? 100 : 0 };
      const result = solve(p, widths, o);
      expect(result.cost, `case ${i}`).toBeCloseTo(exhaustive(p, widths, o), 5);
      expect(result.lines.map(l => lineText(p, l)).join(" ")).toBe(text);
      result.lines.forEach((l, index) => expect(l.width).toBe(widths[Math.min(index, widths.length - 1)]));
    }
  });
  it("fits a first-line indent and a drop cap by narrowing only the affected lines", () => {
    const p = prepare("one two three four five six seven eight nine ten eleven twelve", measure);
    const indented = solve(p, [200 - 40, 200], { tracking: 0 });
    expect(indented.lines[0].width).toBe(160);
    expect(indented.lines.slice(1).every(l => l.width === 200)).toBe(true);
    expect(indented.lines[0].natural).toBeLessThanOrEqual(160 + indented.lines[0].hanging);
    const dropCap = solve(p, [120, 120, 200], { tracking: 0 });
    expect(dropCap.lines.map(l => l.width)).toEqual([120, 120, 200, 200].slice(0, dropCap.lines.length));
    expect(() => solve(p, [])).toThrow(RangeError);
    expect(() => solve(p, [100, 0])).toThrow(RangeError);
  });
  it("breaks after a source hyphen without adding a glyph, and merges dictionary breaks", () => {
    const p = prepare("a well-known state-of-the-art thing", measure);
    expect(p.hyphenation?.[1]?.offsets).toEqual([0, 5, 10]);
    expect(p.hyphenation?.[1]?.explicit).toEqual([false, true, false]);
    expect(p.hyphenation?.[2]?.offsets).toEqual([0, 6, 9, 13, 16]);
    expect(p.hyphenation?.[0]).toBeUndefined();
    const narrow = solve(p, 60, { tracking: 0 });
    const texts = narrow.lines.map(l => lineText(p, l));
    expect(texts).toContain("a well-");
    expect(narrow.lines.every(l => !l.hyphenated)).toBe(true);
    const source = narrow.lines.map((l, i) => lineText(p, l) + (l.endOffset ? "" : i === narrow.lines.length - 1 ? "" : " ")).join("");
    expect(source).toBe("a well-known state-of-the-art thing");
    expect(narrow.lines.filter(l => l.endOffset).every(l => lineText(p, l).endsWith("-"))).toBe(true);
    const cheap = solve(p, 60, { tracking: 0, explicitHyphenPenalty: 0 }).cost;
    const dear = solve(p, 60, { tracking: 0, explicitHyphenPenalty: 500 }).cost;
    expect(dear).toBeGreaterThan(cheap);
    expect(prepare("-5 to 5- and -- or a-", measure).hyphenation).toBeUndefined();
    const merged = withHyphenation(p, word => word === "well-known" ? ["well-kn", "own"] : [word], measure);
    expect(merged.hyphenation?.[1]?.offsets).toEqual([0, 5, 7, 10]);
    expect(merged.hyphenation?.[1]?.explicit).toEqual([false, true, false, false]);
    expect(merged.hyphenation?.[2]?.explicit).toEqual([false, true, true, true, false]);
    const long = withHyphenation(prepare("abc-defghijkl", measure), () => ["abc-def", "ghijkl"], measure);
    const tiny = solve(long, 60, { tracking: 0 });
    expect(tiny.lines.map(l => lineText(long, l))).toEqual(["abc-", "def-", "ghijkl"]);
    expect(tiny.lines.map(l => l.hyphenated)).toEqual([false, true, false]);
    expect(tiny.lines.map(l => l.natural)).toEqual([32, 32, 48]);
  });
  it("finishes loose lines and modest overflow without stretching ragged endings", () => {
    const p = prepare("aaa bbb ccccccc", measure);
    const strict = solve(p, 70, { mode: "strict", tracking: 0 });
    const balanced = solve(p, 70, { tracking: 0 });
    expect(strict.lines[0].residual).toBeGreaterThan(0);
    expect(balanced.lines[0].residual).toBe(0);
    expect(balanced.lines[0].relaxed).toBe(true);
    expect(balanced.lines.at(-1)!.wordSpacing).toBe(0);
    const tight = prepare("aaa bbb", measure);
    expect(solve(tight, 50, { mode: "strict", tracking: 0 }).lines[0].residual).toBe(-1);
    const finished = solve(tight, 50, { tracking: 0, shrink: 0.5 }).lines[0];
    expect(finished.wordSpacing).toBe(-2);
    expect(finished.residual).toBe(0);
    expect(finished.tracking).toBeCloseTo(0);
  });
  it("reports unavoidable overflow without breaking or losing a word", () => {
    const p = prepare("tiny extraordinarilylongword tiny", measure);
    const result = solve(p, 40, { tracking: 0 });
    expect(result.lines.some(l => l.residual < 0)).toBe(true);
    expect(result.lines.map(l => lineText(p, l)).join(" ")).toBe(p.words.join(" "));
  });
  it("hangs a measured period without expanding its letters or counting optical credit as overflow", () => {
    const p = prepare("word.", measure);
    const off = solve(p, 32, { tracking: 0, hanging: 0 }).lines[0];
    const half = solve(p, 32, { tracking: 0, hanging: 0.5 }).lines[0];
    const on = solve(p, 32, { tracking: 0, hanging: 1 }).lines[0];
    expect([off.residual, half.residual, on.residual]).toEqual([-8, -4, 0]);
    expect(on.hanging).toBe(8);
    expect(on.natural).toBe(40);
    expect(on.wordSpacing).toBe(0);
    expect(lineText(p, on)).toBe("word.");
  });
  it("only credits trailing punctuation, including a closing quote, and leaves ragged endings natural", () => {
    const p = prepare('“one” can’t v1.2 done.”', measure);
    expect([...p.endHangs]).toEqual([8, 0, 0, 16]);
    const line = solve(p, 1000).lines[0];
    expect(line.wordSpacing).toBe(0);
    expect(line.tracking).toBe(0);
    expect(line.residual).toBe(0);
  });
  it("keeps nonbreaking spaces inside a token and collapses ordinary whitespace", () => {
    const p = prepare("  walk\t10\u00a0km\n today  ", measure);
    expect(p.words).toEqual(["walk", "10\u00a0km", "today"]);
    expect(solve(p, 20).lines.map(l => lineText(p, l)).join(" ")).toBe("walk 10\u00a0km today");
  });
  it("reuses measurement across multiple solves and measures duplicate words once", () => {
    let calls = 0;
    const p = prepare("one two one two", text => { calls++; return measure(text); });
    expect(calls).toBe(3);
    solve(p, 40); solve(p, 100); solve(p, 80, { stretch: 1 });
    expect(calls).toBe(3);
  });
  it("finds the exhaustive optimum among layouts with exactly the requested number of lines", () => {
    let seed = 11;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 2 + Math.floor(random() * 8) }, () => "w".repeat(1 + Math.floor(random() * 12)) + ["", "", ".", ","][Math.floor(random() * 4)]).join(" ");
      const p = prepare(text, measure);
      const widths = i % 3 ? 30 + Math.floor(random() * 250) : Array.from({ length: 1 + Math.floor(random() * 3) }, () => 30 + Math.floor(random() * 200));
      const count = 1 + Math.floor(random() * p.words.length);
      const o: Options = { ...defaults, mode: i % 2 ? "strict" : "balanced", emergencyStretch: i % 4 ? random() * 0.2 : 0, stretch: random() * 2, shrink: random(), tracking: random(), lastLine: random(), adjacentPenalty: i % 5 ? 100 : 0 };
      const result = solve(p, widths, { ...o, lines: count });
      expect(result.lines.length, `case ${i}`).toBe(count);
      expect(result.cost, `case ${i}`).toBeCloseTo(exhaustive(p, widths, o, false, count), 5);
      expect(result.lines.map(l => lineText(p, l)).join(" ")).toBe(text);
    }
  });
  it("keeps a paragraph's ragged line count, reporting spacing for the width it renders at", () => {
    const text = "Justice picks every break in a paragraph together, so a justified paragraph can need fewer lines than the same text set ragged, which moves everything below it on the page.";
    const p = prepare(text, measure);
    const width = 320;
    const free = solve(p, width, { tracking: 0 });
    const ragged = solve(p, width, { tracking: 0, lines: "ragged" });
    // Greedy first fit at natural spacing: what a browser sets with text-align: left.
    let count = 0;
    for (let start = 0; start < p.words.length; count++) {
      let end = start + 1;
      while (end < p.words.length && measure(p.words.slice(start, end + 1).join(" ")) <= width) end++;
      start = end;
    }
    expect(free.lines.length).toBe(count - 1);
    expect(ragged.lines.length).toBe(count);
    expect(solve(p, width, { tracking: 0, lines: count }).lines).toEqual(ragged.lines);
    for (const line of ragged.lines.slice(0, -1)) {
      expect(line.width).toBe(width);
      expect(line.residual).toBe(0);
      expect(line.natural + line.wordSpacing * (line.end - line.start - 1)).toBeCloseTo(width + line.hanging + line.opening, 8);
    }
    // More lines than words can't be set; the unconstrained optimum is returned and its length reports that.
    expect(solve(p, width, { lines: 1000 })).toEqual(solve(p, width));
    for (const lines of [0, -1, 1.5, NaN, "loose"]) expect(() => solve(p, width, { lines: lines as number })).toThrow(RangeError);
  });
  it("handles empty paragraphs and rejects invalid dimensions or policies", () => {
    const p = prepare(" \n\t", measure);
    expect(solve(p, 100)).toEqual({ lines: [], cost: 0, candidates: 0 });
    for (const width of [0, -1, Infinity, NaN]) expect(() => solve(p, width)).toThrow(RangeError);
    expect(() => solve(p, 100, { shrink: 2 })).toThrow(RangeError);
    expect(() => solve(p, 100, { tracking: -1 })).toThrow(RangeError);
    expect(() => solve(p, 100, { hanging: 1.1 })).toThrow(RangeError);
    expect(() => prepare("word", () => NaN)).toThrow(RangeError);
    expect(() => solve(p, 100, { ...defaults, widowPenalty: NaN })).toThrow(RangeError);
  });
});
