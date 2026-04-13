import { exports as analyzeExports } from "@thepassle/module-utils/exports.js";
import type { Plugin } from "../types.js";

export const exports: Plugin = {
  name: "exports-plugin",
  analyze: (module) => {
    module.exports = analyzeExports(module.source, module.path);
  },
};
