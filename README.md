# justice.

A small, dependency-free paragraph justification engine for the web, published
as [`@kitlangton/justice`](https://www.npmjs.com/package/@kitlangton/justice).

The solver is a total-fit line breaker in the tradition of Knuth and Plass's
algorithm from TeX: every break in a paragraph is chosen together to minimize a
paragraph-wide cost, rather than greedily line by line. Justice keeps the ideas
that matter for screen typography — cubic strain, four line-fitness classes with
an adjacency penalty, hyphen penalties, and an emergency-stretch second pass —
and drops the parts that only make sense for a batch typesetter. The result is a
core of about 4 KB gzipped.

```sh
bun add @kitlangton/justice
```

## What it does

```ts
import { prepare, solve, lineText } from "@kitlangton/justice"

const paragraph = prepare(text, measureTextWidth) // measure once
const layout = solve(paragraph, 620)              // solve at any width

for (const line of layout.lines) {
  lineText(paragraph, line)
  line.wordSpacing    // CSS word-spacing delta in px
  line.tracking       // CSS letter-spacing in px
  line.hanging        // optical margin allowance in px
  line.opening        // left quote allowance; render at -line.opening
  line.residual       // positive: underfilled; negative: overfull
}
```

- **Measured input, numerical output.** You supply word widths for the exact
  font and shaping you render with; the engine returns line boundaries and CSS
  spacing values. No DOM access, no bundled fonts or dictionaries.
- **Exact optimum.** A prefix-sum dynamic program over word boundaries finds the
  minimum-cost layout, with admissible pruning to skip hopeless candidates.
- **Bounded adjustments.** Word spacing stretches and shrinks within configured
  limits; letter spacing is capped per grapheme. Balanced mode can relax word
  spacing to complete a line; strict mode keeps the limits hard.
- **Optical margins.** Trailing punctuation hangs past the right margin and
  opening quotes receive a leading allowance by default. `withOpticalMargins`
  accepts font-aware edge measurements from an adapter.
- **Per-line measures.** Pass one width per line (`[w - indent, w]`) for a
  first-line indent or a drop cap; the last entry repeats. This is TeX's
  `\parshape`, and the paragraph is still fitted as a whole.
- **Optional hyphenation.** `withHyphenation` takes dictionary-supplied breaks,
  measures each fragment as a shaped unit including its hyphen, and prices
  discretionary, consecutive, and final-line hyphens. Words like *well-known*
  may break after their existing hyphen.
- **Fitness-aware.** Each break retains tight/decent/loose/very-loose histories
  so abrupt spacing changes between neighbouring lines cost extra.
- **Static output.** `@kitlangton/justice/static` precomputes break plans across
  a range of measures and coalesces them into bands for build-time rendering.
- **Rich inline text.** The optional `@kitlangton/justice/rich` entry retains
  links, bold, italic, and arbitrary nested marks across breaks and hyphenation.
  Supply shaped word measurements and render explicit uniform gaps. Try the
  browser example at `/rich.html` with `bun run site`.

The full API — options, hyphenation, optical margins, the rendering contract,
and static compilation — is documented in
[`packages/justice/README.md`](packages/justice/README.md).

## Scope

Horizontal LTR, space-delimited text. Use `prepare` for plain text or the optional
rich adapter for styled runs with explicit uniform interword gaps. Pass each
paragraph and hard-break segment separately. HTML/Markdown parsing, inline images,
CJK break rules, bidi layout, and variable-font expansion are out of scope.
Requires an ECMAScript 2022 runtime with `Intl.Segmenter`.

## Develop

```sh
bun install
bun run typecheck
bun run test      # exhaustive-partition oracles for whole-word and hyphenated layouts
bun run bench     # solver timing on synthetic advances
bun run bench:rich # preparation, resizing, and rich line extraction timings
bun run build     # compiles packages/justice/dist
bun run size      # minified, gzip, and Brotli bytes per built entry
bun run site      # the site, at http://127.0.0.1:5173
```

`src/engine.ts` is the solver; `src/static.ts` is the build-time band compiler;
`src/rich.ts` is the optional inline formatting adapter. All are packaged from
`packages/justice`.

`site/` is [justice.kitlangton.com](https://justice.kitlangton.com): a Vite
app that imports the engine source directly and sets each example paragraph
three ways, side by side. Its build also generates the agent-readable documents
(`llms.txt`, `docs.md`, `types.d.ts`, `changelog.md`) from the package, and
`bun run site:deploy` publishes `site/dist` to Cloudflare Pages.

## Release

Releases publish from GitHub Actions with npm trusted publishing (OIDC); no
token or one-time password is involved. Update the version in
`packages/justice/package.json` and `CHANGELOG.md`, commit, then:

```sh
bun run check:release
npm pack ./packages/justice --dry-run   # inspect the tarball
git tag v0.3.1 && git push origin main v0.3.1
```

`.github/workflows/release.yml` runs the checks, verifies the tag matches the
package version, and publishes. Only the compiled core, declarations, package
README, and manifest are included in the tarball.

## License

MIT
