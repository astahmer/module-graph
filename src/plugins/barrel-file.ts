import { barrelFile as analyzeBarrelFile } from "@thepassle/module-utils/barrel-file.js";
import type { Plugin } from "../types.js";

interface BarrelFileOptions {
  amountOfExportsToConsiderModuleAsBarrel: number;
}

export function barrelFile(
  options: BarrelFileOptions = { amountOfExportsToConsiderModuleAsBarrel: 5 },
): Plugin {
  return {
    name: "barrel-file-plugin",
    analyze: (module) => {
      module.isBarrelFile = analyzeBarrelFile(module.source, module.path, options);
    },
  };
}
