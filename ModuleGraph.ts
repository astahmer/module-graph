import path from "node:path";
import * as picomatchModule from "picomatch";
import type { ExternalModule, Module } from "./types.js";
import { toUnix } from "./utils.js";

type ModuleMatcher = string | ((modulePath: string) => boolean);
type PicomatchFactory = (pattern: string) => (value: string) => boolean;

const picomatch = ("default" in picomatchModule
  ? picomatchModule.default
  : picomatchModule) as unknown as PicomatchFactory;

export class ModuleGraph {
  graph = new Map<string, Set<string>>();

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

  findImportChains(targetModule: ModuleMatcher): string[][] {
    const chains: string[][] = [];
    const match = typeof targetModule === "function" ? targetModule : picomatch(targetModule);

    const dfs = (modulePath: string, chain: string[]): void => {
      if (match(modulePath)) {
        chains.push(chain);
        return;
      }

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

    return chains;
  }
}
