import assert from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import { createModuleGraph } from "../index.ts";
import { unusedExports } from "../plugins/unused-exports.ts";
import type { Export } from "../plugins/unused-exports.ts";
import type { ModuleGraph } from "../ModuleGraph.ts";
import type { Plugin } from "../types.ts";
import { extractPackageNameFromSpecifier, isBareModuleSpecifier } from "../utils.ts";

const fixture = (value: string) => path.join(process.cwd(), "test/fixtures", value);
type ModuleGraphWithFoo = ModuleGraph & { foo: string };
type ModuleGraphWithUnusedExports = ModuleGraph & { unusedExports: Export[] };

describe("utils", () => {
  it("isBareModuleSpecifier", () => {
    assert(isBareModuleSpecifier("foo"));
    assert(isBareModuleSpecifier("@foo/bar"));
    assert(!isBareModuleSpecifier("/Users/foo/bar/baz.js"));
    assert(!isBareModuleSpecifier("./foo"));
    assert(!isBareModuleSpecifier("../foo"));
    assert(!isBareModuleSpecifier("#private"));
  });

  it("extractPackageNameFromSpecifier", () => {
    assert.equal(extractPackageNameFromSpecifier("foo/bar/baz.js"), "foo");
    assert.equal(extractPackageNameFromSpecifier("@foo/bar/baz.js"), "@foo/bar");
  });
});

describe("createModuleGraph", () => {
  it("graph-simple", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("graph-simple"),
    });
    assert(moduleGraph.graph.get("index.js")?.has("bar.js"));
    assert(moduleGraph.graph.get("bar.js")?.has("baz.js"));
    assert(moduleGraph.graph.has("baz.js"));

    const uniqueModules = moduleGraph.getUniqueModules();
    assert.deepStrictEqual(uniqueModules, ["index.js", "bar.js", "baz.js"]);

    const chains = moduleGraph.findImportChains("baz.js");
    assert.deepStrictEqual(chains[0], ["index.js", "bar.js", "baz.js"]);
  });

  it("graph-simple `findImportChains` callback", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("graph-simple"),
    });

    const chains = moduleGraph.findImportChains((modulePath) => modulePath.endsWith("baz.js"));
    assert.deepStrictEqual(chains[0], ["index.js", "bar.js", "baz.js"]);
  });

  it("dynamic-import", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("dynamic-import"),
    });
    assert(moduleGraph.graph.get("index.js")?.has("foo.js"));
  });

  it("ignore-dynamic-import", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      ignoreDynamicImport: true,
      basePath: fixture("ignore-dynamic-import"),
    });

    assert(!moduleGraph.graph.get("index.js")?.has("ignore-dynamic-import.js"));
    assert(moduleGraph.graph.get("index.js"));
  });

  it("dynamic-import-in-cjs", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("dynamic-import-in-cjs"),
    });

    assert(moduleGraph.graph.get("index.js")?.has("foo.js"));
    assert(moduleGraph.graph.get("foo.js")?.has("baz.js"));
    assert.equal(moduleGraph.graph.get("foo.js")?.has("bar.js"), false);
    assert(moduleGraph.graph.get("baz.js")?.has("qux.js"));
  });

  it("multiple-entrypoints", async () => {
    const moduleGraph = await createModuleGraph(["./a.js", "./c.js"], {
      basePath: fixture("multiple-entrypoints"),
    });

    assert(moduleGraph.modules.size > 0);
  });

  it("multiple-entrypoints-import-chains", async () => {
    const moduleGraph = await createModuleGraph(["./a.js", "./d.js"], {
      basePath: fixture("multiple-entrypoints-import-chains"),
    });

    const chains = moduleGraph.findImportChains((modulePath) => modulePath.endsWith("c.js"));
    assert.deepStrictEqual(chains[0], ["a.js", "b.js", "c.js"]);
    assert.deepStrictEqual(chains[1], ["d.js", "c.js"]);
  });

  it("circular", async () => {
    const moduleGraph = await createModuleGraph("./a.js", { basePath: fixture("circular") });
    assert.equal(moduleGraph.modules.size, 3);
  });

  it("multiple-entrypoints-import-chains-circular", async () => {
    const moduleGraph = await createModuleGraph(["./a.js", "./d.js"], {
      basePath: fixture("multiple-entrypoints-import-chains-circular"),
    });

    const chains = moduleGraph.findImportChains((modulePath) => modulePath.endsWith("c.js"));
    assert.deepStrictEqual(chains[0], ["a.js", "b.js", "c.js"]);
    assert.deepStrictEqual(chains[1], ["d.js", "c.js"]);
  });

  it("require-in-chain", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("require-in-chain"),
    });
    assert.equal(moduleGraph.modules.size, 2);
  });

  it("import-attributes", async () => {
    const moduleGraph = await createModuleGraph("./index.ts", {
      basePath: fixture("import-attributes"),
      foreignModules: ["**/*.css"],
      external: { ignore: true },
    });

    assert(moduleGraph.graph.get("index.ts")?.has("data.json"));
    assert(moduleGraph.graph.get("index.ts")?.has("styles.css"));
    assert.equal(moduleGraph.modules.get("styles.css")?.hasModuleSyntax, false);
  });

  it("virtual-modules", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("virtual-modules"),
      foreignModules: ["virtual:*"],
      virtualModules: ["virtual:*"],
      external: { ignore: true },
    });

    assert(moduleGraph.graph.get("index.js")?.has("virtual:module"));
    assert.equal(moduleGraph.modules.get("virtual:module")?.hasModuleSyntax, false);
  });

  it("multiple-import-chains", async () => {
    const moduleGraph = await createModuleGraph("./a.js", {
      basePath: fixture("multiple-import-chains"),
    });
    const chains = moduleGraph.findImportChains("c.js");

    assert.equal(chains.length, 2);
    assert.deepStrictEqual(chains[0], ["a.js", "b.js", "c.js"]);
    assert.deepStrictEqual(chains[1], ["a.js", "d.js", "c.js"]);

    const [moduleC] = moduleGraph.get("c.js");
    assert(moduleC);
    assert.deepStrictEqual(moduleC.importedBy, ["b.js", "d.js"]);
  });

  it("resolves-private", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("resolves-private"),
    });
    assert(moduleGraph.graph.get("index.js")?.has("private.js"));
  });

  it("ignores-builtins", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("ignores-builtins"),
    });
    assert.equal(moduleGraph.modules.size, 1);
  });

  it("external-dependencies", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("external-dependencies"),
    });
    const [module] = moduleGraph.get("node_modules/foo/index.js");
    assert(module);
    assert(
      module.packageRoot?.pathname.endsWith("test/fixtures/external-dependencies/node_modules/foo"),
    );
  });

  it("ignore-external", async () => {
    const moduleGraph = await createModuleGraph("./a.js", {
      basePath: fixture("ignore-external"),
      external: {
        ignore: true,
      },
    });

    assert.equal(moduleGraph.modules.size, 2);
    assert.equal(moduleGraph.externalModules.size, 0);
  });

  it("external-exclude", async () => {
    const moduleGraph = await createModuleGraph("./a.js", {
      basePath: fixture("external-exclude"),
      external: {
        exclude: ["foo"],
      },
    });

    assert.equal(moduleGraph.modules.size, 3);
    assert.equal(moduleGraph.externalModules.size, 1);
  });

  it("external-include", async () => {
    const moduleGraph = await createModuleGraph("./a.js", {
      basePath: fixture("external-exclude"),
      external: {
        include: ["foo"],
      },
    });

    assert.equal(moduleGraph.modules.size, 3);
    assert.equal(moduleGraph.externalModules.size, 1);
  });

  it("external ignore AND include throws error", async () => {
    try {
      await createModuleGraph("./a.js", {
        basePath: fixture("ignore-external"),
        external: {
          ignore: true,
          include: ["foo"],
        },
      });
      assert(false);
    } catch (error) {
      assert.equal(
        (error as Error).message,
        'Cannot use both "ignore" and "include" in the external option.',
      );
    }
  });

  it("external-dependencies-scoped-package", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("external-dependencies-scoped-package"),
    });
    const [module] = moduleGraph.get("node_modules/@foo/bar/index.js");

    assert(module);
    assert(
      module.packageRoot?.pathname.endsWith(
        "test/fixtures/external-dependencies-scoped-package/node_modules/@foo/bar",
      ),
    );
  });

  it("external-package-exports-regular", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("external-package-exports-regular"),
    });
    const [module] = moduleGraph.get("node_modules/foo/foo.js");

    assert(module);
    assert(
      module.packageRoot?.pathname.endsWith(
        "test/fixtures/external-package-exports-regular/node_modules/foo",
      ),
    );
  });

  it("monorepo", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("monorepo/packages/foo"),
    });
    const [module] = moduleGraph.get("../../node_modules/bar/index.js");
    assert(module);
    assert(module.packageRoot?.pathname.endsWith("monorepo/node_modules/bar"));
  });

  it("ignores type-only imports", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const moduleGraph = await createModuleGraph("./index.ts", {
        basePath: fixture("typescript-type-imports"),
      });

      assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.ts", "runtime.ts"]);
      assert.equal(errors.length, 0);
    } finally {
      console.error = originalError;
    }
  });

  it("can include type-only imports", async () => {
    const moduleGraph = await createModuleGraph("./index.ts", {
      basePath: fixture("typescript-local-type-imports"),
      includeTypeOnlyImports: true,
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.ts", "types.ts", "runtime.ts"]);
    assert(moduleGraph.graph.get("index.ts")?.has("types.ts"));
  });

  it("resolves extensionless TypeScript imports by default", async () => {
    const moduleGraph = await createModuleGraph("./index.ts", {
      basePath: fixture("typescript-node"),
    });
    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.ts", "foo.ts"]);
  });

  it("resolves .js TypeScript specifiers via extension aliases by default", async () => {
    const moduleGraph = await createModuleGraph("./index.ts", {
      basePath: fixture("typescript"),
      external: { ignore: true },
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.ts", "foo.ts"]);
  });

  it("resolves extensionless TSX imports by default", async () => {
    const moduleGraph = await createModuleGraph("./index.tsx", {
      basePath: fixture("typescript-tsx"),
    });
    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.tsx", "component.tsx"]);
  });
});

describe("plugins", () => {
  it("start", async () => {
    const plugin = {
      name: "start-plugin",
      start: ({ entrypoints, basePath, exportConditions }) => {
        assert.deepStrictEqual(entrypoints, ["index.js"]);
        assert.equal(basePath, fixture("plugins-start"));
        assert.deepStrictEqual(exportConditions, ["node", "import"]);
      },
    } satisfies Plugin;

    await createModuleGraph("./index.js", {
      basePath: fixture("plugins-start"),
      plugins: [plugin],
    });
  });

  it("end", async () => {
    let called = false;
    let graphSize = 0;

    const plugin = {
      name: "end-plugin",
      end: (moduleGraph) => {
        graphSize = moduleGraph.modules.size;
        called = true;
        (moduleGraph as ModuleGraphWithFoo).foo = "bar";
      },
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("plugins-end"),
      plugins: [plugin],
    });

    assert(called);
    assert.equal(graphSize, 2);
    assert.equal((moduleGraph as ModuleGraphWithFoo).foo, "bar");
  });

  it("transformSource", async () => {
    const extractPlugin = {
      name: "transformSource-plugin",
      transformSource: ({ source }) => {
        const match = source.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
        return match ? match[1].trim() : undefined;
      },
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./App.html", {
      basePath: fixture("plugins-transform-source"),
      plugins: [extractPlugin],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["App.html", "Counter.html"]);
  });

  it("handleImport - boolean", async () => {
    const skipPlugin = {
      name: "skip-plugin",
      handleImport: ({ importee }) => {
        if (importee.endsWith("?skip")) {
          return false;
        }

        return undefined;
      },
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("plugins-handle-import-boolean"),
      plugins: [skipPlugin],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.js", "bar.js"]);
  });

  it("handleImport - string", async () => {
    const replacePlugin = {
      name: "replace-plugin",
      handleImport: ({ importee }) => {
        if (importee.endsWith("?replace")) {
          return "./baz.js";
        }

        return undefined;
      },
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("plugins-handle-import-string"),
      plugins: [replacePlugin],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.js", "baz.js", "bar.js"]);
  });

  it("resolve", async () => {
    const resolvePlugin = {
      name: "resolve-plugin",
      resolve: ({ importer, exportConditions }) =>
        moduleResolve("./baz.js", pathToFileURL(importer), new Set(exportConditions)),
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("plugins-resolve"),
      plugins: [resolvePlugin],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), ["index.js", "baz.js"]);
  });

  it("resolve multiple", async () => {
    const resolvePlugin1 = {
      name: "resolve-plugin-1",
      resolve: ({ importer, exportConditions }) =>
        moduleResolve("./baz.js", pathToFileURL(importer), new Set(exportConditions)),
    } satisfies Plugin;

    let called = false;
    const resolvePlugin2 = {
      name: "resolve-plugin-2",
      resolve: () => {
        called = true;
        return undefined;
      },
    } satisfies Plugin;

    await createModuleGraph("./index.js", {
      basePath: fixture("plugins-resolve"),
      plugins: [resolvePlugin1, resolvePlugin2],
    });

    assert.equal(called, false);
  });

  it("analyze", async () => {
    const analyzePlugin = {
      name: "analyze-plugin",
      analyze: (module) => {
        if (module.source.includes("process.env")) {
          module.usesProcessEnv = true;
        }
      },
    } satisfies Plugin;

    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("plugins-analyze"),
      plugins: [analyzePlugin],
    });

    const [result] = moduleGraph.get("bar.js");
    assert(result);
    assert(result.usesProcessEnv);
  });

  it("exclude", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("exclude"),
      exclude: ["ignore.js", "**/ignore-me.js", "**/quux/*.js"],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), [
      "index.js",
      "foo.js",
      "bar.js",
      "node_modules/qux/index.js",
    ]);
  });

  it("exclude callback", async () => {
    const moduleGraph = await createModuleGraph("./index.js", {
      basePath: fixture("exclude"),
      exclude: [
        (importee) =>
          importee.endsWith("ignore.js") ||
          importee.endsWith("ignore-me.js") ||
          importee.includes("/quux/"),
      ],
    });

    assert.deepStrictEqual(moduleGraph.getUniqueModules(), [
      "index.js",
      "foo.js",
      "bar.js",
      "node_modules/qux/index.js",
    ]);
  });
});

describe("built-in plugins", () => {
  it("unused exports", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 2);
    assert.equal(moduleGraph.unusedExports[0].name, "b1");
    assert.equal(moduleGraph.unusedExports[0].declaration.name, "b1");
    assert.equal(moduleGraph.unusedExports[0].declaration.module, "b.js");
    assert.equal(moduleGraph.unusedExports[1].name, "default");
    assert.equal(moduleGraph.unusedExports[1].declaration.name, "c1");
    assert.equal(moduleGraph.unusedExports[1].declaration.module, "c.js");
  });

  it("unused exports alias", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports-alias"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 0);
  });

  it("unused exports aggregate", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports-aggregate"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 0);
  });

  it("unused exports reexport named", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports-reexport-named"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 0);
  });

  it("unused exports reexport default", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports-reexport-default"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 0);
  });

  it("unused exports reexport aggregate", async () => {
    const moduleGraph = (await createModuleGraph("./a.js", {
      basePath: fixture("unused-exports-reexport-aggregate"),
      plugins: [unusedExports],
    })) as ModuleGraphWithUnusedExports;

    assert.equal(moduleGraph.unusedExports.length, 0);
  });
});
