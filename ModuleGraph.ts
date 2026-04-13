import path from "node:path";
import * as picomatchModule from "picomatch";
import type { ExternalModule, Module } from "./types.js";
import { toUnix } from "./utils.js";

type ModuleMatcher = string | ((modulePath: string) => boolean);
type PicomatchFactory = ((pattern: string) => (value: string) => boolean) & {
  scan?: (pattern: string) => { isGlob: boolean };
};

const picomatch = ("default" in picomatchModule
  ? picomatchModule.default
  : picomatchModule) as unknown as PicomatchFactory;

export class ModuleGraph {
  graph = new Map<string, Set<string>>();

  private exactImportChainsCache = new Map<string, string[][]>();

  private reverseGraphCache?: Map<string, string[]>;

  entrypoints: string[];

  relativeEntrypoints: string[];

  basePath: string;

  externalModules = new Map<string, ExternalModule>();

  modules = new Map<string, Module>();

  constructor(basePath: string, entrypoints: string | string[]) {
    const normalizedEntrypoints = (
      typeof entrypoints === "string" ? [entrypoints] : entrypoints
    ).map((entrypoint) => toUnix(path.normalize(entrypoint)));

    this.entrypoints = normalizedEntrypoints;
    this.relativeEntrypoints = normalizedEntrypoints.map((entrypoint) =>
      path.isAbsolute(entrypoint) ? toUnix(path.relative(basePath, entrypoint)) : entrypoint,
    );
    this.basePath = basePath;
  }

  get(targetModule: ModuleMatcher): Array<Module> {
    const match = typeof targetModule === "function" ? targetModule : picomatch(targetModule);
    const result: Array<Module> = [];

    for (const [modulePath, module] of this.modules.entries()) {
      if (match(modulePath)) {
        result.push(module);
      }
    }

    return result;
  }

  getUniqueModules(): string[] {
    const uniqueModules = new Set<string>();

    for (const [modulePath, dependencies] of this.graph.entries()) {
      uniqueModules.add(modulePath);
      for (const dependency of dependencies) {
        uniqueModules.add(dependency);
      }
    }

    return [...uniqueModules].map((modulePath) =>
      toUnix(path.relative(this.basePath, path.join(this.basePath, modulePath))),
    );
  }

  private getKnownModulePaths(): Set<string> {
    const modulePaths = new Set<string>(this.relativeEntrypoints);

    for (const modulePath of this.modules.keys()) {
      modulePaths.add(modulePath);
    }

    for (const [modulePath, dependencies] of this.graph.entries()) {
      modulePaths.add(modulePath);
      for (const dependency of dependencies) {
        modulePaths.add(dependency);
      }
    }

    return modulePaths;
  }

  private getReverseGraph(): Map<string, string[]> {
    if (this.reverseGraphCache) {
      return this.reverseGraphCache;
    }

    const reverseGraph = new Map<string, string[]>();

    for (const modulePath of this.getKnownModulePaths()) {
      reverseGraph.set(modulePath, []);
    }

    for (const [modulePath, dependencies] of this.graph.entries()) {
      for (const dependency of dependencies) {
        reverseGraph.get(dependency)?.push(modulePath);
      }
    }

    this.reverseGraphCache = reverseGraph;
    return reverseGraph;
  }

  private isExactModuleTarget(targetModule: string): boolean {
    const isGlob = picomatch.scan?.(targetModule).isGlob ?? /[*?[\]{}]/.test(targetModule);

    return !isGlob && this.getKnownModulePaths().has(targetModule);
  }

  private findExactImportChains(targetModule: string): string[][] {
    const cachedChains = this.exactImportChainsCache.get(targetModule);
    if (cachedChains) {
      return cachedChains;
    }

    const reverseGraph = this.getReverseGraph();
    const inProgress = new Set<string>();

    const buildChains = (modulePath: string): string[][] => {
      const memoizedChains = this.exactImportChainsCache.get(modulePath);
      if (memoizedChains) {
        return memoizedChains;
      }

      if (inProgress.has(modulePath)) {
        return [];
      }

      inProgress.add(modulePath);

      const chains: string[][] = [];
      for (const importer of reverseGraph.get(modulePath) ?? []) {
        for (const importerChain of buildChains(importer)) {
          if (!importerChain.includes(modulePath)) {
            chains.push([...importerChain, modulePath]);
          }
        }
      }

      if (chains.length === 0 && this.relativeEntrypoints.includes(modulePath)) {
        chains.push([modulePath]);
      }

      inProgress.delete(modulePath);
      this.exactImportChainsCache.set(modulePath, chains);

      return chains;
    };

    return buildChains(targetModule);
  }

  findImportChains(targetModule: ModuleMatcher): string[][] {
    if (typeof targetModule === "string" && this.isExactModuleTarget(targetModule)) {
      return this.findExactImportChains(targetModule);
    }

    const chains: string[][] = [];
    const match = typeof targetModule === "function" ? targetModule : picomatch(targetModule);
    const reverseGraph = this.getReverseGraph();
    const matchingModules = new Set<string>();

    for (const modulePath of this.getKnownModulePaths()) {
      if (match(modulePath)) {
        matchingModules.add(modulePath);
      }
    }

    if (matchingModules.size === 0) {
      return chains;
    }

    const modulesThatCanReachTarget = new Set<string>(matchingModules);
    const importersToVisit = [...matchingModules];

    while (importersToVisit.length > 0) {
      const currentModule = importersToVisit.pop();
      if (!currentModule) {
        continue;
      }

      for (const importer of reverseGraph.get(currentModule) ?? []) {
        if (!modulesThatCanReachTarget.has(importer)) {
          modulesThatCanReachTarget.add(importer);
          importersToVisit.push(importer);
        }
      }
    }

    const dfs = (modulePath: string, chain: string[]): void => {
      if (!modulesThatCanReachTarget.has(modulePath)) {
        return;
      }

      if (match(modulePath)) {
        chains.push(chain);
        return;
      }

      const dependencies = this.graph.get(modulePath);
      if (!dependencies) {
        return;
      }

      for (const dependency of dependencies) {
        if (chain.includes(dependency) || !modulesThatCanReachTarget.has(dependency)) {
          continue;
        }

        dfs(dependency, [...chain, dependency]);
      }
    };

    for (const entrypoint of this.relativeEntrypoints) {
      if (modulesThatCanReachTarget.has(entrypoint)) {
        dfs(entrypoint, [entrypoint]);
      }
    }

    return chains;
  }
}
