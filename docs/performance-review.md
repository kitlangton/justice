# Native links and performance follow-up

Measurements in this report were recorded at `6f314b7`, before merging upstream
0.3.2's emergency-scoring change. Use that revision to reproduce these historical
numbers; the new upstream scoring intentionally changes some layouts and costs.

This review compares the local changes with `f4219c3`, the version containing
rich text and synchronized link-hover handlers. No dependency or public API was
added. The initial feature's measurements remain in
[the historical report](rich-performance.md).

## What changed

### Native links across visual lines

The example now maintains the source tag stack across the whole paragraph.
Each source link produces one `<a>`, even when it starts or ends inside a word
or crosses several lines. Text spans remain inline; individual spans carry the
selected line's tracking. Space spans use the measured paragraph font, with
`word-spacing` set to the requested gap minus that font's measured space width.
This supplies the exact gap advance while letting native underlines cross spaces. The first span supplies the optical opening
offset. Generated newlines create presentation-only breaks, with `aria-hidden`.

This removes both pointer listeners, the link-fragment registry, synchronized
hover classes, per-line wrappers, and the border-based underline workaround.
The browser supplies ordinary hover, continuous text decoration, link hit areas,
and one tab stop per source link. Generated hyphens and newlines stay out of
copied source text and accessible link names. The hidden measurement tree also
no longer creates unnecessary wrappers and attributes for generated hyphens.

Rendering still batches a replacement paragraph in a document fragment, and
resize events remain coalesced through `requestAnimationFrame`. Text measurement
is done once, with all measurement writes before reads; resizing reuses the
prepared numerical buffers.

### Faster preparation

Both preparation paths count ASCII graphemes directly. The fast path is safe
because tokenization has already removed ASCII whitespace, including the CRLF
pair that would otherwise count as one grapheme. Unicode still uses
`Intl.Segmenter`, including validation of dictionary break boundaries.

Rich preparation also caches Unicode counts for repeated words and fragments,
and counts Unicode segments without first allocating an array. This cache stores
only numbers, is local to a single preparation, and is released afterwards.
When a word's grapheme count equals its UTF-16 length, every code-unit boundary
is valid, so fragment counts can use offset subtraction directly.

A captured-whitespace `split` replaces `matchAll` token records in rich
preparation. It retains ASCII whitespace normalization, first-whitespace mark
ownership, NBSP, and words crossing mark boundaries. This trades one temporary
token array per input run for fewer match-record allocations. In an isolated
paired experiment it improved preparation another 16–25% and saved eight gzip
bytes compared with the otherwise optimized `matchAll` version.

### Fewer impossible hyphenated candidates

The hyphenated solver previously visited every earlier break. It now stops when
a conservative lower bound proves the remaining starts cannot win. Pruning is
allowed only at whole-word boundaries and only when complete words, continuation
suffixes, and gaps have nonnegative advances after maximum compression. The bound
includes every measure and the largest leading optical allowance. It never
assumes arbitrary shaped fragment widths grow monotonically; unusual metrics
that fail the guards keep the full search.

Independent review found an additional correctness issue in cost pruning for
variable line widths, also present in the old plain solver. A cheap history at
one line index cannot dominate another index that faces different future widths.
Both solvers now require the lower bound to lose against the tight history at
**every target line index**. An unreached state retains infinity and prevents
cost pruning. Two adversarial cases plus 3,000 comparisons with unpruned search
verify this correction. It can require more work for unusual variable-width
inputs, which is necessary to preserve the optimum.

## Size

Both versions were rebuilt using Bun 1.4.2 and esbuild 0.28.2 with the same
production settings. Sizes are bytes, with gzip level 9 and Brotli quality 11.

| Entry | Before minified | After minified | Before gzip | After gzip | Gzip change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Core engine | 9,992 | 10,731 | 4,156 | 4,385 | +229 |
| Optional rich adapter | 2,924 | 3,061 | 1,485 | 1,549 | +64 |
| Static compiler | 1,951 | 1,951 | 982 | 982 | 0 |
| Bundled plain consumer | 8,612 | 9,336 | 3,680 | 3,891 | +211 |
| Bundled rich consumer | 9,922 | 10,761 | 4,217 | 4,465 | +248 |

The two consumer cases use the published modules, minification, and tree shaking.
Plain imports `prepare`, `solve`, and `lineText`; rich imports `prepareRich`,
`solve`, and `lineRuns`. Separate core/rich transfers grow by 293 gzip bytes.
The static module remains byte-for-byte identical. After-change Brotli sizes
are 3,983 / 1,434 / 902 bytes for core / rich / static, and 3,550 / 4,065 for the
plain / rich consumer bundles.

This deliberately spends a small amount of library code on substantial CPU
savings. The rich module remains optional; existing plain consumers also gain
the core preparation and hyphenation improvements. No new runtime dependency,
HTML parser, rendering framework, or dictionary is bundled in the package.

The npm tarball, including README and declarations, changes from 15,089 to
15,643 compressed bytes, or 38,723 to 40,250 unpacked bytes. Its nine-file contents
and exported APIs are unchanged.

For the production browser example (Vite 7.3.6), the rich-specific JavaScript
shrinks from 6,782 to 6,216 minified bytes, or 3,091 to 2,925 gzip bytes. The shared
engine/dictionary chunk grows, so **total JavaScript for the rich page** changes
from 26,233 to 26,298 gzip bytes (+65). Its HTML, including inline styles, shrinks
from 2,338 to 2,235 gzip bytes. Fonts and external CSS are unchanged. Reporting
only the smaller rich-specific chunk would hide that shared-code tradeoff.

## CPU measurements

Machine: Apple M1 Pro, macOS 14.5. These are synthetic shaped-width callbacks,
which isolate preparation and numerical solving from fonts, DOM, layout, and
paint. Workload, runtime, and device affect absolute times. Values below are
median ± median absolute deviation, in milliseconds.

Rich preparation used Bun 1.4.2. The harness warms each case for at least 50 ms,
calibrates approximately 15 ms batches, discards three rounds, then records eleven
rounds with alternating case order. It verifies prepared buffers, extracted runs,
and selected layouts against the saved baseline before timing.

| Rich preparation case | Before | After |
| --- | ---: | ---: |
| 81 mixed ASCII words | 0.2413 ± 0.0131 | 0.0630 ± 0.0021 |
| 324 mixed ASCII words | 0.9922 ± 0.0194 | 0.2718 ± 0.0104 |
| 972 mixed ASCII words | 2.8037 ± 0.1032 | 0.6360 ± 0.0251 |
| 1,000 unique ASCII words | 4.2561 ± 0.1701 | 1.2817 ± 0.0117 |
| 500 repeated Unicode words | 1.2938 ± 0.0942 | 0.2723 ± 0.0213 |
| 500 unique Unicode words | 2.1186 ± 0.1349 | 1.8895 ± 0.0761 |
| 320 words with explicit hyphens | 4.6126 ± 0.1824 | 0.7170 ± 0.0454 |
| 160 dictionary-hyphenated words | 9.4150 ± 0.0811 | 2.1893 ± 0.1014 |
| 100 Unicode dictionary words | 1.7935 ± 0.0871 | 0.9440 ± 0.0551 |

The core comparison ran separately under Node 20.17.0 / V8 11.3.244.8-node.23
and Bun 1.3.10. It alternates 35 ms batches, discards two rounds, and records
eight. The following V8 cases use the same prepared input for both solvers and
assert identical line records and costs; fewer evaluated candidates are expected.

| Hyphenated solve | Before | After | Candidates before → after |
| --- | ---: | ---: | ---: |
| 81 words, 480 px | 0.3706 ± 0.0159 | 0.1879 ± 0.0123 | 2,195 → 1,027 |
| 324 words, 480 px | 12.5637 ± 0.2584 | 1.3310 ± 0.0267 | 94,238 → 9,133 |
| 972 words, 280 px | 132.1468 ± 4.2308 | 2.5766 ± 0.0572 | 1,027,616 → 18,576 |
| 972 words, 480 px | 135.6730 ± 2.1060 | 4.4575 ± 0.1808 | 1,038,230 → 30,789 |
| 972 words, 720 px | 123.7817 ± 1.6534 | 6.3231 ± 0.2251 | 996,238 → 44,548 |

Across all nine lengths/widths, the geometric mean hyphenated-solver speedup was
8.71× in the Bun run and 8.58× in the final V8 run; final V8 cases ranged from
1.55× to 51.29×. Plain solving had unchanged candidate counts. The final V8
run was about 3% slower on geometric mean (individual ratios 0.91–1.01×);
the earlier V8/Bun runs were approximately flat. No plain-solve speedup is
claimed. Plain ASCII preparation improved by a geometric mean 8.41× in final
V8 and 3.18× in Bun; dictionary preparation improved 8.59× and 4.34× respectively.
The final V8 and browser runs include the variable-width guard correction;
the earlier Bun run used
the equivalent scalar-width bound.

## Alternatives considered

- **CSS `:has()` synchronization:** still leaves fragmented anchors, multiple tab
  stops, and a generated rule per link. The native structure removes the cause.
- **Zero-font-size gaps with padding:** preserved geometry but left breaks in
  native underlines. Replaced after close-up visual inspection with spaces in
  the measured paragraph font and an explicit spacing adjustment.
- **Atomic word boxes with a break marker:** cannot preserve one source anchor
  when a link begins or ends inside a word. Inline text with a continuous source
  tag stack handles that case and retains shaping.
- **Single-run slicing shortcut:** added code but extraction timings varied by
  roughly ±10% without a consistent win. Reverted; `lineRuns` remains unchanged.
- **Returning cached or borrowed run arrays:** would change output ownership.
  Callers can still mutate returned wrappers without corrupting preparation or
  later calls; a new regression protects this.
- **Sharing complete prepared words or fragment matrices:** hyphenation may depend
  on the word index, and returned numeric buffers are mutable. The retained caches
  cover measurements and counts without silently changing those semantics.
- **CSS-specific measurement keys:** ignoring link/decoration metadata saved only
  six of 257 fragment requests in the demo. Rejected the extra code and assumptions
  about which CSS properties influence shaping.
- **A trie or nested maps for width keys:** no measured benefit justified the extra
  structures. Length-prefixed keys retain text, mark identity, and generated state.
- **Lazy or per-fragment DOM measurements:** would risk repeated synchronous
  layouts. Kept batched initial reads and zero measurement work on resize.
- **Fewer static-compiler width samples or greedy breaking:** would change the
  selected layout. The static module remains unchanged and benefits from the
  faster shared solver where hyphenation is present.

This is a measured tradeoff, not proof that no faster or smaller implementation
could exist. Peak heap use was not benchmarked; temporary caches and token arrays
are documented above rather than claimed to be free.

## Browser measurements and validation

Chromium 154.0.8037.57 was run against isolated baseline/current Vite servers in
A/B/B/A order, after the final solver correction and underline-spacing change. No other benchmarks ran during
these passes. Each pass discarded an initial load and two resize warmup cycles.
Initial timings start after fonts are ready and finish after forcing layout;
resize timings cover the actual solve/render callback plus forced layout. Paint,
network transfers, and font loading are excluded.

| Measurement | Before | After |
| --- | ---: | ---: |
| Initial preparation, median of 12 loads | 5.15 ms | 3.55 ms |
| Initial render and layout, median | 4.15 ms | 2.40 ms |
| Complete initial composition, median | 9.55 ms | 6.30 ms |
| Desktop resize median, each pass | 2.00 ms | 1.20–1.30 ms |
| Desktop resize p95, each pass | 3.20–4.10 ms | 1.80–1.90 ms |
| Narrow-viewport resize median, each pass | 2.30–2.40 ms | 1.30–1.40 ms |
| Narrow-viewport resize p95, each pass | 3.20–3.30 ms | 2.50–2.60 ms |

Desktop was 1200×900; the narrow viewport was 390×844 on the same Mac, not mobile
hardware. Each pass included 42 actual desktop redraws and 24 narrow redraws at
slider settings 220, 260, 320, 380, 420, 480, and 540 px. Widths clamp to available
space; callbacks that did not redraw were excluded. These timings compare the
complete set of improvements, not the native renderer in isolation.

There were zero measurement-host reads during resizing in every pass. Initial
measurement still reads 258 unique fragments. At 420 px, composed DOM elements
fall from 198 to 196 and anchors from five fragments to two intact source links;
at 220 px they fall from 213 to 208 elements and seven to two anchors.

Validation completed:

- `bun run check:release`: root type checking, all **44 tests**, and package build.
- Site TypeScript checking and production Vite build.
- Built core/rich/static ESM import smoke test under Node 20.17.0. Exported
  declarations compare byte-for-byte with the baseline; static JavaScript also
  compares byte-for-byte.
- Six pruning tests, including 180 independent exhaustive-oracle cases, explicit
  fallback guards, candidate-growth regression, Unicode count oracle, and the
  two variable-width counterexamples. Another 3,000 randomized whole/hyphenated,
  strict/balanced, scalar/variable-width layouts exactly matched unpruned search.
- Eighteen rich tests, including 50 randomized source/style reconstruction cases,
  all ASCII code units, Unicode combining sequences and emoji, fragment counts,
  independent output ownership, and index-sensitive hyphenation.
- Nine rich benchmark corpora checked against baseline prepared buffers and
  extracted runs; scalar core benchmark lines and costs checked against baseline.
- Browser regression script: **84 states**, combining two authored fixtures, two
  viewports, three tracking limits, and seven slider widths. Fixtures include
  nested tags, mixed fonts, mid-word link boundaries, two separate links sharing
  a destination, punctuation, and NBSP.
- Exact source copying, full accessible link names in Chromium's accessibility
  tree, one tab stop per source link, clickable spaces, independent native hover,
  hidden generated characters, and no horizontal overflow. Largest measured
  alignment error was 0.125 CSS px right / 0.01094 px left. Close-up screenshots
  also verify that underlines cross spaces continuously. Accessibility-tree
  inspection is not a claim of testing every screen reader.

## Reproduce

Use the checked-in lockfile. Bun 1.4.2 supports its version-2 format; older Bun
versions may run the benchmark but fail to install that lockfile. Use identical
runtimes and compression settings within every before/after comparison.

```sh
bun install --frozen-lockfile
bun run check:release
bun run --cwd site typecheck
bun --bun run --cwd site build
bun run size
npm pack ./packages/justice --ignore-scripts --dry-run --json

mkdir -p /tmp/justice-before
git show f4219c3:src/engine.ts > /tmp/justice-before/engine.ts
git show f4219c3:src/rich.ts > /tmp/justice-before/rich.ts
bun scripts/bench-rich.ts /tmp/justice-before/engine.ts /tmp/justice-before/rich.ts
bun scripts/bench-core-compare.ts /tmp/justice-before/engine.ts
```

To repeat the V8 comparison, transpile the benchmark and both engine versions
without bundling, then pass their paths explicitly:

```sh
bunx esbuild scripts/bench-core-compare.ts --format=esm --platform=node --target=es2022 --outfile=/tmp/justice-before/bench.mjs
bunx esbuild /tmp/justice-before/engine.ts --format=esm --platform=node --target=es2022 --outfile=/tmp/justice-before/before.mjs
bunx esbuild src/engine.ts --format=esm --platform=node --target=es2022 --outfile=/tmp/justice-before/after.mjs
node /tmp/justice-before/bench.mjs /tmp/justice-before/before.mjs /tmp/justice-before/after.mjs
```

For browser verification, start the Vite development server, open `rich.html` in
a Chromium Playwright CLI session, then run:

```sh
playwright-cli run-code --filename scripts/check-rich-browser.js
playwright-cli run-code --filename scripts/profile-rich-browser.js
```

Both browser scripts use temporary response hooks in isolated test pages; they
never edit application files. The checking script deliberately targets the new
renderer. The profiling script also works with `f4219c3`; serve an isolated copy
of that revision on a second port and run baseline/current/current/baseline while
other CPU-heavy work is idle. The scripts return structured results and include
runtime, widths, callback counts, DOM counts, and measurement counts.
