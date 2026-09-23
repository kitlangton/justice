import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Engine from "../src/engine";

// Usage: bun scripts/bench-core-compare.ts /path/to/baseline-engine.ts
// For Node/V8, transpile this file and both engine files with esbuild (format
// esm, target es2022), then pass both generated .mjs engine paths explicitly.
if (!process.argv[2]) throw new Error("Pass the baseline engine module path");
const before = await import(pathToFileURL(resolve(process.argv[2])).href) as typeof Engine;
const after = await import(pathToFileURL(resolve(process.argv[3] ?? fileURLToPath(new URL("../src/engine.ts", import.meta.url)))).href) as typeof Engine;
const text = "Interoperability, internationalization, and electroencephalography are perfectly ordinary words until they meet an extraordinarily narrow column. A justification algorithm must make a choice: loosen the spaces, tighten the letters, or admit that this particular line simply cannot fit. Short words are a test too. We go up to the old inn by the sea. It is a place of light and air, of tea at six and long walks in the rain. A few small words can leave a very large hole.";
const measure = (text: string) => [...text].reduce((sum, c) => sum + (c === " " ? 4 : /[il.,!]/.test(c) ? 4 : /[MW]/.test(c) ? 12 : 8), 0);
const hyphenate = (word: string) => word.length > 6 ? word.match(/.{1,3}/gu)! : [word];
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let sink = 0;
function paired(first: () => number, second: () => number) {
  const samples: number[][] = [[], []], operations = [first, second];
  // Alternate order to distribute warmup, GC, and clock drift across variants.
  for (let round = 0; round < 10; round++) for (const variant of round % 2 ? [1, 0] : [0, 1]) {
    let runs = 0;
    const start = performance.now();
    do { sink += operations[variant](); runs++; } while (performance.now() - start < 35);
    if (round >= 2) samples[variant].push((performance.now() - start) / runs);
  }
  const stats = samples.map(values => {
    const median_ms = median(values);
    return { median_ms, mad_ms: median(values.map(value => Math.abs(value - median_ms))) };
  });
  return { before: stats[0], after: stats[1], speedup: stats[0].median_ms / stats[1].median_ms };
}
const comparable = ({ candidates, ...layout }: Engine.Layout) => layout;
console.log(JSON.stringify({ runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`, v8: process.versions.bun ? undefined : process.versions.v8, baseline: process.argv[2] }));
for (const copies of [1, 4, 12]) {
  const source = Array(copies).fill(text).join(" "), plain = before.prepare(source, measure);
  assert.deepEqual(after.prepare(source, measure), plain);
  console.log(JSON.stringify({ operation: "prepare", words: plain.words.length, ...paired(() => before.prepare(source, measure).words.length, () => after.prepare(source, measure).words.length) }));
  for (const dictionary of [false, true]) {
    const p = dictionary ? before.withHyphenation(plain, hyphenate, measure) : plain;
    if (dictionary) {
      assert.deepEqual(after.withHyphenation(plain, hyphenate, measure), p);
      console.log(JSON.stringify({ operation: "prepare-hyphenation", words: p.words.length, ...paired(() => before.withHyphenation(plain, hyphenate, measure).words.length, () => after.withHyphenation(plain, hyphenate, measure).words.length) }));
    }
    for (const width of [280, 480, 720]) {
      const expected = before.solve(p, width), actual = after.solve(p, width);
      assert.deepEqual(comparable(actual), comparable(expected));
      console.log(JSON.stringify({ operation: dictionary ? "solve-hyphenated" : "solve-plain", words: p.words.length, width,
        candidates_before: expected.candidates, candidates_after: actual.candidates,
        ...paired(() => before.solve(p, width).cost, () => after.solve(p, width).cost) }));
    }
  }
}
if (!(sink > 0)) throw new Error("Benchmark operations were not consumed");
