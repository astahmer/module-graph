import path from "path";
import { toUnix } from "./utils.js";
import * as pm from 'picomatch';

const picomatch = pm.default;

/**
 * @typedef {import('./types.js').Module} Module
 * @typedef {import('./types.js').ExternalModule} ExternalModule
 */

export class ModuleGraph {
  /**
   * @param {string} basePath
   * @param {string | string[]} entrypoints
   */
  constructor(basePath, entrypoints) {
    const normalizedEntrypoints = (typeof entrypoints === 'string' ? [entrypoints] : entrypoints)
      .map((entrypoint) => toUnix(path.normalize(entrypoint)));

    /**
     * @type {Map<string, Set<string>>}
     */
    this.graph = new Map();
    this.entrypoints = normalizedEntrypoints;
    this.relativeEntrypoints = normalizedEntrypoints.map((entrypoint) => (
      path.isAbsolute(entrypoint)
        ? toUnix(path.relative(basePath, entrypoint))
        : entrypoint
    ));
    this.basePath = basePath;
    /**
     * @type {Map<string, ExternalModule>}
     */
    this.externalModules = new Map();
    /**
     * @type {Map<string, Module>}
     */
    this.modules = new Map();
  }

  /**
   * @param {string | ((path: string) => boolean)} targetModule
   * @returns {Array<Module>}
   */
  get(targetModule) {
    const match = typeof targetModule === 'function' ? targetModule : picomatch(targetModule);
    const result = [];

    for (const [module, value] of this.modules.entries()) {
      if (match(module)) {
        result.push(value);
      }
    }

    return result;
  }

  /**
   * @returns {string[]}
   */
  getUniqueModules() {
    const uniqueModules = new Set();

    for (const [module, dependencies] of this.graph.entries()) {
      uniqueModules.add(module);
      for (const dependency of dependencies) {
        uniqueModules.add(dependency);
      }
    }

    return [...uniqueModules].map((p) => toUnix(path.relative(this.basePath, path.join(this.basePath, p))));
  }

  /**
   * @param {string | ((path: string) => boolean)} targetModule
   * @returns {string[][]}
   */
  findImportChains(targetModule) {
    /**
   * @type {string[][]}
   */
    const chains = [];
    const match = typeof targetModule === 'function' ? targetModule : picomatch(targetModule);

    /**
     * @param {string} module
     * @param {string[]} chain
     * @returns
     */
    const dfs = (module, chain) => {
      if (match(module)) {
        chains.push(chain);
        return;
      }

      const dependencies = this.graph.get(module);
      if (dependencies) {
        for (const dependency of dependencies) {
          if (chain.includes(dependency)) {
            continue;
          }

          dfs(dependency, [...chain, dependency]);
        }
      }
    };

    for (const entrypoint of this.relativeEntrypoints) {
      dfs(entrypoint, [entrypoint]);
    }

    return chains;
  }
}
