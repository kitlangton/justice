import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { build } from "esbuild";

// Run `bun run build` first. Explicit compression levels make comparisons
// reproducible; each entry is compressed independently, as it is transferred.
const dist = new URL("../packages/justice/dist/", import.meta.url);
function report(entry: string, source: Uint8Array) {
  console.log(JSON.stringify({
    entry,
    minified_bytes: source.length,
    gzip_bytes: gzipSync(source, { level: 9 }).length,
    brotli_bytes: brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    sha256: createHash("sha256").update(source).digest("hex"),
  }));
}
for (const name of (await readdir(dist)).filter(name => name.endsWith(".js")).sort()) {
  report(name, await readFile(new URL(name, dist)));
}

// Representative consumers of the published modules: a rich consumer does not
// need the plain prepare/lineText helpers, and both drop unused engine exports.
const root = fileURLToPath(new URL("../", import.meta.url));
for (const [name, contents] of Object.entries({
  plain: 'export {prepare,solve,lineText} from "./packages/justice/dist/engine.js";',
  rich: 'export {prepareRich,lineRuns} from "./packages/justice/dist/rich.js"; export {solve} from "./packages/justice/dist/engine.js";',
})) {
  const result = await build({
    stdin: { contents, resolveDir: root, sourcefile: "consumer.js" },
    bundle: true, minify: true, format: "esm", platform: "neutral", target: "es2022", write: false,
  });
  report(`consumer:${name}`, result.outputFiles[0].contents);
}
