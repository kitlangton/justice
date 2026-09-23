# @kitlangton/justice

Small, dependency-free paragraph justification engine. ESM with TypeScript declarations.

```sh
bun add @kitlangton/justice
```

## Compose a paragraph

```ts
import { prepare, solve, lineText } from "@kitlangton/justice"

// Supply widths in pixels for the exact font and shaping configuration used to render.
const prepared = prepare(text, measureTextWidth)
const layout = solve(prepared, 620)

for (const line of layout.lines) {
  console.log(lineText(prepared, line), {
    wordSpacing: line.wordSpacing,
    letterSpacing: line.tracking,
    marginLeft: -line.opening,
  })
}
```

`prepare` measures words once and retains prefix sums. Reuse its result across
widths and policy changes. `solve` returns line boundaries, spacing adjustments,
optical allowances, residuals, costs, and a candidate count. Positive residuals
are underfilled; negative residuals are overfull. `defaults` and the `Options`,
`Measure`, `Prepared`, `Line`, and `Layout` types are exported.

## Rich inline text (optional)

```ts
import { solve } from "@kitlangton/justice"
import { prepareRich, lineRuns } from "@kitlangton/justice/rich"

// Marks are your own metadata, including nested formatting and link attributes.
// Reuse identities for repeated styles so measurements can be shared.
const normal = { tags: [] }
const strong = { tags: ["strong"] }
const link = { tags: ["a", "em"], href: "/guide" }
const prepared = prepareRich([
  { text: "Read the ", marks: normal },
  { text: "com", marks: strong },
  { text: "plete", marks: link }, // still one word: "complete"
  { text: " guide.", marks: link },
], measureStyledWord, { space: 4 })

for (const line of solve(prepared, 620).lines) {
  for (const piece of lineRuns(prepared, line)) {
    // piece.kind is "word" or "space"; piece.runs retains the original marks.
    // Shape each word's runs together, using inline text and inline tags.
    // Render a space at this explicit width, regardless of its marks' font:
    const gap = prepared.space + line.wordSpacing + line.tracking
    renderPiece(piece, { gap, letterSpacing: line.tracking })
  }
  // Each line also needs nowrap and its negative line.opening offset.
}
```

`measureStyledWord(runs)` receives a **complete shaped word or fragment**. Render
its runs with the same inline tags, fonts, kerning, and ligatures as the output
and return its advance in pixels, before Justice's tracking adjustment. Do not
sum independently measured runs: formatting or semantic boundaries inside a
word can affect shaping. Finite nonnegative advances are required. The adapter
has no DOM dependency, HTML parser, Markdown parser, fonts, or dictionaries.

**Uniform gaps are part of this API's rendering contract.** `options.space` is
a required positive pixel advance shared by all interword gaps. A space piece
must occupy `prepared.space + line.wordSpacing + line.tracking` pixels. Applying
CSS `word-spacing` to native mixed-font spaces alone is insufficient. Word pieces
use `letter-spacing: line.tracking`; keep their child marks inline so shaping is
consistent with measurement. NBSP remains inside its original word, and must not
receive interword spacing. This contract lets rich input share the numerical
solver, including its pruning and constant-time prefix sums.

ASCII whitespace collapses across run boundaries. The first whitespace in a
collapsed group supplies that gap's marks; paragraph-edge ASCII whitespace is
removed. A formatting boundary never creates a word break. `lineRuns` returns
fresh run wrappers while preserving the original mark identities, including on
partial words. Arbitrary text remains text: render via text nodes or a framework's
escaped text output. Mark interpretation, URL handling, link keyboard behavior,
line height, and DOM integration belong to the renderer.

The browser example keeps the source tag stack open across visual lines. One
source link stays one anchor, including links that start inside a word. Native
CSS handles hover, underline, and one keyboard focus stop per link. Inline text
spans carry each line's tracking; space spans use the measured paragraph font
and adjust word spacing to provide the exact gap advance. Presentation-only newlines and inserted hyphens are
hidden from accessibility, and the copy handler restores source text.

For dictionary hyphenation, pass `hyphenate(word, index)` in `prepareRich`'s options
rather than calling `withHyphenation` afterwards. It must partition the word into
nonempty strings at grapheme boundaries. Source hyphens are retained alongside
dictionary breaks. Every potential fragment is measured using its exact source
offsets and marks. A generated hyphen is a separate final run with
`generated: true` and the preceding character's marks, and is included in the
complete shaped measurement. Keep it out of narration and clipboard source text.
Source runs should not set `generated`; it is output metadata.

`RichPrepared` also works with `compileStatic` and `staticSpacing`. Render each
band's `lineRuns(prepared, staticLine.line)` with the usual `--j-t`, `--j-gap`, and
`--j-left` properties. The adapter measures styled opening quotes and trailing
punctuation. Additional font-specific optical-margin integration belongs to the
caller.

Prepare once after fonts are ready; reuse across width and policy changes.
`solve` and `lineRuns` never call the measurer. Text-plus-mark-identity caches are
local to preparation and then released. Keep marks and measurements stable;
prepare again when text, fonts, styles, or the base space advance change. Browser
measurers should batch their DOM writes and reads; see the complete example in
[`site/src/rich.ts`](../../site/src/rich.ts) (`bun run site`, then `/rich.html`).

The rich entry is opt-in and adds no bytes to the plain-text entry. It exports
`prepareRich`, `lineRuns`, and the `RichRun`, `RichPrepared`, `RichOptions`, and
`RichPiece` types.

## Per-line measures

```ts
solve(prepared, [620 - 32, 620])           // first-line indent of 32px
solve(prepared, [620 - 96, 620 - 96, 620]) // a two-line drop cap
```

A `Measure` is a single width or one width per line; the final entry repeats
for all remaining lines. The solver treats the line index as part of its search
state, so a paragraph is still fitted as a whole. Each returned `line.width`
records the measure it was fitted to. The renderer offsets the narrowed lines
(by the indent, or by the cap's width) itself.

Words containing a hyphen between letters or digits (`well-known`) may break
after the hyphen without adding a glyph; `explicitHyphenPenalty` prices that
choice. Such lines report an `endOffset` but not `hyphenated`.

## Optional hyphenation

```ts
import { prepare, withHyphenation, solve } from "@kitlangton/justice"

const prepared = withHyphenation(
  prepare(text, measureTextWidth),
  hyphenateWord, // e.g. "configuration" → ["con", "fig", "u", "ra", "tion"]
  measureTextWidth,
)
const layout = solve(prepared, 620, {
  hyphenPenalty: 50,
  consecutiveHyphenPenalty: 200,
  finalHyphenPenalty: 200,
  explicitHyphenPenalty: 20, // breaking after a hyphen already in the source
})
```

Supply your language's dictionary and minimum word/prefix/suffix rules through
`hyphenateWord(word, index)`. Return nonempty parts that concatenate exactly to
the input word, or `[word]` to keep it whole. Breaks must respect grapheme
boundaries; NBSP-containing tokens always remain indivisible. No dictionary is
bundled into the numerical core. Measurement receives `(fragment, wordIndex)` so
an adapter can use the corresponding word's font. It measures complete shaped
fragments **including their hyphen**, rather than adding isolated glyph widths.

Whole-word and discretionary breaks compete in the same fitting pass. The
optional path prunes at whole-word boundaries when every added suffix and gap
has nonnegative width after maximum compression. The bound includes the largest
possible leading optical allowance. Unusual metrics that fail these guards use
full search; paragraphs without discretionary breaks retain the whole-word path.
Costs discourage hyphens, consecutive hyphenated lines, and a hyphen before the
final line. Prepared fragment measurements are reused across solves.

Hyphenated layouts retain source word indices. `line.startOffset` and
`line.endOffset` are UTF-16 offsets inside the first/last included word (defaults:
zero and that word's length). `line.hyphenated` requests a visible trailing `-`.
`lineText` returns this **display text**. To reconstruct source, omit the generated
hyphen and join to the next line without a space; ordinary line breaks retain a
space. DOM renderers should keep generated hyphens out of narration and clipboard
text. Naturally fitting final lines still remain ragged.

## Policy

```ts
solve(prepared, 620, {
  mode: "balanced",        // "strict" keeps stretch/shrink limits hard
  stretch: 0.6,
  shrink: 0.25,
  tracking: 0.3,            // maximum pixels per grapheme
  compressionPenalty: 2,
  emergencyStretch: 0.15,  // maximum fallback credit relative to column width
  hanging: 1,               // trailing punctuation allowance
  opening: 0.3,             // leading quote allowance
  protrusion: 1,            // strength of supplied font-aware optical margins
  adjacentPenalty: 100,     // discourage abrupt tight/loose neighbour transitions
  lastLine: 0.33,
  ending: "fit",           // "soft" uses a width-relative ending penalty
  widowPenalty: 300,
})
```

Balanced mode first tries ordinary fitting, then relaxes stretch scoring if
necessary. Shrink and tracking remain bounded. Naturally fitting final lines
remain ragged. Opening quotes and trailing punctuation can sit beyond the nominal
margin by their measured allowances.

Emergency fitting adds scoring credit up to `width * emergencyStretch`, capped
at one measured natural space per inter-word gap. The scoring denominator is at
least one natural space, including lines with no gaps. This keeps sparse lines
with enormous spaces expensive rather than treating the entire column as extra
spacing capacity. The credit changes which breaks win, not the rendering limits:
balanced mode can still expand spaces when no better complete layout exists.

The solver retains four line fitness classes (tight, decent, loose,
very loose) at each break. A jump of more than one class adds `adjacentPenalty`.
This cost participates in the paragraph search, including hyphenated layouts;
it is not a spacing adjustment applied afterwards. Set it to zero for independent
line scoring and a single fitness state. `line.fitness` exposes the selected
class as 0–3; each returned `line.cost` includes its incoming adjacency cost.

## Font-aware optical margins

```ts
import { withOpticalMargins } from "@kitlangton/justice"

// Apply after withHyphenation, if used. Return absolute pixel allowances for
// the actual face at each edge. Measurement is supplied by the consumer.
const optical = withOpticalMargins(prepared, (text, wordIndex) =>
  measureFontEdges(text, wordIndex))
const layout = solve(optical, 620)
```

The callback is called for full words, continuation suffixes, and the generated
hyphen. Its nonnegative `start` credit replaces the quote-only allowance;
its `end` credit combines with punctuation hanging by taking the larger value.
Set `protrusion: 0` to disable these supplied optical credits while keeping
punctuation hanging. Plain `prepare` inputs retain their quote/punctuation model.
Both solvers include the optical allowances when choosing breaks. Whole-word
overflow pruning accounts for the largest possible leading allowance.

The core accepts numerical measurements; it does not include a browser rasterizer.
A consumer can supply an ink-profile measurer for its font (for example, sampling
glyph edges on a canvas) and pass the resulting allowances here.

## Build-time compilation

```ts
import { compileStatic, staticSpacing } from "@kitlangton/justice/static"

const bands = compileStatic(prepared, 320, 960)   // sample every px from min to max
const shared = staticSpacing(prepared)            // CSS custom properties, once per paragraph
```

`compileStatic` solves the paragraph at each sampled measure and coalesces
adjacent identical break plans into half-open bands `{ min, max, lines }`.
Within a band the breaks are fixed and the spacing is expressed as CSS `calc()`
against the container width, so a static page needs no script at runtime: emit
one container query per band, render each band's lines as words and gaps
carrying the band's `properties`, and declare `staticSpacing` on the paragraph.
Bind `--j-t` to `letter-spacing`, `--j-gap` to a gap's width, and `--j-left` to
the first word's horizontal offset. A band whose `lines` is `null` did not fit
at that measure; keep native wrapping there.

Sampling is explicit: unsampled fractional widths are not promised the same
optimum as their neighbours. Measure with the fonts the page will load; a late
font swap invalidates the compiled plan exactly as it would a live one.

## Rendering contract

The package is the numerical engine; it does not measure browser text or manage
the DOM. Render each line separately with wrapping disabled and apply its
`wordSpacing`, `tracking`, and negative `opening` offset. Width predictions assume
that letter spacing contributes once per grapheme, including ordinary spaces.
Nonbreaking spaces stay inside a word and should not receive interword spacing.
Measure and render with the same kerning and ligature settings so the measured
words compose predictably.

Process paragraphs and explicit hard-break segments separately. Supported input
is horizontal LTR, space-delimited text. `prepare` handles single-font plain text;
`prepareRich` handles inline styled runs under its explicit-gap contract above.
HTML/Markdown parsing, inline images, bidi/CJK breaking, and automatic vertical
layout are outside this version's scope.

The core can execute during SSR or a Cloudflare build/Worker request when supplied
matching measurements and a known width. Font measurement, responsive-width
selection, and SSR markup integration belong to the caller.

Requires an ECMAScript 2022 runtime with `Intl.Segmenter`.
