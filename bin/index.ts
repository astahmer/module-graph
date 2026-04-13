#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { program } from "commander";
import { createModuleGraph } from "../index.js";

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

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

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

program.parse(process.argv);
