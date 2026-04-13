#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { program } from "commander";
import { createModuleGraph } from "../index.ts";

function ensureRelative(filePath: string): string {
  if (!filePath.startsWith("./") && !filePath.startsWith("../")) {
    return `./${filePath}`;
  }

  return filePath;
}

function parseEntrypoints(entrypoint: string): string[] {
  return entrypoint
    .split(",")
    .map((value) => value.trim())
    .map(ensureRelative);
}

export function readPackageVersion(moduleUrl: string | URL = import.meta.url): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const packageJson = JSON.parse(readFileSync(new URL(candidate, moduleUrl), "utf8")) as {
        version: string;
      };

      return packageJson.version;
    } catch (error) {
      const errorWithCode = error as NodeJS.ErrnoException;
      if (errorWithCode.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error("Unable to locate package.json for CLI version lookup.");
}

const packageJson = { version: readPackageVersion() };

program
  .name("module-graph")
  .description("CLI for analyzing JavaScript and TypeScript module graphs")
  .version(packageJson.version);

program
  .command("find <entrypoint>")
  .argument("<pattern>", "Module to find")
  .description("Output the import chain for a given module")
  .action(async (entrypoint: string, pattern: string) => {
    const graph = await createModuleGraph(parseEntrypoints(entrypoint));

    for (const module of graph.get(pattern)) {
      console.log(module);
    }
  });

program
  .command("import-chain <entrypoint>")
  .argument("<pattern>", "Module to find import chain for")
  .description("Output the import chain for a given module")
  .action(async (entrypoint: string, pattern: string) => {
    const graph = await createModuleGraph(parseEntrypoints(entrypoint));

    let index = 0;
    for (const chain of graph.findImportChains(pattern)) {
      console.log(`Chain ${++index}:`);
      for (const chainItem of chain) {
        console.log(chainItem);
      }
      console.log();
    }
  });

program.argument("<entrypoint>", "Entrypoint").action(async (entrypoint: string) => {
  const graph = await createModuleGraph(parseEntrypoints(entrypoint));

  for (const module of graph.getUniqueModules()) {
    console.log(module);
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await program.parseAsync(process.argv);
}
