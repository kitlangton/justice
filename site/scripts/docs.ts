// Generates the agent-readable documents served beside the page:
//   /llms.txt        index in the llmstxt.org format
//   /llms-full.txt   everything in one file
//   /docs.md         the package README
//   /changelog.md    the changelog
//   /types.d.ts      the published type declarations
// Sources are the package itself, so the site cannot drift from what ships.
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("../public/", import.meta.url));

const build = Bun.spawn(["bun", "run", "build"], { cwd: root, stdout: "ignore", stderr: "inherit" });
if (await build.exited !== 0) throw new Error("Package build failed");

const readme = await Bun.file(`${root}packages/justice/README.md`).text();
const changelog = await Bun.file(`${root}CHANGELOG.md`).text();
const types = [
  `// @kitlangton/justice\n${await Bun.file(`${root}packages/justice/dist/engine.d.ts`).text()}`,
  `// @kitlangton/justice/static\n${await Bun.file(`${root}packages/justice/dist/static.d.ts`).text()}`,
  `// @kitlangton/justice/rich\n${await Bun.file(`${root}packages/justice/dist/rich.d.ts`).text()}`,
].join("\n");
const site = "https://justice.kitlangton.com";

const index = `# Justice

> A small, dependency-free paragraph justification engine for the web. Every line break in a paragraph is chosen together, in the tradition of Knuth–Plass line breaking from TeX. Published on npm as \`@kitlangton/justice\`.

The engine takes measured word widths and returns line breaks with word spacing, letter spacing, and optical-margin allowances. It has no DOM access; measurement and rendering belong to the caller. It runs in the browser, on a server, or at build time.

## Docs

- [Package documentation](${site}/docs.md): install, API, options, hyphenation, optical margins, per-line measures, static compilation, rendering contract
- [Type declarations](${site}/types.d.ts): the complete public API as TypeScript
- [Changelog](${site}/changelog.md)

## Optional

- [npm](https://www.npmjs.com/package/@kitlangton/justice)
- [Everything in one file](${site}/llms-full.txt)
`;

const full = `${index}
---

${readme}

---

# Type declarations

\`\`\`ts
${types}
\`\`\`

---

${changelog}`;

await Promise.all([
  Bun.write(`${out}llms.txt`, index),
  Bun.write(`${out}llms-full.txt`, full),
  Bun.write(`${out}docs.md`, readme),
  Bun.write(`${out}changelog.md`, changelog),
  Bun.write(`${out}types.d.ts`, types),
]);
console.log("docs: llms.txt, llms-full.txt, docs.md, changelog.md, types.d.ts");
