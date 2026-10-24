import { expect, it } from "vitest";
import { lineText, prepare, solve, withHyphenation } from "../src/engine";
import { hyphenate, hyphenator } from "../src/english";

const measure = (text: string) => [...text].reduce((n, c) => n + (c === " " ? 4 : 8), 0);

it("hyphenates American English with TeX's patterns and exception list", () => {
  // Expected breaks are TeX's (ushyphmax), not derived from this implementation.
  expect(hyphenate("hyphenation")).toEqual(["hy", "phen", "ation"]);
  expect(hyphenate("configuration")).toEqual(["con", "fig", "u", "ra", "tion"]);
  expect(hyphenate("justification")).toEqual(["jus", "ti", "fi", "ca", "tion"]);
  expect(hyphenate("observability")).toEqual(["ob", "serv", "abil", "ity"]);
  expect(hyphenate("associate")).toEqual(["as", "so", "ciate"]);
  expect(hyphenate("present")).toEqual(["present"]);
  expect(hyphenate("Development")).toEqual(["De", "vel", "op", "ment"]);
});

it("keeps punctuation on the edge fragments and leaves code, numbers and short words whole", () => {
  expect(hyphenate("“configuration,”")).toEqual(["“con", "fig", "u", "ra", "tion,”"]);
  expect(hyphenate("(instrumentation)")).toEqual(["(in", "stru", "men", "ta", "tion)"]);
  expect(hyphenate("well-developed")).toEqual(["well-", "de", "vel", "oped"]);
  for (const word of ["cat", "useEffect", "HTTPS", "https://example.com", "v1.2.3", "snake_case", "naïveté", "10\u00a0km", "-foo", "--option"]) expect(hyphenate(word)).toEqual([word]);
  expect(hyphenator({ left: 3, right: 4 })("hyphenation")).toEqual(["hyphen", "ation"]);
  expect(hyphenator({ minWord: 12 })("hyphenation")).toEqual(["hyphenation"]);
});

it("plugs into withHyphenation, so a narrow column can break inside words", () => {
  const text = "Instrumentation and observability configuration";
  const p = withHyphenation(prepare(text, measure), hyphenate, measure);
  const { lines } = solve(p, 100, { tracking: 0 });
  expect(lines.some(line => line.hyphenated)).toBe(true);
  expect(lines.map(line => line.hyphenated ? lineText(p, line).slice(0, -1) : lineText(p, line) + " ").join("").trim()).toBe(text);
});
