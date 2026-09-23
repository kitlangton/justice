import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  server: { fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
  build: {
    target: "es2022",
    rollupOptions: { input: {
      main: fileURLToPath(new URL("index.html", import.meta.url)),
      rich: fileURLToPath(new URL("rich.html", import.meta.url)),
    } },
  },
});
