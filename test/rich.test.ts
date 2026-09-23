import { describe, expect, it } from "vitest";
import { lineText, prepare, solve, withHyphenation, type Line } from "../src/engine";
import { lineRuns, prepareRich, type RichRun } from "../src/rich";
import { compileStatic, staticSpacing } from "../src/static";

const normal = { weight: 1 };
const bold = { weight: 1.5 };
const italicLink = { weight: 1.1, italic: true, href: "/article" };
type Marks = { weight: number; italic?: boolean; href?: string };
const textOf = (runs: readonly RichRun<Marks>[]) => runs.map(run => run.text).join("");
const plainWidth = (text: string) => [...text].reduce((sum, c) => sum + (c === " " ? 4 : 8), 0)
  - (text.match(/a-/g)?.length ?? 0) * 2;
const width = (runs: readonly RichRun<Marks>[]) => runs.reduce((sum, run) => sum + plainWidth(run.text) * run.marks.weight, 0);
const run = (text: string, marks: Marks = normal): RichRun<Marks> => ({ text, marks });
const visible = (p: ReturnType<typeof prepareRich<Marks>>, line: Line) => lineRuns(p, line).map(piece => textOf(piece.runs)).join("");

describe("rich inline runs", () => {
  it("keeps words whole across nested marks and gives collapsed gaps their first whitespace's marks", () => {
    const linkBold = { weight: 1.5, href: "/cooperate" };
    const p = prepareRich([
      run(" \t"), run("co", bold), run("oper", linkBold), run("ate", italicLink),
      run(" \n", linkBold), run("\tsecond "),
    ], width, { space: 4 });
    expect(p.words).toEqual(["cooperate", "second"]);
    expect(p.wordRuns[0]).toEqual([run("co", bold), run("oper", linkBold), run("ate", italicLink)]);
    expect(p.spaceRuns[0]).toEqual(run(" ", linkBold));
    const [line] = solve(p, 1000).lines;
    const pieces = lineRuns(p, line);
    expect(pieces.map(piece => piece.kind)).toEqual(["word", "space", "word"]);
    expect(pieces[1].runs[0].marks).toBe(linkBold);
    expect(visible(p, line)).toBe("cooperate second");
    expect(pieces[0].runs[1].marks).toBe(linkBold);
  });

  it("measures repeated text separately by mark identity and reuses identical rich words", () => {
    const measured: string[] = [];
    const p = prepareRich([run("same "), run("same same", bold)], runs => {
      measured.push(`${textOf(runs)}:${runs[0].marks.weight}`);
      return width(runs);
    }, { space: 4 });
    expect([...p.widths]).toEqual([0, 32, 80, 128]);
    expect(measured.filter(value => value === "same:1")).toHaveLength(1);
    expect(measured.filter(value => value === "same:1.5")).toHaveLength(1);
  });

  it("hands complete shaped words and hyphenated fragments to the measurer", () => {
    const calls: RichRun<Marks>[][] = [];
    const shaped = (runs: readonly RichRun<Marks>[]) => {
      calls.push(runs.map(part => ({ ...part })));
      // This font's a- pair has a smaller advance, even across semantic runs.
      return plainWidth(textOf(runs));
    };
    const p = prepareRich([run("aa"), run("aa", italicLink)], shaped, {
      space: 4, hyphenate: () => ["aa", "aa"],
    });
    expect(calls.some(parts => parts.length === 2 && textOf(parts) === "aaaa")).toBe(true);
    const hyphenated = calls.find(parts => textOf(parts) === "aa-")!;
    expect(hyphenated).toBeDefined();
    expect(hyphenated.at(-1)).toEqual({ text: "-", marks: normal, generated: true });
    const fragments = p.hyphenation![0]!;
    expect(fragments.hyphenWidths[1]).toBe(22);
    expect(fragments.widths[1]).toBe(16);
  });

  it("retains exact marks when one source word occupies three lines", () => {
    const p = prepareRich([run("abcdef", bold), run("ghijkl", italicLink), run("mnopqr")], width, {
      space: 4, hyphenate: () => ["abc", "def", "ghi", "jkl", "mno", "pqr"],
    });
    const base = solve(p, 1000).lines[0];
    const lines = [
      { ...base, startOffset: undefined, endOffset: 6, hyphenated: true },
      { ...base, startOffset: 6, endOffset: 12, hyphenated: true },
      { ...base, startOffset: 12, endOffset: undefined, hyphenated: false },
    ];
    expect(lines.map(line => visible(p, line))).toEqual(["abcdef-", "ghijkl-", "mnopqr"]);
    expect(lineRuns(p, lines[1])[0].runs).toEqual([
      run("ghijkl", italicLink), { text: "-", marks: italicLink, generated: true },
    ]);
    const source = lines.flatMap(line => lineRuns(p, line).flatMap(piece => piece.runs))
      .filter(part => !part.generated).map(part => part.text).join("");
    expect(source).toBe("abcdefghijklmnopqr");
    expect(p.wordRuns[1]).toBeUndefined();
  });

  it("slices a partial first and last word without leading or trailing spaces", () => {
    const p = prepareRich([run("prefix "), run("middle", bold), run(" suffix", italicLink)], width, { space: 4 });
    const full = solve(p, 1000).lines[0];
    const partial = { ...full, startOffset: 3, endOffset: 3, hyphenated: true };
    expect(visible(p, partial)).toBe("fix middle suf-");
    expect(lineRuns(p, partial).at(-1)!.runs.at(-1)).toEqual({ text: "-", marks: italicLink, generated: true });
    expect(lineRuns(p, { ...full, start: 1, end: 2 })).toEqual([{ kind: "word", runs: [run("middle", bold)] }]);
  });

  it("distinguishes source hyphens from generated hyphens and retains breaks alongside a dictionary", () => {
    const p = prepareRich([run("well-", bold), run("known", italicLink)], width, {
      space: 4, hyphenate: () => ["we", "ll-known"],
    });
    const fragments = p.hyphenation![0]!;
    expect(fragments.offsets).toEqual([0, 2, 5, 10]);
    expect(fragments.explicit?.[2]).toBe(true);
    const base = solve(p, 1000).lines[0];
    const first = { ...base, endOffset: 5, hyphenated: false };
    expect(visible(p, first)).toBe("well-");
    expect(lineRuns(p, first)[0].runs).toEqual([run("well-", bold)]);
    expect(visible(p, { ...base, startOffset: 5 })).toBe("known");
  });

  it("uses source offsets to distinguish repeated substrings with different marks", () => {
    const p = prepareRich([run("ab"), run("ab", bold), run("ab", italicLink)], width, {
      space: 4, hyphenate: () => ["ab", "ab", "ab"],
    });
    const fragments = p.hyphenation![0]!;
    const n = fragments.offsets.length;
    expect(fragments.widths[1]).toBe(16);
    expect(fragments.widths[n + 2]).toBe(24);
    expect(fragments.widths[2 * n + 3]).toBeCloseTo(17.6);
    expect(fragments.hyphenWidths[n + 2]).toBe(36);
  });

  it("measures quote and punctuation credits using their actual edge marks", () => {
    const p = prepareRich([run("“", bold), run("word"), run(",”", italicLink)], width, { space: 4 });
    expect(p.startHangs[0]).toBe(12);
    expect(p.endHangs[0]).toBeCloseTo(17.6);
  });

  it("counts graphemes across mark boundaries and never hyphenates NBSP words", () => {
    const seen: string[] = [];
    const p = prepareRich([run("a"), run("\u0301bc ", bold), run("10\u00a0km", italicLink), run(" 👩‍"), run("💻")], width, {
      space: 4, hyphenate: word => { seen.push(word); return [word]; },
    });
    expect(p.words).toEqual(["ábc", "10\u00a0km", "👩‍💻"]);
    expect([...p.characters]).toEqual([0, 3, 8, 9]);
    expect(seen).not.toContain("10\u00a0km");
    expect(visible(p, solve(p, 1000).lines[0])).toBe("ábc 10\u00a0km 👩‍💻");
  });

  it("matches Unicode segmentation for every ASCII character and fragment", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const text = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code))
      .filter(char => !" \t\r\n\f".includes(char)).map(char => `a${char}z`).join(" ");
    const p = prepareRich([run(text)], width, { space: 4, hyphenate: word => [...word] });
    for (const [index, word] of p.words.entries()) {
      expect(p.characters[index + 1] - p.characters[index]).toBe([...segmenter.segment(word)].length);
      const fragments = p.hyphenation![index]!, offsets = fragments.offsets, n = offsets.length;
      for (let from = 0; from < n - 1; from++) for (let to = from + 1; to < n; to++) {
        expect(fragments.characters[from * n + to]).toBe([...segmenter.segment(word.slice(offsets[from], offsets[to]))].length);
      }
    }
  });

  it("retains exact Unicode fragment counts when repeated words use different marks", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const words = ["cafédéjà", "🇩🇰🇨🇦🇺🇸", "👩‍💻ábcdef", "क्षिक्षि", "각나", "\u0600ab", "́abc", "Ångström"];
    const p = prepareRich([normal, bold, italicLink].flatMap(marks =>
      words.flatMap(text => [run(text.slice(0, 1), marks), run(text.slice(1) + " ", marks)])), width, {
      space: 4, hyphenate: word => [...segmenter.segment(word)].map(part => part.segment),
    });
    for (const [index, word] of p.words.entries()) {
      expect(p.characters[index + 1] - p.characters[index]).toBe([...segmenter.segment(word)].length);
      const fragments = p.hyphenation?.[index];
      if (!fragments) continue;
      const offsets = fragments.offsets, n = offsets.length;
      for (let from = 0; from < n - 1; from++) for (let to = from + 1; to < n; to++) {
        expect(fragments.characters[from * n + to]).toBe([...segmenter.segment(word.slice(offsets[from], offsets[to]))].length);
      }
    }
  });

  it("returns independently owned line output without mutating prepared source runs", () => {
    const p = prepareRich([run("co"), run("operate ", bold), run("again", italicLink)], width, { space: 4 });
    const line = solve(p, 1000).lines[0], first = lineRuns(p, line), second = lineRuns(p, line);
    first[0].runs[0].text = "changed";
    first[0].runs.push(run("extra"));
    first[1].runs[0].text = "changed gap";
    first.pop();
    expect(lineRuns(p, line)).toEqual(second);
    expect(p.words).toEqual(["cooperate", "again"]);
    expect(p.wordRuns[0]).toEqual([run("co"), run("operate", bold)]);
    expect(p.spaceRuns).toEqual([run(" ", bold)]);
  });

  it("still calls index-sensitive hyphenation for every occurrence of a cached word", () => {
    const seen: number[] = [];
    const p = prepareRich([run("abcdef abcdef abcdef")], width, {
      space: 4,
      hyphenate: (word, index) => {
        seen.push(index);
        return index === 0 ? ["ab", "cdef"] : index === 1 ? ["abc", "def"] : [word];
      },
    });
    expect(seen).toEqual([0, 1, 2]);
    expect(Array.from(p.hyphenation!, part => part?.offsets)).toEqual([[0, 2, 6], [0, 3, 6], undefined]);
    expect(p.hyphenation![0]!.widths).not.toBe(p.hyphenation![1]!.widths);
  });

  it("agrees with plain preparation, solving, and static compilation for equivalent shaping", () => {
    const text = "“Fine,” well-known words make a paragraph. Keep every source word intact.";
    const source = Array.from(text, character => run(character));
    const hyphenate = (word: string) => word.match(/.{1,3}/gu)!;
    for (const dictionary of [undefined, hyphenate]) {
      let plain = prepare(text, plainWidth);
      if (dictionary) plain = withHyphenation(plain, dictionary, plainWidth);
      const rich = prepareRich(source, parts => plainWidth(textOf(parts)), { space: 4, hyphenate: dictionary });
      for (const property of ["words", "widths", "characters", "startHangs", "endHangs", "space", "hyphenation"] as const) {
        expect(rich[property], property).toEqual(plain[property]);
      }
      for (const measure of [80, 160, 320, [120, 180, 240]]) {
        const layout = solve(rich, measure);
        expect(layout).toEqual(solve(plain, measure));
        for (const line of layout.lines) expect(visible(rich, line)).toBe(lineText(plain, line));
      }
      expect(staticSpacing(rich)).toEqual(staticSpacing(plain));
      expect(compileStatic(rich, 120, 220, 10)).toEqual(compileStatic(plain, 120, 220, 10));
    }
  });

  it("reuses preparation across widths and output extraction without remeasuring", () => {
    let calls = 0;
    const p = prepareRich([run("A long "), run("interoperable", bold), run(" phrase", italicLink)], parts => {
      calls++; return width(parts);
    }, { space: 4, hyphenate: word => word === "interoperable" ? ["inter", "oper", "able"] : [word] });
    const preparedCalls = calls;
    for (const width of [80, 120, 220]) for (const line of solve(p, width).lines) lineRuns(p, line);
    compileStatic(p, 80, 220, 10);
    expect(calls).toBe(preparedCalls);
  });

  it("reconstructs randomly split source marks through actual hyphenated layouts", () => {
    let seed = 7919;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const styles = [normal, bold, italicLink];
    const whitespace = [" ", "\t\n", "\r\f "];
    const vocabulary = ["ababa", "well-known", "ábcde", "👩‍💻x", "10\u00a0km", "<a>&:"];
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let generated = 0, explicit = 0, continued = 0;
    for (let sample = 0; sample < 50; sample++) {
      const text = " \t" + ["abcdefghijklmnopqr", ...Array.from({ length: 4 }, () => vocabulary[Math.floor(random() * vocabulary.length)])]
        .join(whitespace[sample % whitespace.length]) + "\n ";
      const points = [...text], input: RichRun<Marks>[] = [];
      for (let at = 0; at < points.length;) {
        const count = 1 + Math.floor(random() * 5);
        input.push(run(points.slice(at, at + count).join(""), styles[Math.floor(random() * styles.length)]));
        if (random() < .25) input.push(run("", normal));
        at += count;
      }
      // Independent character-level normalization retains mark ownership for
      // each UTF-16 source unit, including one representative collapsed space.
      const expected: { text: string; marks: Marks }[] = [];
      let pending: Marks | undefined;
      for (const part of input) for (let i = 0; i < part.text.length; i++) {
        const text = part.text[i];
        if (" \t\r\n\f".includes(text)) {
          if (expected.length) pending ??= part.marks;
        } else {
          if (pending) expected.push({ text: " ", marks: pending });
          pending = undefined;
          expected.push({ text, marks: part.marks });
        }
      }
      const shapedWidth = (parts: readonly RichRun<Marks>[]) => parts.reduce((total, part) => total + part.text.length * 8 * part.marks.weight, 0)
        - (textOf(parts).match(/a-/g)?.length ?? 0) * 2;
      const p = prepareRich(input, shapedWidth, {
        space: 4,
        hyphenate: word => [...segmenter.segment(word)].map(part => part.segment).reduce<string[]>((parts, part, index) => {
          if (index % 2) parts[parts.length - 1] += part;
          else parts.push(part);
          return parts;
        }, []),
      });
      const layout = solve(p, 48 + random() * 120, { mode: sample % 2 ? "balanced" : "strict", tracking: 0 });
      let cursor = 0;
      for (const [index, line] of layout.lines.entries()) {
        if (index && layout.lines[index - 1].endOffset === undefined) {
          expect(expected[cursor].text).toBe(" ");
          cursor++;
        }
        const pieces = lineRuns(p, line), flat = pieces.flatMap(piece => piece.runs);
        expect(textOf(flat)).toBe(lineText(p, line));
        const natural = pieces.reduce((total, piece) => total + (piece.kind === "space" ? 4 : shapedWidth(piece.runs)), 0);
        expect(line.natural).toBeCloseTo(natural, 8);
        for (const part of flat) {
          if (part.generated) {
            generated++;
            expect(part.text).toBe("-");
            expect(part.marks).toBe(expected[cursor - 1].marks);
            expect(part).toBe(flat.at(-1));
          } else for (let i = 0; i < part.text.length; i++) {
            expect(part.text[i]).toBe(expected[cursor].text);
            expect(part.marks).toBe(expected[cursor].marks);
            cursor++;
          }
        }
        if (line.endOffset && !line.hyphenated) explicit++;
        if (line.startOffset && line.endOffset && line.start === line.end - 1) continued++;
      }
      expect(cursor).toBe(expected.length);
    }
    expect(generated).toBeGreaterThan(0);
    expect(explicit).toBeGreaterThan(0);
    expect(continued).toBeGreaterThan(0);
  });

  it("handles empty paragraphs and retains the explicit uniform gap width", () => {
    for (const runs of [[], [run(" \n\t ")], [run("")]]) {
      const p = prepareRich(runs, width, { space: 5 });
      expect(p.words).toEqual([]);
      expect(solve(p, 100).lines).toEqual([]);
    }
    const p = prepareRich([run("one "), run("two", bold)], width, { space: 7 });
    expect(solve(p, 1000).lines[0].natural).toBe(24 + 7 + 36);
  });

  it("rejects invalid measurements, spacing, partitions, and breaks inside graphemes", () => {
    for (const space of [0, -1, NaN, Infinity]) expect(() => prepareRich([run("word")], width, { space })).toThrow(RangeError);
    for (const invalid of [-1, NaN, Infinity]) expect(() => prepareRich([run("word")], () => invalid, { space: 4 })).toThrow(RangeError);
    for (const parts of [[], ["wrong"], ["", "word"]]) {
      expect(() => prepareRich([run("word")], width, { space: 4, hyphenate: () => parts })).toThrow(RangeError);
    }
    expect(() => prepareRich([run("a"), run("́bc", bold)], width, { space: 4, hyphenate: () => ["a", "́bc"] })).toThrow(RangeError);
    expect(() => prepareRich([run("👩‍💻ab")], width, { space: 4, hyphenate: () => ["👩", "‍💻ab"] })).toThrow(RangeError);
    expect(() => prepareRich([run("word")], parts => textOf(parts).endsWith("-") ? NaN : width(parts), {
      space: 4, hyphenate: () => ["wo", "rd"],
    })).toThrow(RangeError);
  });
});
