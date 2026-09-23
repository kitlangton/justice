import { deepStrictEqual } from "node:assert";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { lineText, prepare, solve } from "../src/engine";
import { lineRuns, prepareRich, type RichPrepared, type RichRun } from "../src/rich";

// Optional arguments: baseline src/engine.ts and src/rich.ts. Alternate
// measurement order to reduce warmup/order bias. These synthetic widths measure
// adapter/solver CPU, not browser font shaping, DOM rendering, or interaction.
const baseline: typeof import("../src/engine") | undefined = process.argv[2]
  ? await import(pathToFileURL(resolve(process.argv[2])).href) : undefined;
const richBaseline: typeof import("../src/rich") | undefined = process.argv[3]
  ? await import(pathToFileURL(resolve(process.argv[3])).href) : undefined;
const sentence = "Interoperability, internationalization, and electroencephalography are perfectly ordinary words until they meet an extraordinarily narrow column. A justification algorithm must make a choice: loosen the spaces, tighten the letters, or admit that this particular line simply cannot fit. Short words are a test too. We go up to the old inn by the sea. It is a place of light and air, of tea at six and long walks in the rain. A few small words can leave a very large hole.";
const marks = [
  { name: "plain", scale: 1 },
  { name: "strong", scale: 1.09 },
  { name: "em", scale: 1.025 },
  { name: "link", scale: 1 },
];
type Marks = typeof marks[number];
const measure = (text: string) => Array.from(text).reduce((sum, char) =>
  sum + (char === " " ? 4 : /[il.,!]/.test(char) ? 4 : /[MW]/.test(char) ? 12 : 8), 0);
const measureRich = (runs: readonly RichRun<Marks>[]) =>
  runs.reduce((sum, run) => sum + measure(run.text) * run.marks.scale, 0);
// Pruning may intentionally change diagnostic candidate counts without changing
// the chosen lines or total cost.
const geometry = ({ lines, cost }: ReturnType<typeof solve>) => ({ lines, cost });

function mixedRuns(text: string): RichRun<Marks>[] {
  const runs: RichRun<Marks>[] = [];
  let word = 0;
  for (const token of text.match(/\S+|\s+/g)!) {
    if (/^\s/.test(token)) { runs.push({ text: token, marks: marks[0] }); continue; }
    const style = marks[word++ % marks.length];
    const split = word % 5 === 0 ? Math.floor(token.length / 2) : 0;
    if (split) runs.push({ text: token.slice(0, split), marks: marks[0] });
    runs.push({ text: token.slice(split), marks: style });
  }
  return runs;
}

type Case = { name: string; run: () => number; iterations: number };
let checksum = 0;
function bench(cases: Case[]) {
  // Warm each case for at least 50 ms, then target 15 ms per timed batch.
  // Tiny batches can otherwise measure timer noise or a mid-sample JIT tier-up.
  cases = cases.map(task => {
    const start = performance.now();
    let iterations = 0;
    do {
      for (let index = 0; index < task.iterations; index++) checksum += task.run();
      iterations += task.iterations;
    } while (performance.now() - start < 50);
    return { ...task, iterations: Math.max(1, Math.ceil(iterations * 15 / (performance.now() - start))) };
  });
  const samples = cases.map(() => [] as number[]);
  for (let round = 0; round < 14; round++) {
    const order = cases.map((_, index) => index);
    if (round % 2) order.reverse();
    for (const index of order) {
      const task = cases[index];
      const start = performance.now();
      for (let iteration = 0; iteration < task.iterations; iteration++) checksum += task.run();
      const elapsed = (performance.now() - start) / task.iterations;
      if (round >= 3) samples[index].push(elapsed);
    }
  }
  return Object.fromEntries(cases.map((task, index) => {
    const times = samples[index].sort((a, b) => a - b);
    const median = times[5];
    const mad = times.map(time => Math.abs(time - median)).sort((a, b) => a - b)[5];
    return [task.name, { median_ms: median, mad_ms: mad, iterations: task.iterations }];
  }));
}

console.log(JSON.stringify({ runtime: `Bun ${Bun.version}`, platform: process.platform, arch: process.arch,
  calibration_ms: 50, target_batch_ms: 15, warmup_rounds: 3, measured_rounds: 11,
  baseline: process.argv[2] ?? null, rich_baseline: process.argv[3] ?? null }));
for (const copies of [1, 4, 12]) {
  const text = Array(copies).fill(sentence).join(" ");
  const single = [{ text, marks: marks[0] }];
  const mixed = mixedRuns(text);
  const plain = prepare(text, measure);
  let singleCalls = 0, mixedCalls = 0;
  const uniform = prepareRich(single, runs => { singleCalls++; return measureRich(runs); }, { space: 4 });
  const styled = prepareRich(mixed, runs => { mixedCalls++; return measureRich(runs); }, { space: 4 });
  const old = baseline?.prepare(text, measure);
  const prepIterations = copies === 12 ? 15 : 60;
  const preparationCases: Case[] = [
    { name: "plain", run: () => prepare(text, measure).words.length, iterations: prepIterations },
    { name: "single_style", run: () => prepareRich(single, measureRich, { space: 4 }).words.length, iterations: prepIterations },
    { name: "mixed_style", run: () => prepareRich(mixed, measureRich, { space: 4 }).words.length, iterations: prepIterations },
  ];
  if (richBaseline) {
    deepStrictEqual(styled, richBaseline.prepareRich(mixed, measureRich, { space: 4 }));
    preparationCases.push({ name: "baseline_mixed_style", run: () => richBaseline.prepareRich(mixed, measureRich, { space: 4 }).words.length, iterations: prepIterations });
  }
  const preparation = bench(preparationCases);
  const widths = [];
  for (const width of [280, 480, 720]) {
    const layout = solve(plain, width), richLayout = solve(uniform, width), styledLayout = solve(styled, width);
    if (JSON.stringify(layout) !== JSON.stringify(richLayout)) throw new Error("Single-style rich layout differs from plain layout");
    if (baseline && old) deepStrictEqual(geometry(layout), geometry(baseline.solve(old, width)), "Plain layout differs from baseline");
    const iterations = copies === 12 ? 10 : 40;
    const cases: Case[] = [
      { name: "plain", run: () => solve(plain, width).lines.length, iterations },
      { name: "single_style", run: () => solve(uniform, width).lines.length, iterations },
      { name: "mixed_style", run: () => solve(styled, width).lines.length, iterations },
    ];
    // Exercise both object shapes in both modules, so the baseline is not
    // monomorphic while the current solver is polymorphic merely due to this
    // benchmark. The solver's numerical input and source remain comparable.
    if (baseline && old) cases.push(
      { name: "baseline", run: () => baseline.solve(old, width).lines.length, iterations },
      { name: "baseline_single_style", run: () => baseline.solve(uniform, width).lines.length, iterations },
      { name: "baseline_mixed_style", run: () => baseline.solve(styled, width).lines.length, iterations },
    );
    const solving = bench(cases);
    const rendering = bench([
      { name: "plain_line_text", run: () => layout.lines.reduce((sum, line) => sum + lineText(plain, line).length, 0), iterations: iterations * 4 },
      { name: "mixed_line_runs", run: () => styledLayout.lines.reduce((sum, line) => sum + lineRuns(styled, line).length, 0), iterations: iterations * 4 },
    ]);
    widths.push({ width, solving, rendering });
  }
  console.log(JSON.stringify({ words: plain.words.length, input_runs: mixed.length,
    single_measure_calls: singleCalls, mixed_measure_calls: mixedCalls, preparation, widths }));
}
// Additional rich preparation cases distinguish repeated and unique text,
// Unicode segmentation, and explicit/dictionary hyphenation. Reuse the same
// paired timing harness and verify every numerical buffer before timing.
if (richBaseline) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const hyphenate = (word: string) => [...segmenter.segment(word)].map(part => part.segment)
    .reduce<string[]>((parts, part, index) => {
      if (index % 3) parts[parts.length - 1] += part;
      else parts.push(part);
      return parts;
    }, []);
  const cases = [
    { name: "unique_ascii", text: Array.from({ length: 1000 }, (_, i) => `word${i.toString(36)}suffix`).join(" ") },
    { name: "repeated_unicode", text: Array(100).fill("café déjà 👩‍💻क्षि Ångström 🇩🇰🇨🇦").join(" ") },
    { name: "unique_unicode", text: Array.from({ length: 500 }, (_, i) => `café${i}क्षि`).join(" ") },
    { name: "explicit_hyphens", text: Array(80).fill("well-known inter-operability plan-of-action semi-international").join(" ") },
    { name: "dictionary", text: Array(40).fill("internationalization extraordinary configuration initialization").join(" "), hyphenate },
    { name: "unicode_dictionary", text: Array(20).fill("cafédéjà 🇩🇰🇨🇦🇺🇸🇫🇷 👩‍💻ábcdef Ångström क्षिक्षि").join(" "), hyphenate },
  ];
  for (const item of cases) {
    const runs = mixedRuns(item.text), options = { space: 4, hyphenate: item.hyphenate };
    const before: RichPrepared<Marks> = richBaseline.prepareRich(runs, measureRich, options);
    const after = prepareRich(runs, measureRich, options);
    deepStrictEqual(after, before, item.name);
    const layout = solve(after, 480);
    if (baseline) deepStrictEqual(geometry(layout), geometry(baseline.solve(before, 480)), item.name);
    for (const line of layout.lines) deepStrictEqual(lineRuns(after, line), richBaseline.lineRuns(before, line), item.name);
    const preparation = bench([
      { name: "baseline", run: () => richBaseline.prepareRich(runs, measureRich, options).words.length, iterations: 10 },
      { name: "current", run: () => prepareRich(runs, measureRich, options).words.length, iterations: 10 },
    ]);
    const extraction = bench([
      { name: "baseline", run: () => layout.lines.reduce((sum, line) => sum + richBaseline.lineRuns(before, line).length, 0), iterations: 40 },
      { name: "current", run: () => layout.lines.reduce((sum, line) => sum + lineRuns(after, line).length, 0), iterations: 40 },
    ]);
    console.log(JSON.stringify({ case: item.name, words: after.words.length, preparation, extraction }));
  }
}
console.log(JSON.stringify({ checksum }));
