# Rich text: initial size and performance review

This report records the initial rich-text implementation through commit
`f4219c3`. For the subsequent native-link renderer and core/preparation
optimizations, see [the follow-up performance review](performance-review.md).

The optional `@kitlangton/justice/rich` entry adds marked inline runs while
leaving the existing plain-text solver and static compiler unchanged. The
baseline is upstream commit `dfea73bee1b00ec30a75afc23e1c71e6c984b1de`.

## Size

Measured with Bun 1.4.2 and esbuild 0.28.2, using the repository's production
build. All values are bytes; gzip uses level 9 and Brotli uses quality 11.
Each file is compressed separately, matching separate module transfers.

| Entry | Baseline minified | Current minified | Baseline gzip | Current gzip | Baseline Brotli | Current Brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `engine.js` | 9,992 | 9,992 | 4,156 | 4,156 | 3,786 | 3,786 |
| `static.js` | 1,951 | 1,951 | 982 | 982 | 902 | 902 |
| `rich.js` | — | 2,924 | — | 1,485 | — | 1,370 |

The existing engine and static files are byte-for-byte identical to their
baseline builds, not merely equal in length. Their SHA-256 values are:

```text
engine.js  37b355e636fb940ab2f81ee11e8fe1dc6b7aa39b351eedc279e1de4c46a1a027
static.js  61c88b1b84b3d9de3cb2e69fe3f650490afc7ab486e06df29cac5fe3c9f80102
```

Existing consumers do not import the rich entry, so they receive no extra
JavaScript. The adapter has no runtime imports or new dependencies; rich users
reuse the same engine. The package retains `sideEffects: false` so consumers can
also remove unused exports when bundling. A separate engine and rich-module
transfer totals 5,641 gzip bytes; a consumer bundler can compress them together
and produce a different total.

For example, bundling representative consumers of the built package with
esbuild, ESM, ES2022, minification, and tree shaking gives:

| Consumer exports | Minified | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Plain: `prepare`, `solve`, `lineText` | 8,612 | 3,680 | 3,365 |
| Rich: `prepareRich`, `solve`, `lineRuns` | 9,922 | 4,217 | 3,853 |

This rich consumer costs 537 additional gzip bytes. It drops the plain
preparation helper, and both consumers drop unused engine exports. The exact
difference depends on which functions an application uses and its bundler.
`scripts/size.ts` reproduces both cases from the actual built package files.

The complete npm tarball grew from 11,914 to 15,089 compressed bytes, and from
29,564 to 38,723 unpacked bytes. This includes the expanded package README,
declarations, and export metadata as well as executable code. Tarball size is
an install cost, not the JavaScript download for a plain-text page.

## CPU measurements

Recorded on an Apple M1 Pro, macOS 14.5, Bun 1.4.2. The benchmark uses 81, 324,
and 972 words, four reused mark identities, and some style boundaries inside
words. Synthetic width measurement isolates preparation and solver CPU from
font loading, browser shaping, layout, painting, and DOM updates. It does not
predict total browser rendering time.

Each case warms up for at least 50 ms, calibrates batches to approximately
15 ms, discards three additional warmup rounds, and reports the median of
eleven rounds. Case order alternates between rounds. Values below are
**median ± median absolute deviation**, in milliseconds per paragraph.

| Words | Plain preparation | Single-style rich preparation | Mixed-style rich preparation |
| ---: | ---: | ---: | ---: |
| 81 | 0.1902 ± 0.0093 | 0.2038 ± 0.0079 | 0.2182 ± 0.0100 |
| 324 | 0.7237 ± 0.0232 | 0.7755 ± 0.0441 | 0.9607 ± 0.0295 |
| 972 | 2.1121 ± 0.0740 | 2.2387 ± 0.1408 | 2.6798 ± 0.0315 |

Representative repeated solves at a width of 480 px, after preparation:

| Words | Plain solve | Single-style rich solve | Mixed-style rich solve | Extract all mixed line runs |
| ---: | ---: | ---: | ---: | ---: |
| 81 | 0.0365 ± 0.0006 | 0.0368 ± 0.0006 | 0.0272 ± 0.0007 | 0.0044 ± 0.0001 |
| 324 | 0.2357 ± 0.0035 | 0.2334 ± 0.0039 | 0.2118 ± 0.0028 | 0.0211 ± 0.0009 |
| 972 | 0.7736 ± 0.0271 | 0.7781 ± 0.0209 | 0.7992 ± 0.0192 | 0.0688 ± 0.0022 |

Mixed styles change measured widths and therefore candidate counts and selected
breaks; their solve times should not be interpreted as a solver speedup. The
single-style rich and plain cases have identical numerical layouts. The script
checks this at 280, 480, and 720 px for all three paragraph lengths, and can
check equality against an independently imported baseline engine.

The optional baseline timing controls exercise both plain and rich object shapes
in both imported engines. Identical engine code can still show a few percent
difference between module instances because of JIT compilation, allocation, and
machine load. Byte equality is the stronger evidence that plain-only consumers
retain exactly the previous implementation; these timings are not a claim of
an improvement to the solver.

## Choices behind the result

- Preparation retains complete words across mark boundaries. It gives the
  caller a complete rich word or hyphenated fragment to shape, avoiding incorrect
  sums of independently shaped fragments.
- Widths are cached by text and mark identity during preparation. Equal adjacent
  marks are coalesced. The single-style cases make 70 measurement calls at every
  paragraph length; mixed cases make 82, 288, and 404 calls, including punctuation
  measurements. Reuse mark objects to obtain this cache reuse.
- The prepared object has the engine's existing prefix sums and numerical
  buffers. Resizing calls the existing solver without remeasuring text.
- `lineRuns` scans only the selected words and slices them by source offsets.
  It neither searches the original paragraph nor invokes the measurer.
- Ordinary words without explicit or requested hyphenation skip the break
  regular expression iterator and two temporary sets. An isolated before/after
  experiment reduced rich preparation from 0.238 to 0.205 ms for 81 words,
  0.892 to 0.799 ms for 324 words, and 2.580 to 2.362 ms for 972 words. This
  improvement costs 26 minified bytes or 11 gzip bytes; the measured tradeoff
  favors this fast path.
- The package accepts caller-owned marks instead of bundling an HTML parser,
  sanitizer, DOM traversal layer, or rendering framework. Links, nested emphasis,
  and other inline metadata therefore need no runtime dependencies.
- The browser example shares hover state across fragments of the same source
  link, using mark identity rather than the destination URL. Hover updates only
  change the affected anchors' classes; they do not measure text or run the solver.
  This behavior lives in the example and adds no bytes to the published package.

The engine still assumes a single positive interword advance. A rich renderer
must render explicit gaps at `space + line.wordSpacing + line.tracking`, using
the supplied base `space` even when adjacent fonts have different native space
widths. Each word's runs must remain in a shared shaping context. The package
README and browser example show this contract; arbitrary HTML layout, inline
images, bidi layout, and hard-break handling inside a paragraph are outside this
adapter's scope.

This is a measured size/speed tradeoff, not a proof that no smaller or faster
implementation could exist. Actual text, fonts, callbacks, devices, and browser
renderers should be measured for an application.

## Validation

The baseline release check passed all 20 existing tests. The updated release
check passes all 34 tests, including 14 rich-text tests. These cover nested marks
and links, words spanning mark boundaries, measurement cache identity,
punctuation, explicit and discretionary hyphenation, generated hyphens,
nonbreaking spaces, Unicode graphemes, validation failures, static compilation,
and 50 deterministic randomized cases using actual strict and balanced solves
at multiple widths.

`bun run check:release` passes type checking, the test suite, and the package
build. Site type checking and the production site build pass. A built-package
smoke test using Node 20 successfully imports and exercises the core, rich, and
static ESM entry points. Byte comparisons confirm that the built core and
static files match the baseline exactly.

The `/rich.html` example was also checked using Playwright CLI with Chromium
154.0.8037.57, at 1200×900 and 390×844 viewports on the same Mac (the latter
simulates a mobile viewport, not mobile hardware). The width slider was exercised
at 220, 260, 320, 380, 420, 480, and 540 px, clamped to the available column width.
Checks confirmed nested bold/italic, code, small capitals, underline, mid-word
marks, link destinations, keyboard focus, and clickable link spaces. Visual
checks also verified continuous link underlines across the explicit gaps: the
example draws the rule on each grouped semantic wrapper, rather than each word.
Hover checks cover the first and last fragments, word gaps, nested bold text,
pointer exit, and resizing under a stationary pointer. All fragments of one
source link highlight together; an additional fixture confirms that distinct
links sharing a URL remain independent.
Clipboard text matched the source, including NBSP and source hyphens, while generated
hyphens were excluded. There was no horizontal overflow and no console error or
warning. The largest measured right-edge error after accounting for punctuation
hanging was 0.15625 CSS px, within fractional-pixel rounding.

Across 56 width changes per viewport, no measurement-host reads occurred. The
browser's solve-and-render callback, including rebuilding the hover groups, took
1.4 ms median / 3.0 ms p95 at the desktop viewport and 0.9 ms / 2.7 ms at the
narrower viewport. These timings include DOM
construction but exclude the later browser paint. Initial batched width reads
for 258 fragments took 1.4 ms; insertion through the first composed DOM took
6.2 ms, excluding request collection, font loading, and network time. These
single-machine observations supplement the synthetic CPU benchmark above.

## Reproduce

Use the same dependency lockfile and runtime for before/after comparisons.
Bun 1.4.2 understands the checked-in version-2 lockfile; the installed Bun 1.3.10
used during the initial attempt did not. Different gzip implementations can
produce slightly different sizes even at the same compression level.

```sh
bun install --frozen-lockfile
bun run check:release
bun run --cwd site typecheck
bun --bun run --cwd site build
bun run size
git show dfea73bee1b00ec30a75afc23e1c71e6c984b1de:src/engine.ts > /tmp/justice-baseline-engine.ts
bun scripts/bench-rich.ts /tmp/justice-baseline-engine.ts
npm pack ./packages/justice --ignore-scripts --dry-run --json
bun run site # open /rich.html to exercise the browser example
```

`scripts/size.ts` reports exact bytes and SHA-256 hashes for every built entry
and the two example consumer bundles.
`scripts/bench-rich.ts` also runs without the optional baseline path. It prints
machine-readable results including runtime, iteration counts, measurement call
counts, all three widths, and a checksum that consumes benchmark outputs.
