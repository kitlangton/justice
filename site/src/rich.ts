import "@fontsource-variable/eb-garamond";
import { hyphenateSync } from "hyphen/en-us";
import { solve } from "../../src/engine";
import { prepareRich, lineRuns, type RichRun } from "../../src/rich";

type Mark = { tag: "a" | "strong" | "em" | "code" | "u" | "span"; href?: string; className?: string };
type Marks = readonly Mark[];
const source = document.querySelector<HTMLElement>("#source")!;
const composed = document.querySelector<HTMLElement>("#composed")!;
const host = document.querySelector<HTMLElement>("#measure")!;
const slider = document.querySelector<HTMLInputElement>("#width")!;
const output = document.querySelector<HTMLOutputElement>("#width-value")!;
const allowed = new Set(["a", "strong", "em", "code", "u", "span"]);
const runs: RichRun<Marks>[] = [];

// This demo adapts its own inline HTML. Applications own their markup policy;
// the rich-text entry point stores metadata and never parses or injects HTML.
function read(node: Node, marks: Marks) {
  if (node.nodeType === Node.TEXT_NODE) {
    runs.push({ text: node.textContent!, marks });
    return;
  }
  if (node instanceof HTMLElement && allowed.has(node.localName)) {
    const mark: Mark = { tag: node.localName as Mark["tag"] };
    if (node instanceof HTMLAnchorElement && /^https?:$/.test(new URL(node.href).protocol)) mark.href = node.href;
    if (node.classList.contains("small-caps")) mark.className = "small-caps";
    if (node.classList.contains("accent")) mark.className = "accent";
    marks = [...marks, mark];
  }
  node.childNodes.forEach(child => read(child, marks));
}
read(source, []);

function markElement(mark: Mark) {
  const element = document.createElement(mark.tag);
  if (mark.href) element.setAttribute("href", mark.href);
  if (mark.className) element.className = mark.className;
  return element;
}

function appendRuns(parent: HTMLElement, parts: readonly RichRun<Marks>[]) {
  for (const run of parts) {
    let target = parent;
    for (const mark of run.marks) {
      const element = markElement(mark);
      target.append(element);
      target = element;
    }
    target.append(document.createTextNode(run.text));
  }
}

await document.fonts.ready;
const hyphenate = (word: string) => hyphenateSync(word).split("\u00ad");
const requests = new Map<string, readonly RichRun<Marks>[]>();
const key = (parts: readonly RichRun<Marks>[]) => JSON.stringify(parts);
const space: RichRun<Marks>[] = [{ text: " ", marks: [] }];
requests.set(key(space), space);
// Collect the engine's measurement requests first, then batch every DOM write
// before reading any width. Only this first preparation touches layout.
prepareRich(runs, parts => { requests.set(key(parts), parts); return 1; }, { space: 1, hyphenate });
const elements = [...requests].map(([id, parts]) => {
  const element = document.createElement("span");
  appendRuns(element, parts);
  return { id, element };
});
host.append(...elements.map(({ element }) => element));
const widths = new Map(elements.map(({ id, element }) => [id, element.getBoundingClientRect().width]));
host.replaceChildren();
const prepared = prepareRich(runs, parts => widths.get(key(parts))!, { space: widths.get(key(space))!, hyphenate });
requests.clear();
widths.clear();
elements.length = 0;

let lastWidth = 0;
function render() {
  const width = composed.getBoundingClientRect().width;
  if (width === lastWidth) return;
  lastWidth = width;
  const layout = solve(prepared, width);
  const fragment = document.createDocumentFragment();
  // The source tag stack crosses visual line breaks. Every source link stays
  // one native anchor, even when a tag starts inside a word or spans many lines.
  let active: Marks = [];
  const parents: (HTMLElement | DocumentFragment)[] = [fragment];
  function append(run: RichRun<Marks>, className: string, spacing: number) {
    let shared = 0;
    while (shared < run.marks.length && run.marks[shared] === active[shared]) shared++;
    parents.length = shared + 1;
    for (let index = shared; index < run.marks.length; index++) {
      const element = markElement(run.marks[index]);
      parents.at(-1)!.append(element);
      parents.push(element);
    }
    active = run.marks;
    const element = document.createElement("span");
    element.className = className;
    // Gaps use the measured paragraph font, so native decoration crosses them.
    if (className === "gap") element.style.wordSpacing = `${spacing - prepared.space}px`;
    else element.style.letterSpacing = `${spacing}px`;
    if (run.generated) {
      element.classList.add("generated");
      element.setAttribute("aria-hidden", "true");
    }
    element.textContent = run.text;
    parents.at(-1)!.append(element);
    return element;
  }
  for (const line of layout.lines) {
    let first = true;
    for (const piece of lineRuns(prepared, line)) for (const run of piece.runs) {
      const element = append(run, piece.kind === "space" ? "gap" : "word",
        piece.kind === "space" ? prepared.space + line.wordSpacing + line.tracking : line.tracking);
      if (first) { element.style.marginLeft = `${-line.opening}px`; first = false; }
    }
    if (!line.last) {
      // Keep real separators for copying. Only the visual newline is generated;
      // a discretionary break inside a word contributes no source whitespace.
      if (line.endOffset === undefined) append(prepared.spaceRuns[line.end - 1], "gap", 0);
      append({ text: "\n", marks: active, generated: true }, "break", 0);
    }
  }
  composed.replaceChildren(fragment);
  output.value = `${Math.round(width)} px`;
}

// Coalesce rapid input/resize events; measurement is never repeated here.
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}
slider.addEventListener("input", () => {
  document.documentElement.style.setProperty("--measure", `${slider.value}px`);
  schedule();
});
composed.addEventListener("copy", event => {
  const selection = getSelection();
  if (!event.clipboardData || selection?.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  if (!composed.contains(range.startContainer) || !composed.contains(range.endContainer)) return;
  const selected = range.cloneContents();
  selected.querySelectorAll(".generated").forEach(hyphen => hyphen.remove());
  event.clipboardData.setData("text/plain", selected.textContent!);
  event.preventDefault();
});
new ResizeObserver(entries => {
  if (entries[0].contentRect.width !== lastWidth) schedule();
}).observe(composed);
render();
