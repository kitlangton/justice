/** Justice's DOM-free paragraph engine, with optional measured hyphenation. */
export interface Options {
  /** Relative to measured space. Stretch may relax; shrink always stays bounded. */
  stretch: number;
  shrink: number;
  mode: "balanced" | "strict";
  /** Absolute pixels per character. */
  tracking: number;
  /** Cost multiplier for tightening a line rather than opening its spacing. */
  compressionPenalty: number;
  /** Maximum extra scoring flexibility as a fraction of width, capped at one
   * natural space per gap, when ordinary fitting fails. */
  emergencyStretch: number;
  /** Fraction of trailing punctuation advance allowed beyond the right margin. */
  hanging: number;
  /** Optical allowance for a leading quote, as a fraction of its advance. */
  opening: number;
  /** Strength of supplied font-aware optical margins (0 disables them). */
  protrusion: number;
  /** Cost when neighbouring line fitness classes differ by more than one. */
  adjacentPenalty: number;
  /** Preferred fraction of the measure occupied by the last line. */
  lastLine: number;
  /** Price a short ending by missing width alone, or by its measured flexibility. */
  ending: "soft" | "fit";
  widowPenalty: number;
  /** Costs for discretionary, consecutive, and penultimate-line hyphens. */
  hyphenPenalty: number;
  consecutiveHyphenPenalty: number;
  finalHyphenPenalty: number;
  /** Cost of breaking after a hyphen already present in the source ("well-known"). */
  explicitHyphenPenalty: number;
}

export const defaults: Options = {
  stretch: 0.6, shrink: 0.25, mode: "balanced", tracking: 0.3, compressionPenalty: 2, emergencyStretch: 0.15, hanging: 1, opening: 0.3, protrusion: 1, adjacentPenalty: 100, lastLine: 0.33, ending: "fit", widowPenalty: 300, hyphenPenalty: 50, consecutiveHyphenPenalty: 200, finalHyphenPenalty: 200, explicitHyphenPenalty: 20,
};

/** A single column width, or one width per line with the final entry repeating.
 * Use an array for a first-line indent (`[w - indent, w]`) or a drop cap
 * (`[w - cap, w - cap, w - cap, w]`). */
export type Measure = number | readonly number[];

export interface Prepared {
  words: string[];
  widths: Float64Array;
  characters: Float64Array;
  /** Per-word advance of a trailing punctuation run, not a prefix sum. */
  endHangs: Float64Array;
  startHangs: Float64Array;
  /** Optional absolute-pixel optical credits. Start replaces quote-only credit;
   * end combines with punctuation hanging by taking the larger allowance. */
  startProtrusions?: Float64Array;
  endProtrusions?: Float64Array;
  space: number;
  /** Optional measured discretionary breaks; ordinary words retain the fast path. */
  hyphenation?: readonly (WordFragments | undefined)[];
}

export interface WordFragments {
  /** UTF-16 source offsets, including zero and the word's length. */
  offsets: readonly number[];
  /** Square matrices indexed by start * offsets.length + end. */
  widths: Float64Array;
  hyphenWidths: Float64Array;
  characters: Float64Array;
  /** Leading credit at each source boundary, plus the generated hyphen's end. */
  startProtrusions?: Float64Array;
  hyphenProtrusion?: number;
  /** Per boundary: true when the source already ends in a hyphen there, so a
   * break renders no additional glyph. */
  explicit?: readonly boolean[];
}

export interface Line {
  start: number;
  end: number;
  /** The measure this line was fitted to. */
  width: number;
  natural: number;
  wordSpacing: number;
  tracking: number;
  /** Available optical margin credit; a ragged last line need not use it. */
  hanging: number;
  opening: number;
  residual: number;
  /** True when finishing used word spacing beyond the preferred limits. */
  relaxed: boolean;
  cost: number;
  last: boolean;
  /** Source offsets within the first/last included word; omitted for whole words. */
  startOffset?: number;
  endOffset?: number;
  /** Render a discretionary '-' after the source text, without adding it to the source. */
  hyphenated?: boolean;
  /** 0 tight, 1 decent, 2 loose, 3 very loose; based on unbounded fitting strain. */
  fitness?: number;
}

export interface Layout {
  lines: Line[];
  cost: number;
  candidates: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Words exclude ASCII whitespace, so ASCII fragments cannot contain the CRLF
// pair that would otherwise make two ASCII code units share one grapheme.
const ascii = (text: string) => !/[^\x00-\x7f]/.test(text);
const charactersIn = (text: string) => ascii(text) ? text.length : [...graphemes.segment(text)].length;

/** Measure once; reuse the prepared paragraph across widths and policy changes.
 * ASCII whitespace collapses; NBSP remains inside an indivisible word.
 * Pass each hard-break-delimited segment separately.
 */
export function prepare(text: string, measure: (text: string) => number): Prepared {
  const words = text.trim().split(/[ \t\r\n\f]+/).filter(Boolean);
  const widths = new Float64Array(words.length + 1);
  const characters = new Float64Array(words.length + 1);
  const endHangs = new Float64Array(words.length);
  const startHangs = new Float64Array(words.length);
  const cache = new Map<string, number>();
  const widthOf = (text: string) => {
    let w = cache.get(text);
    if (w === undefined) {
      w = measure(text);
      if (!Number.isFinite(w) || w < 0) throw new RangeError("Invalid measured word width");
      cache.set(text, w);
    }
    return w;
  };
  const space = widthOf(" ");
  if (space <= 0) throw new RangeError("Space width must be positive");
  let hyphenation: (WordFragments | undefined)[] | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const w = widthOf(word);
    const punctuation = word.match(/[.,;:!?…’”'"]+$/u)?.[0];
    if (punctuation) endHangs[i] = Math.min(w, widthOf(punctuation));
    const quote = word.match(/^[“‘"'«‹]/u)?.[0];
    if (quote) startHangs[i] = Math.min(w, widthOf(quote));
    widths[i + 1] = widths[i] + w;
    characters[i + 1] = characters[i] + charactersIn(word);
    const explicit = explicitHyphens(word);
    if (explicit.length) {
      hyphenation ??= [];
      hyphenation[i] = fragments(word, w, [0, ...explicit, word.length], new Set(explicit), widthOf);
    }
  }
  const p: Prepared = { words, widths, characters, endHangs, startHangs, space };
  if (hyphenation) { hyphenation.length = words.length; p.hyphenation = hyphenation; }
  return p;
}

/** Offsets just after a hyphen joining two letters or digits; browsers and TeX
 * both allow a break there without adding a glyph. */
function explicitHyphens(word: string): number[] {
  if (word.includes("\u00a0")) return [];
  return [...word.matchAll(/(?<=[\p{L}\p{N}])[-\u2010](?=[\p{L}\p{N}])/gu)].map(m => m.index + 1);
}

function fragments(word: string, wordWidth: number, offsets: readonly number[], explicitAt: ReadonlySet<number>,
  widthOf: (text: string) => number): WordFragments {
  const n = offsets.length;
  const widths = new Float64Array(n * n), hyphenWidths = new Float64Array(n * n), characters = new Float64Array(n * n);
  const explicit = offsets.map(offset => explicitAt.has(offset));
  for (let from = 0; from < n - 1; from++) for (let to = from + 1; to < n; to++) {
    const text = word.slice(offsets[from], offsets[to]), cell = from * n + to;
    widths[cell] = from === 0 && to === n - 1 ? wordWidth : widthOf(text);
    if (to < n - 1) hyphenWidths[cell] = explicit[to] ? widths[cell] : widthOf(text + "-");
    characters[cell] = charactersIn(text);
  }
  return { offsets, widths, hyphenWidths, characters, explicit: explicit.some(Boolean) ? explicit : undefined };
}

/** Add optional dictionary-supplied breaks without changing source words.
 * Measure every legal fragment as a shaped unit, including its visible hyphen.
 * The word index lets adapters preserve the source word's font/style.
 * Breaks after source hyphens found by `prepare` are retained alongside.
 */
export function withHyphenation(p: Prepared,
  hyphenate: (word: string, index: number) => readonly string[],
  measure: (text: string, index: number) => number): Prepared {
  const hyphenation = p.words.map((word, index): WordFragments | undefined => {
    const existing = p.hyphenation?.[index];
    if (word.includes("\u00a0")) return existing;
    const parts = hyphenate(word, index);
    if (!parts.length || parts.some(part => !part.length) || parts.join("") !== word) throw new RangeError("Hyphenation must partition the source word");
    if (parts.length === 1) return existing;
    const boundaries = ascii(word) ? undefined : new Set([...graphemes.segment(word)].map(part => part.index));
    const offsets = [0];
    for (const part of parts) offsets.push(offsets.at(-1)! + part.length);
    if (boundaries && offsets.slice(1, -1).some(offset => !boundaries.has(offset))) throw new RangeError("Hyphenation must not split a grapheme");
    const explicitAt = new Set(existing?.offsets.filter((offset, i) => existing.explicit?.[i]) ?? []);
    const merged = [...new Set([...offsets, ...explicitAt])].sort((a, b) => a - b);
    const cache = new Map<string, number>();
    const widthOf = (text: string) => {
      let width = cache.get(text);
      if (width === undefined) {
        width = measure(text, index);
        if (!Number.isFinite(width) || width < 0) throw new RangeError("Invalid measured fragment width");
        cache.set(text, width);
      }
      return width;
    };
    return fragments(word, p.widths[index + 1] - p.widths[index], merged, explicitAt, widthOf);
  });
  return { ...p, hyphenation };
}

/** Attach font-aware edge measurements after preparing optional hyphenation.
 * The callback receives full words, continuation suffixes, and the generated '-'.
 * The numerical core never measures or rasterizes a font itself.
 */
export function withOpticalMargins(p: Prepared,
  measure: (text: string, wordIndex: number) => { start: number; end: number }): Prepared {
  const startProtrusions = new Float64Array(p.words.length), endProtrusions = new Float64Array(p.words.length);
  const edge = (text: string, index: number) => {
    const result = measure(text, index);
    if (![result.start, result.end].every(value => Number.isFinite(value) && value >= 0)) throw new RangeError("Optical margins must be finite and nonnegative");
    return result;
  };
  const hyphenation = p.words.map((word, index) => {
    const margins = edge(word, index);
    startProtrusions[index] = margins.start; endProtrusions[index] = margins.end;
    const fragments = p.hyphenation?.[index];
    if (!fragments) return undefined;
    return { ...fragments,
      startProtrusions: Float64Array.from(fragments.offsets, offset => offset === word.length ? 0 : edge(word.slice(offset), index).start),
      hyphenProtrusion: edge("-", index).end,
    };
  });
  return { ...p, startProtrusions, endProtrusions, hyphenation };
}

function validate(measure: Measure, o: Options): readonly number[] {
  const widths = typeof measure === "number" ? [measure] : measure;
  if (!widths.length || widths.some(width => !Number.isFinite(width) || width <= 0)) throw new RangeError("Measure must be positive");
  const { mode, ending, ...numeric } = o;
  if (mode !== "balanced" && mode !== "strict") throw new RangeError("Unknown fitting mode");
  if (ending !== "soft" && ending !== "fit") throw new RangeError("Unknown ending model");
  for (const value of Object.values(numeric)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Policy values must be finite and nonnegative");
  }
  if (o.shrink > 1 || o.lastLine > 1 || o.hanging > 1 || o.opening > 1 || o.protrusion > 1) throw new RangeError("Shrink, lastLine, hanging, opening, and protrusion must be at most 1");
  return widths;
}

const cube = (value: number) => value * value * value;

const blank = (): Line => ({ start: 0, end: 0, width: 0, natural: 0, wordSpacing: 0, tracking: 0, hanging: 0, opening: 0, residual: 0, relaxed: false, cost: 0, last: false });

type FragmentMetrics = { natural: number; chars: number; last: boolean; hanging: number; opening: number; continued: boolean; startProtrusion?: number; endProtrusion?: number };

function fit(p: Prepared, start: number, end: number, width: number, o: Options,
  out: Line = blank(), emergency = false, fragment?: FragmentMetrics): Line {
  const gaps = end - start - 1;
  const chars = fragment?.chars ?? p.characters[end] - p.characters[start] + gaps;
  const natural = fragment?.natural ?? p.widths[end] - p.widths[start] + gaps * p.space;
  const last = fragment?.last ?? end === p.words.length;
  const hanging = Math.max((fragment?.hanging ?? p.endHangs[end - 1]) * o.hanging,
    (fragment ? fragment.endProtrusion ?? 0 : p.endProtrusions?.[end - 1] ?? 0) * o.protrusion);
  const opticalStart = fragment ? fragment.startProtrusion : p.startProtrusions?.[start];
  const opening = opticalStart === undefined ? (fragment?.opening ?? p.startHangs[start]) * o.opening : opticalStart * o.protrusion;
  const target = width + hanging + opening;
  const delta = last && natural <= target ? 0 : target - natural;
  const spaceBudget = gaps * p.space * (delta >= 0 ? o.stretch : o.shrink);
  const trackBudget = chars * o.tracking;
  const capacity = spaceBudget + trackBudget;
  const ratio = capacity ? Math.min(1, Math.abs(delta) / capacity) : 0;
  const sign = Math.sign(delta);
  const wordSpacing = gaps ? sign * ratio * spaceBudget / gaps : 0;
  const tracking = sign * ratio * o.tracking;
  const residual = delta - sign * ratio * capacity;
  // Price preferred-limit strain, but distinguish a fillable loose line from
  // a real overflow. Otherwise a narrow column can choose protruding words
  // over a feasible line simply because the latter needs wider spaces.
  // Emergency credit must reflect the spaces that can carry it. A width-only
  // allowance makes two enormous gaps cheaper than a normally spaced paragraph
  // with a hyphen. A natural-space floor keeps indivisible lines finite too.
  const strain = emergency && delta > 0
    ? 100 * cube(delta / Math.max(p.space, capacity + Math.min(width * o.emergencyStretch, gaps * p.space)))
    : o.mode === "balanced"
    ? 100 * cube(ratio + Math.abs(residual) / Math.max(capacity, gaps * p.space, p.space))
    : ratio * ratio * ratio * 100;
  const missing = Math.max(0, o.lastLine * width - natural);
  // A one-word tail has little flexibility: missing half the target should not
  // cost less than a modestly tightened body line merely because the page is wide.
  const ending = last && (fragment?.continued ?? start > 0) ? o.ending === "fit"
    ? o.widowPenalty / 300 * Math.min(10000, 100 * cube(missing / Math.max(p.space, gaps * p.space * o.stretch + trackBudget)))
    : o.widowPenalty * Math.pow(missing / width, 2) : 0;
  out.start = start;
  out.end = end;
  out.width = width;
  out.natural = natural;
  out.wordSpacing = wordSpacing;
  out.tracking = tracking;
  out.hanging = hanging;
  out.opening = opening;
  out.residual = residual;
  out.relaxed = false;
  out.last = last;
  const unbounded = capacity ? delta / capacity : delta === 0 ? 0 : Math.sign(delta) * Infinity;
  out.fitness = unbounded < -0.5 ? 0 : unbounded <= 0.5 ? 1 : unbounded <= 1 ? 2 : 3;
  finish(out, p, o);
  const remaining = out.residual;
  const failure = Math.abs(remaining) > 0.01
    ? overflowCost(remaining, remaining < 0 ? o.mode : "strict") : 0;
  out.cost = 1 + strain * (delta < 0 ? o.compressionPenalty : 1) + failure + ending;
  if (o.mode === "balanced" && o.emergencyStretch > 0 && !emergency && (delta > capacity * Math.cbrt(2) + 0.01 || Math.abs(remaining) > 0.01)) out.cost = Infinity;
  return out;
}

function overflowCost(residual: number, mode: Options["mode"]) {
  return mode === "balanced" ? 1e6 + residual * residual * 1e4 : 1e4 + residual * residual * 100;
}

/** Finish each candidate before scoring its actual residual.
 * Tracking remains bounded. Spaces can expand to complete a line, or contract
 * only within the configured shrink limit.
 * Single tokens and genuinely unfit material retain their reported residual.
 */
function finish(line: Line, p: Prepared, o: Options): Line {
  const gaps = line.end - line.start - 1;
  if (o.mode === "strict" || gaps === 0 || line.residual === 0) return line;
  const spacing = Math.max(-p.space * o.shrink, line.wordSpacing + line.residual / gaps);
  const adjustment = spacing - line.wordSpacing;
  line.relaxed = Math.abs(adjustment) > 1e-9;
  line.residual -= adjustment * gaps;
  if (Math.abs(line.residual) < 1e-9) line.residual = 0;
  line.wordSpacing = spacing;
  return line;
}

/** Dynamic-programming state per break: which measure the next line takes
 * (line index, clamped once widths repeat) × the finished line's fitness class. */
function shape(widths: readonly number[], o: Options) {
  const fitnesses = o.adjacentPenalty ? 4 : 1, lines = widths.length;
  return { fitnesses, lines, states: fitnesses * lines, origin: fitnesses === 4 ? 1 : 0,
    width: (l: number) => widths[l], next: (l: number) => Math.min(l + 1, lines - 1), widest: Math.max(...widths) };
}

/** Exact optimum within the first viable pass: ordinary fitting, then relaxed
 * stretch scoring if necessary. Both passes use admissible overflow pruning. */
export function solve(p: Prepared, measure: Measure, policy: Partial<Options> = {}): Layout {
  const o = { ...defaults, ...policy };
  const widths = validate(measure, o);
  if (p.hyphenation?.some(Boolean)) return solveHyphenated(p, widths, o);
  const n = p.words.length;
  const s = shape(widths, o);
  const costs = new Float64Array((n + 1) * s.states).fill(Infinity);
  const previous = new Int32Array(costs.length);
  // Keep reachable prefix boundaries in source order. Scanning backward
  // preserves tie-breaking while skipping prefixes this pass cannot compose.
  const reachable = new Int32Array(n + 1);
  costs[s.origin] = 0;
  let candidates = 0;
  const scratch = blank();
  let emergency = false;
  // A longer candidate must not become narrower at maximum compression.
  // Exotic policies (e.g. tracking larger than glyph advances) use full search.
  const maxOpening = p.startProtrusions
    ? p.startProtrusions.reduce((max, value) => Math.max(max, value * o.protrusion), 0)
    : p.startHangs.reduce((max, value) => Math.max(max, value * o.opening), 0);
  let monotone = p.space * (1 - o.shrink) >= o.tracking;
  for (let i = 0; i < n && monotone; i++) {
    monotone = p.widths[i + 1] - p.widths[i] >= (p.characters[i + 1] - p.characters[i]) * o.tracking;
  }
  for (let pass = 0; pass < 2; pass++) {
    emergency = pass === 1;
    costs.fill(Infinity); costs[s.origin] = 0;
    let count = 1;
    reachable[0] = 0;
    for (let end = 1; end <= n; end++) {
      for (let index = count - 1; index >= 0; index--) {
        const start = reachable[index];
        let line: Line | undefined;
        for (let l = 0; l < s.lines; l++) {
          const base = start * s.states + l * s.fitnesses;
          if (!anyFinite(costs, base, s.fitnesses)) continue;
          line = fit(p, start, end, s.width(l), o, scratch, emergency);
          candidates++;
          const target = end * s.states + s.next(l) * s.fitnesses + (s.fitnesses === 4 ? line.fitness! : 0);
          for (let fitness = 0; fitness < s.fitnesses; fitness++) {
            const source = base + fitness;
            const cost = costs[source] + line.cost + (start && Math.abs(fitness - line.fitness!) > 1 ? o.adjacentPenalty : 0);
            if (cost < costs[target]) {
              costs[target] = cost;
              previous[target] = source;
            }
          }
        }
        if (!line) continue;
        // Prefix costs are nonnegative. Allow the largest possible opening
        // credit and the widest measure before ruling out all earlier starts.
        const overflowBound = line.residual + (s.widest - line.width) + maxOpening - line.opening;
        // Earlier overflows are tight. They must lose at EVERY target line index;
        // a cheap history at another index can face different widths next.
        // Infinity prevents cost pruning until each target has a tight path.
        let worstTight = 0;
        for (let l = 0; l < s.lines; l++) worstTight = Math.max(worstTight, costs[end * s.states + s.next(l) * s.fitnesses]);
        if (monotone && overflowBound < -0.01 && ((!emergency && o.mode === "balanced" && o.emergencyStretch > 0) || 1 + overflowCost(overflowBound, o.mode) >= worstTight)) break;
      }
      if (anyFinite(costs, end * s.states, s.states)) reachable[count++] = end;
    }
    if (anyFinite(costs, n * s.states, s.states)) break;
  }
  const lines: Line[] = [];
  const terminal = cheapest(costs, n * s.states);
  for (let slot = terminal; slot >= s.states;) {
    const source = previous[slot], start = Math.floor(source / s.states), end = Math.floor(slot / s.states);
    const line = { ...fit(p, start, end, s.width(Math.floor(source % s.states / s.fitnesses)), o, scratch, emergency) };
    line.cost += start && Math.abs(source % s.fitnesses - line.fitness!) > 1 ? o.adjacentPenalty : 0;
    lines.push(line);
    slot = source;
  }
  return { lines: lines.reverse(), cost: costs[terminal], candidates };
}

function anyFinite(costs: Float64Array, from: number, count: number): boolean {
  for (let i = from; i < from + count; i++) if (costs[i] !== Infinity) return true;
  return false;
}

function cheapest(costs: Float64Array, from: number): number {
  let best = from;
  for (let i = from + 1; i < costs.length; i++) if (costs[i] < costs[best]) best = i;
  return best;
}

export function lineText(p: Prepared, line: Line): string {
  const words = p.words.slice(line.start, line.end);
  if (!words.length) return "";
  if (line.endOffset !== undefined) words[words.length - 1] = words.at(-1)!.slice(0, line.endOffset);
  if (line.startOffset) words[0] = words[0].slice(line.startOffset);
  return words.join(" ") + (line.hyphenated ? "-" : "");
}

/** A break node also records whether the preceding line hyphenated. This makes
 * adjacency penalties part of the optimum rather than a post-layout repair.
 */
function solveHyphenated(p: Prepared, widths: readonly number[], o: Options): Layout {
  const nodes: { word: number; part: number; offset: number; explicit: boolean }[] = [{ word: 0, part: 0, offset: 0, explicit: false }];
  p.words.forEach((_, word) => {
    const prepared = p.hyphenation![word];
    prepared?.offsets.slice(1, -1).forEach((offset, index) => nodes.push({ word, part: index + 1, offset, explicit: prepared.explicit?.[index + 1] ?? false }));
    nodes.push({ word: word + 1, part: 0, offset: 0, explicit: false });
  });
  const s = shape(widths, o);
  const costs = new Float64Array(nodes.length * s.states), previous = new Int32Array(costs.length);
  let candidates = 0, emergency = false;
  const scratch = blank();
  // At a whole-word boundary every earlier start adds a suffix and a gap.
  // Only prune if those additions cannot shrink the compressed line.
  let monotone = p.space * (1 - o.shrink) >= o.tracking, maxOpening = 0;
  for (let word = 0; word < p.words.length; word++) {
    const parts = p.hyphenation![word];
    const optical = p.startProtrusions?.[word];
    maxOpening = Math.max(maxOpening, optical === undefined ? p.startHangs[word] * o.opening : optical * o.protrusion);
    if (!(p.widths[word + 1] - p.widths[word] >= (p.characters[word + 1] - p.characters[word]) * o.tracking)) monotone = false;
    if (parts) {
      const n = parts.offsets.length;
      for (let from = 1; from < n - 1; from++) {
        const cell = from * n + n - 1;
        if (!(parts.widths[cell] >= parts.characters[cell] * o.tracking)) monotone = false;
        maxOpening = Math.max(maxOpening, (parts.startProtrusions?.[from] ?? 0) * o.protrusion);
      }
    }
  }
  const fragment = (word: number, from: number, to: number | undefined, hyphen: boolean) => {
    const prepared = p.hyphenation![word];
    if (!prepared) return { width: p.widths[word + 1] - p.widths[word], chars: p.characters[word + 1] - p.characters[word] };
    const cell = from * prepared.offsets.length + (to ?? prepared.offsets.length - 1);
    const generated = hyphen && !prepared.explicit?.[to!];
    return { width: hyphen ? prepared.hyphenWidths[cell] : prepared.widths[cell], chars: prepared.characters[cell] + Number(generated) };
  };
  const candidate = (start: number, end: number, width: number) => {
    const a = nodes[start], b = nodes[end], hyphen = b.offset > 0, generated = hyphen && !b.explicit;
    const lastWord = hyphen ? b.word : b.word - 1;
    let natural: number, chars: number;
    if (a.word === lastWord) {
      const part = fragment(a.word, a.part, hyphen ? b.part : undefined, hyphen);
      natural = part.width; chars = part.chars;
    } else {
      const first = fragment(a.word, a.part, undefined, false);
      const last = fragment(lastWord, 0, hyphen ? b.part : undefined, hyphen);
      const gaps = lastWord - a.word;
      natural = first.width + p.widths[lastWord] - p.widths[a.word + 1] + last.width + gaps * p.space;
      chars = first.chars + p.characters[lastWord] - p.characters[a.word + 1] + last.chars + gaps;
    }
    const line = fit(p, a.word, lastWord + 1, width, o, scratch, emergency, {
      natural, chars, last: end === nodes.length - 1, continued: start > 0,
      hanging: hyphen ? 0 : p.endHangs[lastWord], opening: a.offset ? 0 : p.startHangs[a.word],
      startProtrusion: a.offset ? p.hyphenation![a.word]?.startProtrusions?.[a.part] : p.startProtrusions?.[a.word],
      endProtrusion: hyphen ? p.hyphenation![lastWord]?.hyphenProtrusion : p.endProtrusions?.[lastWord],
    });
    line.startOffset = a.offset || undefined;
    line.endOffset = b.offset || undefined;
    line.hyphenated = generated;
    const afterGenerated = a.offset > 0 && !a.explicit;
    line.cost += generated ? o.hyphenPenalty + (afterGenerated ? o.consecutiveHyphenPenalty : 0)
      : hyphen ? o.explicitHyphenPenalty
      : line.last && afterGenerated ? o.finalHyphenPenalty : 0;
    return line;
  };
  for (let pass = 0; pass < 2; pass++) {
    emergency = pass === 1;
    costs.fill(Infinity); costs[s.origin] = 0;
    for (let end = 1; end < nodes.length; end++) for (let start = end - 1; start >= 0; start--) {
      let line: Line | undefined;
      for (let l = 0; l < s.lines; l++) {
        const base = start * s.states + l * s.fitnesses;
        if (!anyFinite(costs, base, s.fitnesses)) continue;
        line = candidate(start, end, s.width(l));
        candidates++;
        const target = end * s.states + s.next(l) * s.fitnesses + (s.fitnesses === 4 ? line.fitness! : 0);
        for (let fitness = 0; fitness < s.fitnesses; fitness++) {
          const source = base + fitness;
          const cost = costs[source] + line.cost + (start && Math.abs(fitness - line.fitness!) > 1 ? o.adjacentPenalty : 0);
          if (cost < costs[target]) { costs[target] = cost; previous[target] = source; }
        }
      }
      if (!monotone || !line || nodes[start].offset) continue;
      // Earlier starts contain this entire line plus a suffix, gaps, and whole
      // words. Their compressed additions are nonnegative; individual fragments
      // need not grow monotonically. Bound every measure and opening allowance.
      const overflowBound = line.residual + (s.widest - line.width) + maxOpening - line.opening;
      // Each target line index must already have a cheaper tight history.
      let worstTight = 0;
      for (let l = 0; l < s.lines; l++) worstTight = Math.max(worstTight, costs[end * s.states + s.next(l) * s.fitnesses]);
      if (overflowBound < -0.01 && ((!emergency && o.mode === "balanced" && o.emergencyStretch > 0) || 1 + overflowCost(overflowBound, o.mode) >= worstTight)) break;
    }
    if (anyFinite(costs, (nodes.length - 1) * s.states, s.states)) break;
  }
  const lines: Line[] = [];
  const terminal = cheapest(costs, (nodes.length - 1) * s.states);
  for (let slot = terminal; slot >= s.states;) {
    const source = previous[slot], start = Math.floor(source / s.states), end = Math.floor(slot / s.states);
    const line = { ...candidate(start, end, s.width(Math.floor(source % s.states / s.fitnesses))) };
    line.cost += start && Math.abs(source % s.fitnesses - line.fitness!) > 1 ? o.adjacentPenalty : 0;
    lines.push(line);
    slot = source;
  }
  return { lines: lines.reverse(), cost: costs[terminal], candidates };
}
