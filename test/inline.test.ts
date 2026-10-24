import { expect, it } from "vitest";
import { lineText, prepare, solve, withHyphenation, type Run } from "../src/engine";

// Sans: 8px letters and 4px spaces. Code: a wider monospace, 10px for everything.
type Style = "code";
const measure = (text: string, style?: Style) => [...text].reduce((n, c) => n + (style === "code" ? 10 : c === " " ? 4 : 8), 0);
const runs: Run<Style>[] = [{ text: "Run " }, { text: "run", style: "code" }, { text: ", then run it." }];

it("measures each piece of a word in its own run's style, caching by style and text", () => {
  const calls: [string, Style | undefined][] = [];
  const p = prepare(runs, (text, style) => { calls.push([text, style]); return measure(text, style); });
  expect(p.words).toEqual(["Run", "run,", "then", "run", "it."]);
  const widths = p.words.map((_, i) => p.widths[i + 1] - p.widths[i]);
  // "run" in code is 30px; the same text in sans is 24px. "run," joins a code piece and a sans comma.
  expect(widths).toEqual([24, 38, 32, 24, 24]);
  expect(calls).toContainEqual(["run", "code"]);
  expect(calls).toContainEqual(["run", undefined]);
  expect(new Set(calls.map(c => c.join("|"))).size).toBe(calls.length);
  expect(p.space).toBe(4);
  expect([...p.endHangs]).toEqual([0, 8, 0, 0, 8]);
});

it("maps every word, gap and line back to offsets in the joined source", () => {
  const source = runs.map(run => run.text).join("");
  const p = prepare(runs, measure);
  expect(p.starts).toEqual([0, 4, 9, 14, 18]);
  p.words.forEach((word, i) => expect(source.slice(p.starts![i], p.starts![i] + word.length)).toBe(word));
  const { lines } = solve(p, 90, { tracking: 0 });
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    const from = p.starts![line.start], to = p.starts![line.end - 1] + p.words[line.end - 1].length;
    expect(source.slice(from, to)).toBe(lineText(p, line));
  }
  // Plain text records the same offsets, through any run of whitespace.
  expect(prepare("  a\t\tbc  d", measure).starts).toEqual([2, 5, 9]);
});

it("keeps a run's nonbreaking spaces inside one word and offsets hyphenated breaks within it", () => {
  const input: Run<Style>[] = [{ text: "Then " }, { text: "bun\u00a0run\u00a0check", style: "code" }, { text: " before typesetting." }];
  const source = input.map(run => run.text).join("");
  const p = withHyphenation(prepare(input, measure), word => word === "typesetting." ? ["type", "set", "ting."] : [word], text => measure(text));
  expect(p.words).toEqual(["Then", "bun\u00a0run\u00a0check", "before", "typesetting."]);
  expect(p.widths[2] - p.widths[1]).toBe(130);
  const { lines } = solve(p, 120, { tracking: 0 });
  const split = lines.find(line => line.hyphenated)!;
  const from = p.starts![split.start] + (split.startOffset ?? 0), to = p.starts![split.end - 1] + split.endOffset!;
  expect(source.slice(from, to) + "-").toBe(lineText(p, split));
});
