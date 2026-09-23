import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const declaration = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.package.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await declaration.exited !== 0) throw new Error("Declaration build failed");
await build({
  absWorkingDir: root,
  entryPoints: ["src/engine.ts"],
  outfile: "packages/justice/dist/engine.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
await build({
  absWorkingDir: root,
  entryPoints: ["src/static.ts", "src/rich.ts"],
  outdir: "packages/justice/dist",
  bundle: true,
  external: ["./engine.js"],
  minify: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
});
