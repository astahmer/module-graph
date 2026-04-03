import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { builtinModules } from "module";
import { createFilter, normalizePath } from '@rollup/pluginutils';
import { parseSync } from 'oxc-parser';
import { ResolverFactory } from 'oxc-resolver';
import { ModuleGraph } from "./ModuleGraph.js";
import { extractPackageNameFromSpecifier, isBareModuleSpecifier, isScopedPackage, toUnix } from "./utils.js";

const DEFAULT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.node'];
const DEFAULT_EXTENSION_ALIAS = {
  '.js': ['.js', '.ts', '.tsx', '.jsx'],
  '.jsx': ['.jsx', '.tsx', '.ts', '.js'],
  '.mjs': ['.mjs', '.mts'],
  '.cjs': ['.cjs', '.cts'],
};

/**
 * @param {Array<string | ((id: string) => boolean)>} patterns
 */
const createPathMatcher = (patterns) => {
  const callbacks = /** @type {Array<(id: string) => boolean>} */ (
    patterns.filter((pattern) => typeof pattern === 'function')
  );
  const globs = /** @type {string[]} */ (
    patterns.filter((pattern) => typeof pattern === 'string')
  );
  const globFilter = globs.length > 0 ? createFilter(globs, null, { resolve: false }) : () => false;

  /** @param {string} id */
  return (id) => globFilter(normalizePath(id)) || callbacks.some((match) => match(id));
};

/**
 * @typedef {import('./types.js').Module} Module
 * @typedef {import('./types.js').Plugin} Plugin
 * @typedef {import('oxc-resolver').NapiResolveOptions} NapiResolveOptions
 */

/**
 * @param {string | string[]} entrypoints
 * @param {NapiResolveOptions & {
 *  plugins?: Plugin[],
 *  basePath?: string,
 *  external?: {
 *   ignore?: boolean,
 *   include?: string[],
 *   exclude?: string[]
 *  },
 *  exportConditions?: NapiResolveOptions["conditionNames"],
 *  includeTypeOnlyImports?: boolean,
 *  ignoreDynamicImport?: boolean,
 *  exclude?: Array<string | ((importee: string) => boolean)>,
 *  foreignModules?: Array<string | ((importee: string) => boolean)>,
 *  virtualModules?: Array<string | ((importee: string) => boolean)>,
 * }} options
 * @returns {Promise<ModuleGraph>}
 */
export async function createModuleGraph(entrypoints, options = {}) {
  const {
    plugins = [],
    basePath = process.cwd(),
    exportConditions = ["node", "import"],
    includeTypeOnlyImports = false,
    ignoreDynamicImport = false,
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

  const processedEntrypoints = (typeof entrypoints === "string" ? [entrypoints] : entrypoints);
  /** @param {string} e */
  const toRelative = (e) => {
    const absEntryPoint = e.startsWith(basePath) ? e : path.join(basePath, e);
    return toUnix(path.relative(basePath, absEntryPoint));
  }
  const modules = processedEntrypoints.map(toRelative);

  /**
   * @param {string} request
   * @returns {string | undefined}
   */
  const getLiteralImportSpecifier = (request) => {
    const quote = request.at(0);
    if (!quote || request.length < 2) {
      return undefined;
    }
    if ((quote !== '"' && quote !== "'" && quote !== '`') || request.at(-1) !== quote) {
      return undefined;
    }
    const unwrapped = request.slice(1, -1);
    if (quote === '`' && unwrapped.includes('${')) {
      return undefined;
    }
    return unwrapped;
  };

  /**
   * @param {string} filename
   * @param {string} source
   */
  const getModuleInfo = (filename, source) => {
    const result = parseSync(filename, source);
    if (result.errors.length > 0) {
      throw new Error(result.errors.map((error) => error.message).join('\n'));
    }

    const imports = [];

    for (const staticImport of result.module.staticImports) {
      const isTypeOnly = staticImport.entries.length > 0 && staticImport.entries.every((entry) => entry.isType);
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

  /**
   * [PLUGINS] - start
   */
  for (const { name, start } of plugins) {
    if (!name) {
      throw new Error('Plugin must have a name');
    }

    try {
      await start?.({
        entrypoints: modules,
        basePath,
        exportConditions,
      });
    } catch (e) {
      const { stack } = /** @type {Error} */ (e);
      const error = new Error(`[PLUGIN] "${name}" failed on the "start" hook.\n\n${stack}`);
      throw error;
    }
  }

  const importsToScan = new Set([...modules]);

  let moduleGraph = new ModuleGraph(basePath, entrypoints);
  for (const module of modules) {
    const url = pathToFileURL(module);
    moduleGraph.modules.set(module, {
      href: url.href,
      pathname: url.pathname,
      path: module,
      source: '',
      facade: false,
      hasModuleSyntax: true,
      importedBy: []
    });

    moduleGraph.graph.set(module, new Set());
  }

  while (importsToScan.size) {
    for (const dep of importsToScan) {
      importsToScan.delete(dep);
      const filename = path.join(basePath, dep);
      let source = fs.readFileSync(filename).toString();

      /**
       * [PLUGINS] - transformSource
       */
      for (const { name, transformSource } of plugins) {
        try {
          const result = await /** @type {void | string} */ (transformSource?.({
            filename,
            source,
          }));

          if (result) {
            source = result;
          }
        } catch (e) {
          const { stack } = /** @type {Error} */ (e);
          const error = new Error(`[PLUGIN] "${name}" failed on the "transformSource" hook.\n\n${stack}`);
          throw error;
        }
      }

      const { imports, facade, hasModuleSyntax } = getModuleInfo(filename, source);
      importLoop: for (let { n: importee, isDynamic, isTypeOnly } of imports) {
        if (!importee) continue;
        if (!includeTypeOnlyImports && isTypeOnly) continue;
        const isVirtualImport = isVirtualModule(/** @type {string} */(importee));
        if (ignoreDynamicImport && isDynamic) continue;
        if (!isForeignModule(/** @type {string} */(importee)) && !isVirtualImport) {
          if (isBareModuleSpecifier(importee) && external.ignore) continue;
          if (isBareModuleSpecifier(importee) && external.exclude?.length && external.exclude?.includes(extractPackageNameFromSpecifier(importee))) continue;
          if (isBareModuleSpecifier(importee) && external.include?.length && !external.include?.includes(extractPackageNameFromSpecifier(importee))) continue;
        }

        /**
         * [PLUGINS] - handleImport
         */
        for (const { name, handleImport } of plugins) {
          try {
            const result = await /** @type {void | boolean | string} */ (handleImport?.({
              source,
              importer: dep,
              importee,
            }));

            if (typeof result === 'string') {
              importee = result;
            } else if (result === false) {
              continue importLoop;
            }
          } catch (e) {
            const { stack } = /** @type {Error} */ (e);
            const error = new Error(`[PLUGIN] "${name}" failed on the "handleImport" hook.\n\n${stack}`);
            throw error;
          }
        }
        /** Skip built-in modules like fs, path, etc */
        if (builtinModules.includes(importee.replace("node:", ""))) continue;

        /**
         * Resolve the module's location
         */
        const importer = path.join(basePath, dep);
        /**
         * [PLUGINS] - resolve
         */
        let resolvedURL;
        if (isVirtualImport) {
          resolvedURL = importee;
        }
        for (const { name, resolve } of plugins) {
          try {
            const result = await resolve?.({
              importee,
              importer,
              exportConditions,
              ...effectiveResolveOptions,
            });

            if (result) {
              resolvedURL = result;
              break;
            }
          } catch (e) {
            const { stack } = /** @type {Error} */ (e);
            const error = new Error(`[PLUGIN] "${name}" failed on the "resolve" hook.\n\n${stack}`);
            throw error;
          }
        }

        /**
         * If no plugins resolved the URL, defer to default resolution
         */
        if (!resolvedURL) {
          try {
            const resolved = /** @type {{path: string}} */ (await resolve.async(path.dirname(importer), importee));
            resolvedURL = pathToFileURL(resolved.path);
          } catch (e) {
            console.error(`Failed to resolve "${importee}" from "${importer}".`);
            continue;
          }
        }
        const pathToDependency = isVirtualImport
          ? importee
          : toUnix(path.relative(basePath, fileURLToPath(resolvedURL)));

        /**
         * Handle excludes, we do this here, because we want the resolved file paths, like
         * `node_modules/foo/index.js` to be excluded, not the importee, which would just be `foo`
         */
        if (isExcluded(/** @type {string} */(pathToDependency))) {
          continue;
        }

        /**
         * Get the packageRoot of the external dependency, which is useful for getting
         * to the package.json, for example. You can't always `require.resolve` it,
         * if it's not included in the packages package exports.
         */
        let packageRoot;
        let pkg;
        if (pathToDependency.includes('node_modules')) {
          const resolvedPath = fileURLToPath(resolvedURL);
          const separator = 'node_modules' + path.sep;
          const lastIndex = resolvedPath.lastIndexOf(separator);

          const filePath = resolvedPath.substring(0, lastIndex + separator.length);
          const importSpecifier = resolvedPath.substring(lastIndex + separator.length);
          /**
           * @example "@foo/bar"
           */
          if (isScopedPackage(importSpecifier)) {
            const split = importSpecifier.split(path.sep);
            pkg = [split[0], split[1]].join(path.sep);
            packageRoot = pathToFileURL(path.join(filePath, pkg));
          } else {
            pkg = importSpecifier.split(path.sep)[0];
            packageRoot = pathToFileURL(path.join(filePath, pkg));
          }
        }

        /** @type {Module} */
        const module = {
          href: typeof resolvedURL === 'object' ? resolvedURL.href : '',
          pathname: typeof resolvedURL === 'object' ? resolvedURL.pathname : importee,
          path: toRelative(pathToDependency),
          importedBy: [],
          facade: false,
          hasModuleSyntax: !isForeignModule(/** @type {string} */(pathToDependency)),
          source: '',
          ...(packageRoot ? { packageRoot } : {}),
        }

        if (isBareModuleSpecifier(importee)) {
          moduleGraph.externalModules.set(module.pathname, {
            ...module,
            package: /** @type {string} */ (pkg),
            importSpecifier: importee
          });
        }

        if (
          !isForeignModule(/** @type {string} */(pathToDependency)) &&
          !moduleGraph.graph.has(pathToDependency)
        ) {
          importsToScan.add(pathToDependency);
        }

        if (!moduleGraph.modules.has(pathToDependency)) {
          moduleGraph.modules.set(pathToDependency, module);
        }
        if (!moduleGraph.graph.has(dep)) {
          moduleGraph.graph.set(dep, new Set());
        }
        /** @type {Set<string>} */ (moduleGraph.graph.get(dep)).add(pathToDependency);

        const importedModule = moduleGraph.modules.get(pathToDependency);
        if (importedModule && !importedModule.importedBy.includes(dep)) {
          importedModule.importedBy.push(dep);
        }
      };

      /**
       * Add `source` code to the Module
       */
      const currentModule = /** @type {Module} */ (moduleGraph.modules.get(dep));
      currentModule.source = source;
      currentModule.facade = facade;
      currentModule.hasModuleSyntax = hasModuleSyntax;

      const externalModule = moduleGraph.externalModules.get(currentModule.pathname);
      if (externalModule) {
        externalModule.source = source;
        externalModule.facade = facade;
        externalModule.hasModuleSyntax = hasModuleSyntax;
      }

      /**
       * [PLUGINS] - analyze
       */
      for (const { name, analyze } of plugins) {
        try {
          await analyze?.(currentModule);
        } catch (e) {
          const { stack } = /** @type {Error} */ (e);
          const error = new Error(`[PLUGIN] "${name}" failed on the "analyze" hook.\n\n${stack}`);
          throw error;
        }
      }
    };
  }

  /**
   * [PLUGINS] - end
   */
  for (const { name, end } of plugins) {
    try {
      await end?.(moduleGraph);
    } catch (e) {
      const { stack } = /** @type {Error} */ (e);
      const error = new Error(`[PLUGIN] "${name}" failed on the "end" hook.\n\n${stack}`);
      throw error;
    }
  }

  return moduleGraph;
}
