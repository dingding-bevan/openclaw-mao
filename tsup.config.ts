import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^node:/, /^openclaw\//, "fs", "os", "path", "url", "readline", "module", "child_process", "better-sqlite3"],
  define: {
    __OPENCLAW_MAO_VERSION__: JSON.stringify(pkg.version),
  },
});
