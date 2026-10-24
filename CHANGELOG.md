# Changelog

## 0.4.0

- `prepare` accepts styled runs, `[{ text, style }]`, as well as plain text.
  Words may span runs; each piece is measured with its run's style, and the
  measurement cache is keyed by style and text, so one word in two fonts gets
  two widths. Plain-text calls are unchanged.
- `Prepared.starts` records each word's UTF-16 offset in the source text, so a
  renderer can map lines, gaps, and hyphenated breaks back onto its own markup.
- Add the `lines` option: `lines: 6` sets exactly six lines and
  `lines: "ragged"` as many as a first-fit ragged setting, like TeX's
  `\looseness`. Callers no longer re-solve at narrower widths to keep a
  paragraph's height, so the reported spacing is for the width they render at.
- Add `@kitlangton/justice/english`: `hyphenate` and `hyphenator(options)`,
  Liang's algorithm with TeX's American English patterns and exceptions
  (hyph-utf8), as a separate entry the core never imports.
- Cost pruning with per-line measures compares an overfull candidate against
  every line index it could land on, not the cheapest one. Thanks to the
  analysis in #1 for spotting this.

## 0.3.2

- Bound emergency-fitting credit by the number of word spaces on each line.
  Sparse lines with extremely large gaps no longer receive the same credit as
  densely populated lines just because they share a column width. This changes
  some balanced-mode line breaks, including the static compiler's output.
- Add a measured mobile article regression and a narrow-column site example.

## 0.3.1

- License the package under MIT and include the license in the published tarball.

## 0.3.0

- `solve` accepts a `Measure`: a single width or one width per line with the
  final entry repeating. This fits first-line indents and drop caps as part of
  the paragraph-wide optimum. Each `Line` now records its `width`.
- Words with a hyphen between letters or digits may break after it without a
  generated glyph, priced by the new `explicitHyphenPenalty` (default 20).
  `withHyphenation` merges dictionary breaks with these source hyphens.
- Add a `static` entry with `compileStatic` and `staticSpacing` for build-time
  responsive output.

## 0.2.0

- Add optional dictionary-supplied hyphenation through `withHyphenation`, with
  exact shaped-fragment measurements and penalties for consecutive hyphens and
  a hyphen before the final line.
- Add `withOpticalMargins` for supplied font-aware margins on words, continuation
  fragments, and generated hyphens. The core remains DOM-free and dependency-free.
- Retain four spacing-fitness histories at each break. The new default
  `adjacentPenalty: 100` discourages abrupt tight/loose line transitions; set it to
  zero for independent line scoring.
- Expose source offsets, discretionary-hyphen flags, and line fitness in layouts.
  `lineText` returns display text, including a generated hyphen when requested.
- Verify both fitting passes against exhaustive partitions, including optical
  credits, non-additive shaping, and neighbouring-line penalties.

The new fitness policy can change existing line breaks and uses more solver CPU.
Font measurement, dictionary selection, source-safe copying, and rendering remain
the consumer's responsibility. The package does not include the article's browser
rasterizer or DOM adapter.

## 0.1.0

- Initial numerical paragraph engine: reusable measurements, paragraph-wide
  fitting, bounded shrink/tracking, relaxed word spacing, fit-aware endings,
  punctuation hanging, and opening-quote allowances.
