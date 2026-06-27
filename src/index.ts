import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createFilter, normalizePath } from "@rollup/pluginutils";
import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { ModuleGraph } from "./module-graph.ts";
import type {
  CreateModuleGraphOptions,
  FindImportChainsOptions,
  Module,
  PathMatcherPattern,
  Plugin,
} from "./types.ts";
import {
  extractPackageNameFromSpecifier,
  isBareModuleSpecifier,
  isScopedPackage,
  toUnix,
} from "./utils.ts";

const DEFAULT_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".node",
];
const DEFAULT_EXTENSION_ALIAS: Record<string, string[]> = {
  ".js": [".js", ".ts", ".tsx", ".jsx"],
  ".jsx": [".jsx", ".tsx", ".ts", ".js"],
  ".mjs": [".mjs", ".mts"],
  ".cjs": [".cjs", ".cts"],
};

const getParserLang = (filename: string): "js" | "jsx" | "ts" | "tsx" => {
  switch (path.extname(filename).toLowerCase()) {
    case ".jsx":
      return "jsx";
    case ".tsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    default:
      return "js";
  }
};

interface ImportRecord {
  n: string;
  ss: number;
  se: number;
  isDynamic: boolean;
  isTypeOnly: boolean;
}

interface ModuleInfo {
  imports: ImportRecord[];
  facade: boolean;
  hasModuleSyntax: boolean;
}

const createPathMatcher = (patterns: PathMatcherPattern[] = []): ((id: string) => boolean) => {
  const callbacks = patterns.filter(
    (pattern): pattern is (id: string) => boolean => typeof pattern === "function",
  );
  const globs = patterns.filter((pattern): pattern is string => typeof pattern === "string");
  const globFilter = globs.length > 0 ? createFilter(globs, null, { resolve: false }) : () => false;

  return (id: string) => globFilter(normalizePath(id)) || callbacks.some((match) => match(id));
};

const getErrorStack = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
};

export async function createModuleGraph(
  entrypoints: string | string[],
  options: CreateModuleGraphOptions = {},
): Promise<ModuleGraph> {
  const {
    plugins = [],
    basePath = process.cwd(),
    exportConditions = ["node", "import"],
    includeTypeOnlyImports = false,
    ignoreDynamicImport = false,
    verbose = false,
    external = {
      ignore: false,
      include: [],
      exclude: [],
    },
    exclude: excludePatterns = [],
    foreignModules: foreignModulePatterns = [],
    virtualModules: virtualModulePatterns = [],
    ...resolveOptions
  } = options;

  if (external.ignore && external.include?.length) {
    throw new Error('Cannot use both "ignore" and "include" in the external option.');
  }

  const isExcluded = createPathMatcher(excludePatterns);
  const isForeignModule = createPathMatcher(foreignModulePatterns);
  const isVirtualModule = createPathMatcher(virtualModulePatterns);

  const effectiveResolveOptions = {
    ...resolveOptions,
    conditionNames: exportConditions,
    extensions: resolveOptions.extensions ?? DEFAULT_EXTENSIONS,
    extensionAlias: {
      ...DEFAULT_EXTENSION_ALIAS,
      ...resolveOptions.extensionAlias,
    },
  };

  const resolve = new ResolverFactory(effectiveResolveOptions);

  const processedEntrypoints = typeof entrypoints === "string" ? [entrypoints] : entrypoints;
  const toRelative = (entrypoint: string): string => {
    const absoluteEntrypoint = path.isAbsolute(entrypoint)
      ? entrypoint
      : path.join(basePath, entrypoint);
    return toUnix(path.relative(basePath, absoluteEntrypoint));
  };
  const modules = processedEntrypoints.map(toRelative);
  let scannedModuleCount = 0;

  const logVerbose = (message: string) => {
    if (verbose) {
      console.info(message);
    }
  };

  const getLiteralImportSpecifier = (request: string): string | undefined => {
    const quote = request.at(0);
    if (!quote || request.length < 2) {
      return undefined;
    }

    if ((quote !== '"' && quote !== "'" && quote !== "`") || request.at(-1) !== quote) {
      return undefined;
    }

    const unwrapped = request.slice(1, -1);
    if (quote === "`" && unwrapped.includes("${")) {
      return undefined;
    }

    return unwrapped;
  };

  const getModuleInfo = (filename: string, source: string): ModuleInfo => {
    const result = parseSync(filename, source, { lang: getParserLang(filename) });
    if (result.errors.length > 0) {
      const errorMessage = result.errors.map((error) => error.message).join("\n");
      throw new Error(`[PARSE] Failed to parse ${toUnix(path.relative(basePath, filename))}\n\n${errorMessage}`);
    }

    const imports: ImportRecord[] = [];

    for (const staticImport of result.module.staticImports) {
      const isTypeOnly =
        staticImport.entries.length > 0 && staticImport.entries.every((entry) => entry.isType);
      imports.push({
        n: staticImport.moduleRequest.value,
        ss: staticImport.start,
        se: staticImport.end,
        isDynamic: false,
        isTypeOnly,
      });
    }

    for (const staticExport of result.module.staticExports) {
      for (const entry of staticExport.entries) {
        if (!entry.moduleRequest) {
          continue;
        }

        imports.push({
          n: entry.moduleRequest.value,
          ss: staticExport.start,
          se: staticExport.end,
          isDynamic: false,
          isTypeOnly: entry.isType,
        });
      }
    }

    for (const dynamicImport of result.module.dynamicImports) {
      const importee = getLiteralImportSpecifier(
        source.slice(dynamicImport.moduleRequest.start, dynamicImport.moduleRequest.end),
      );

      if (!importee) {
        continue;
      }

      imports.push({
        n: importee,
        ss: dynamicImport.start,
        se: dynamicImport.end,
        isDynamic: true,
        isTypeOnly: false,
      });
    }

    return {
      imports,
      facade: false,
      hasModuleSyntax: result.module.hasModuleSyntax,
    };
  };

  for (const { name, start } of plugins) {
    if (!name) {
      throw new Error("Plugin must have a name");
    }

    try {
      await start?.({
        entrypoints: modules,
        basePath,
        exportConditions,
      });
    } catch (error) {
      throw new Error(`[PLUGIN] "${name}" failed on the "start" hook.\n\n${getErrorStack(error)}`);
    }
  }

  const importsToScan = new Set(modules);
  const scannedModules = new Set<string>();

  const moduleGraph = new ModuleGraph(basePath, processedEntrypoints);
  for (const module of modules) {
    const url = pathToFileURL(path.join(basePath, module));
    moduleGraph.modules.set(module, {
      href: url.href,
      pathname: url.pathname,
      path: module,
      source: "",
      facade: false,
      hasModuleSyntax: true,
      importedBy: [],
    });

    moduleGraph.graph.set(module, new Set());
  }

  while (importsToScan.size > 0) {
    for (const dep of [...importsToScan]) {
      importsToScan.delete(dep);
      scannedModules.add(dep);
      scannedModuleCount += 1;

      if (verbose && (scannedModuleCount === 1 || scannedModuleCount % 250 === 0)) {
        logVerbose(`[modgraph] scanned ${scannedModuleCount} modules, current: ${dep}`);
      }

      const filename = path.join(basePath, dep);
      let source = fs.readFileSync(filename, "utf8");

      for (const { name, transformSource } of plugins) {
        try {
          const result = await transformSource?.({
            filename,
            source,
          });

          if (result) {
            source = result;
          }
        } catch (error) {
          throw new Error(
            `[PLUGIN] "${name}" failed on the "transformSource" hook.\n\n${getErrorStack(error)}`,
          );
        }
      }

      const { imports, facade, hasModuleSyntax } = getModuleInfo(filename, source);

      importLoop: for (let { n: importee, isDynamic, isTypeOnly } of imports) {
        if (!importee) {
          continue;
        }

        if (!includeTypeOnlyImports && isTypeOnly) {
          continue;
        }

        const isVirtualImport = isVirtualModule(importee);

        if (ignoreDynamicImport && isDynamic) {
          continue;
        }

        if (!isForeignModule(importee) && !isVirtualImport) {
          if (isBareModuleSpecifier(importee) && external.ignore) {
            continue;
          }

          if (
            isBareModuleSpecifier(importee) &&
            external.exclude?.length &&
            external.exclude.includes(extractPackageNameFromSpecifier(importee))
          ) {
            continue;
          }

          if (
            isBareModuleSpecifier(importee) &&
            external.include?.length &&
            !external.include.includes(extractPackageNameFromSpecifier(importee))
          ) {
            continue;
          }
        }

        for (const { name, handleImport } of plugins) {
          try {
            const result = await handleImport?.({
              source,
              importer: dep,
              importee,
            });

            if (typeof result === "string") {
              importee = result;
            } else if (result === false) {
              continue importLoop;
            }
          } catch (error) {
            throw new Error(
              `[PLUGIN] "${name}" failed on the "handleImport" hook.\n\n${getErrorStack(error)}`,
            );
          }
        }

        if (builtinModules.includes(importee.replace("node:", ""))) {
          continue;
        }

        const importer = path.join(basePath, dep);
        let resolvedURL: string | URL | undefined = isVirtualImport ? importee : undefined;

        for (const { name, resolve: resolveWithPlugin } of plugins) {
          try {
            const result = await resolveWithPlugin?.({
              importee,
              importer,
              exportConditions,
              ...effectiveResolveOptions,
            });

            if (result) {
              resolvedURL = result;
              break;
            }
          } catch (error) {
            throw new Error(
              `[PLUGIN] "${name}" failed on the "resolve" hook.\n\n${getErrorStack(error)}`,
            );
          }
        }

        if (!resolvedURL) {
          try {
            const resolved = (await resolve.async(path.dirname(importer), importee)) as {
              path: string;
            };
            resolvedURL = pathToFileURL(resolved.path);
          } catch {
            console.error(`Failed to resolve "${importee}" from "${importer}".`);
            continue;
          }
        }

        const resolvedLocation = isVirtualImport
          ? undefined
          : typeof resolvedURL === "string"
            ? new URL(resolvedURL)
            : resolvedURL;

        let pathToDependency = importee;
        if (!isVirtualImport) {
          if (!resolvedLocation) {
            continue;
          }

          pathToDependency = toUnix(path.relative(basePath, fileURLToPath(resolvedLocation)));
        }

        if (isExcluded(pathToDependency)) {
          continue;
        }

        let packageRoot: URL | undefined;
        let pkg: string | undefined;
        if (pathToDependency.includes("node_modules") && resolvedLocation) {
          const resolvedPath = fileURLToPath(resolvedLocation);
          const separator = `node_modules${path.sep}`;
          const lastIndex = resolvedPath.lastIndexOf(separator);

          const filePath = resolvedPath.substring(0, lastIndex + separator.length);
          const importSpecifier = resolvedPath.substring(lastIndex + separator.length);

          if (isScopedPackage(importSpecifier)) {
            const split = importSpecifier.split(path.sep);
            pkg = [split[0], split[1]].join(path.sep);
            packageRoot = pathToFileURL(path.join(filePath, pkg));
          } else {
            pkg = importSpecifier.split(path.sep)[0];
            packageRoot = pathToFileURL(path.join(filePath, pkg));
          }
        }

        const module: Module = {
          href: resolvedLocation?.href ?? "",
          pathname: resolvedLocation?.pathname ?? importee,
          path: toRelative(pathToDependency),
          importedBy: [],
          facade: false,
          hasModuleSyntax: !isForeignModule(pathToDependency),
          source: "",
          ...(packageRoot ? { packageRoot } : {}),
        };

        if (isBareModuleSpecifier(importee) && pkg) {
          moduleGraph.externalModules.set(module.pathname, {
            ...module,
            package: pkg,
            importSpecifier: importee,
          });
        }

        if (!isForeignModule(pathToDependency) && !scannedModules.has(pathToDependency)) {
          importsToScan.add(pathToDependency);
        }

        if (!moduleGraph.modules.has(pathToDependency)) {
          moduleGraph.modules.set(pathToDependency, module);
        }

        if (!moduleGraph.graph.has(pathToDependency)) {
          moduleGraph.graph.set(pathToDependency, new Set());
        }

        if (!moduleGraph.graph.has(dep)) {
          moduleGraph.graph.set(dep, new Set());
        }

        moduleGraph.graph.get(dep)?.add(pathToDependency);

        const importedModule = moduleGraph.modules.get(pathToDependency);
        if (importedModule && !importedModule.importedBy.includes(dep)) {
          importedModule.importedBy.push(dep);
        }
      }

      const currentModule = moduleGraph.modules.get(dep);
      if (!currentModule) {
        continue;
      }

      currentModule.source = source;
      currentModule.facade = facade;
      currentModule.hasModuleSyntax = hasModuleSyntax;

      const externalModule = moduleGraph.externalModules.get(currentModule.pathname);
      if (externalModule) {
        externalModule.source = source;
        externalModule.facade = facade;
        externalModule.hasModuleSyntax = hasModuleSyntax;
      }

      for (const { name, analyze } of plugins) {
        try {
          await analyze?.(currentModule);
        } catch (error) {
          throw new Error(
            `[PLUGIN] "${name}" failed on the "analyze" hook.\n\n${getErrorStack(error)}`,
          );
        }
      }
    }
  }

  for (const { name, end } of plugins) {
    try {
      await end?.(moduleGraph);
    } catch (error) {
      throw new Error(`[PLUGIN] "${name}" failed on the "end" hook.\n\n${getErrorStack(error)}`);
    }
  }

  return moduleGraph;
}

export { ModuleGraph };
export type { FindImportChainsOptions, Module, Plugin };
