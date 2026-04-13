import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "./index.ts",
    ModuleGraph: "./ModuleGraph.ts",
    utils: "./utils.ts",
    types: "./types.ts",
    "plugins/imports": "./plugins/imports.ts",
    "plugins/exports": "./plugins/exports.ts",
    "plugins/barrel-file": "./plugins/barrel-file.ts",
    "plugins/unused-exports": "./plugins/unused-exports.ts",
    "bin/index": "./bin/index.ts",
  },
  outDir: "./dist",
  format: ["esm"],
  unbundle: true,
  dts: true,
  clean: true,
  outExtensions: () => ({
    js: ".js",
    dts: ".d.ts",
  }),
  platform: "node",
  target: "node18",
});
