import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "./src/index.ts",
    "module-graph": "./src/module-graph.ts",
    utils: "./src/utils.ts",
    types: "./src/types.ts",
    "plugins/imports": "./src/plugins/imports.ts",
    "plugins/exports": "./src/plugins/exports.ts",
    "plugins/barrel-file": "./src/plugins/barrel-file.ts",
    "plugins/unused-exports": "./src/plugins/unused-exports.ts",
    "bin/index": "./src/bin/index.ts",
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
