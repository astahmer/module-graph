import path from "node:path";
import * as picomatchModule from "picomatch";
import type { ExternalModule, FindImportChainsOptions, Module } from "./types.ts";
import { toUnix } from "./utils.ts";

type ModuleMatcher = string | ((modulePath: string) => boolean);
type PicomatchFactory = ((pattern: string) => (value: string) => boolean) & {
  scan?: (pattern: string) => { isGlob: boolean };
};

const picomatch = ("default" in picomatchModule
  ? picomatchModule.default
  : picomatchModule) as unknown as PicomatchFactory;

export class ModuleGraph {
  graph = new Map<string, Set<string>>();

  private exactImportChainsIndexes = new Map<number, Map<string, string[][]>>();

  private knownModulePathsCache?: Set<string>;

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
    if (this.knownModulePathsCache) {
      return this.knownModulePathsCache;
    }

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

    this.knownModulePathsCache = modulePaths;
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

  private normalizeMaxChains(maxChains?: number): number {
    if (maxChains === undefined) {
      return Number.POSITIVE_INFINITY;
    }

    if (!Number.isFinite(maxChains) || maxChains < 1) {
      return 0;
    }

    return Math.floor(maxChains);
  }

  private getExactImportChainsIndex(maxChains: number): Map<string, string[][]> {
    const cachedIndex = this.exactImportChainsIndexes.get(maxChains);
    if (cachedIndex) {
      return cachedIndex;
    }

    const chainsByModule = new Map<string, string[][]>();

    for (const modulePath of this.getKnownModulePaths()) {
      chainsByModule.set(modulePath, []);
    }

    const dfs = (modulePath: string, chain: string[]): void => {
      const moduleChains = chainsByModule.get(modulePath);
      if (!moduleChains || moduleChains.length >= maxChains) {
        return;
      }

      moduleChains.push(chain);

      const dependencies = this.graph.get(modulePath);
      if (!dependencies) {
        return;
      }

      for (const dependency of dependencies) {
        if (chain.includes(dependency)) {
          continue;
        }

        dfs(dependency, [...chain, dependency]);
      }
    };

    for (const entrypoint of this.relativeEntrypoints) {
      dfs(entrypoint, [entrypoint]);
    }

    this.exactImportChainsIndexes.set(maxChains, chainsByModule);
    return chainsByModule;
  }

  findImportChains(targetModule: ModuleMatcher, options: FindImportChainsOptions = {}): string[][] {
    const maxChains = this.normalizeMaxChains(options.maxChains);
    if (maxChains === 0) {
      return [];
    }

    if (typeof targetModule === "string" && this.isExactModuleTarget(targetModule)) {
      return this.getExactImportChainsIndex(maxChains).get(targetModule) ?? [];
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
      if (chains.length >= maxChains || !modulesThatCanReachTarget.has(modulePath)) {
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
        if (chains.length >= maxChains) {
          return;
        }
      }
    };

    for (const entrypoint of this.relativeEntrypoints) {
      if (chains.length >= maxChains) {
        break;
      }

      if (modulesThatCanReachTarget.has(entrypoint)) {
        dfs(entrypoint, [entrypoint]);
      }
    }

    return chains;
  }
}
