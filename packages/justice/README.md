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
`Measure`, `Run`, `Prepared`, `Line`, and `Layout` types are exported.

## Styled runs

```ts
const prepared = prepare([
  { text: "Run " },
  { text: "bun\u00a0run\u00a0check", style: "code" }, // NBSP: this run never wraps
  { text: " before you push." },
], (text, style) => measureTextWidth(text, style === "code" ? mono : sans))
```

Pass runs instead of a string to mix fonts, links, or inline code in one
paragraph. Their joined text is the paragraph: ASCII whitespace may break, and a
word may span runs ("`code`," is one word). Each piece of a word is measured
with its own run's `style`, and measurements are cached by style and text, so
the same word in two fonts gets two widths. Interword spaces take the style of
the paragraph's first space. Use NBSP for spaces that must not wrap.

`prepared.starts[i]` is the UTF-16 offset of word `i` in the joined text, so a
renderer can map breaks back onto its own markup. A line covers
`starts[line.start] + (line.startOffset ?? 0)` to
`starts[line.end - 1] + (line.endOffset ?? words[line.end - 1].length)`; the
whitespace after word `i` ends at `starts[i + 1]`.

## Line count

```ts
solve(prepared, 620, { lines: "ragged" }) // as many lines as text-align: left
solve(prepared, 620, { lines: 6 })        // exactly six
```

Paragraph-wide fitting can set a paragraph in fewer lines than the browser's
ragged setting, which moves everything after it. `lines` asks for the best layout
with exactly that many lines, like TeX's `\looseness`, at the width you render
at, so the reported spacing and residuals need no correction. `"ragged"` counts a
first-fit, whole-word setting at natural spacing. A count the paragraph can't
fill (more lines than break opportunities) returns the unconstrained optimum;
check `layout.lines.length`. Fewer lines than fit naturally are set overfull and
reported through negative residuals.

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
With styled runs, hyphenate only words set in one style (find a word's run from
`prepared.starts[index]`) and return `[word]` for the rest.

### English

```ts
import { hyphenate, hyphenator } from "@kitlangton/justice/english"

withHyphenation(prepared, hyphenate, measureTextWidth)
withHyphenation(prepared, hyphenator({ minWord: 8, left: 3, right: 3 }), measureTextWidth)
```

A separate entry, about 17 KB gzipped, that the core never imports: Liang's
algorithm with TeX's American English patterns and exception list (hyph-utf8's
`hyph-en-us`, by Gerard D.C. Kuiken, free to copy with its notice, which the
entry keeps). `hyphenate` uses TeX's limits: words of five letters or more, two
letters before a break and three after. Leading and trailing punctuation stays
on the edge fragments, and each letter run between source hyphens or apostrophes
is hyphenated on its own. Words with digits, symbols, inner capitals (code,
acronyms, URLs) or non-ASCII letters stay whole.

Whole-word and discretionary breaks compete in the same fitting pass. The
optional path searches the expanded break graph without overflow pruning;
paragraphs with no discretionary breaks retain the pruned whole-word path.
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
is horizontal LTR, space-delimited text, plain or as styled runs, with optional
supplied hyphenation and supplied glyph-specific optical margins. Parsing markup
and bidi/CJK breaking are outside this version's scope.

The core can execute during SSR or a Cloudflare build/Worker request when supplied
matching measurements and a known width. Font measurement, responsive-width
selection, and SSR markup integration belong to the caller.

Requires an ECMAScript 2022 runtime with `Intl.Segmenter`.
