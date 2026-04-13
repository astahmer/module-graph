import { imports as analyzeImports } from "@thepassle/module-utils/imports.js";
import type { Plugin } from "../types.js";

export const imports: Plugin = {
  name: "imports-plugin",
  analyze: (module) => {
    module.imports = analyzeImports(module.source, module.path);
  },
};
