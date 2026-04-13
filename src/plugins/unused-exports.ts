import { exports as analyzeExports } from "@thepassle/module-utils/exports.js";
import type { Export } from "@thepassle/module-utils/exports.js";
import { imports as analyzeImports } from "@thepassle/module-utils/imports.js";
import type { Import } from "@thepassle/module-utils/imports.js";
import type { ExtendedModule, ExtendedModuleGraph, Plugin } from "../types.js";

function getFilename(filePath?: string): string {
  return filePath?.split("/").pop() ?? "";
}

type AnalyzedModule = ExtendedModule<{
  imports: Import[];
  exports: Export[];
}>;

type AnalyzedModuleGraph = ExtendedModuleGraph<{
  unusedExports: Export[];
}>;

export const unusedExports: Plugin = {
  name: "find-unused-exports",
  analyze: (module) => {
    module.imports = analyzeImports(module.source, module.path);
    module.exports = analyzeExports(module.source, module.path);
  },
  end(moduleGraph) {
    const unusedExportsList: Export[] = [];

    for (const module of moduleGraph.modules.values()) {
      const analyzedModule = module as AnalyzedModule;

      for (const exportEntry of analyzedModule.exports ?? []) {
        let isImported = false;

        if (exportEntry.declaration?.module !== module.path) {
          continue;
        }

        for (const modulePath of module.importedBy) {
          const [importingModule] = moduleGraph.get(modulePath) as AnalyzedModule[];
          if (!importingModule) {
            continue;
          }

          let foundExport = Boolean(
            importingModule.imports.find((entry) => {
              if (
                entry.kind === "default" &&
                exportEntry.name === "default" &&
                getFilename(entry.module) ===
                  getFilename(exportEntry.declaration?.module ?? exportEntry.declaration.package)
              ) {
                return true;
              }

              return (
                entry.declaration === "*" ||
                (entry.declaration === exportEntry.name &&
                  getFilename(entry.module) ===
                    getFilename(exportEntry.declaration?.module ?? exportEntry.declaration.package))
              );
            }),
          );

          if (!foundExport) {
            foundExport = Boolean(
              importingModule.exports.find((entry) => {
                const isReexportedFromCurrentModule =
                  entry.declaration.module === exportEntry.declaration?.module;

                if (entry.name === "*" && isReexportedFromCurrentModule) {
                  return true;
                }

                if (entry.name === exportEntry.name && isReexportedFromCurrentModule) {
                  return true;
                }

                return false;
              }),
            );
          }

          isImported = foundExport || isImported;
        }

        if (!isImported) {
          unusedExportsList.push(exportEntry);
        }
      }
    }

    (moduleGraph as AnalyzedModuleGraph).unusedExports = unusedExportsList;
  },
};

export type { Export, Import };
