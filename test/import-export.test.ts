import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXTENSION_EXPORT_SCHEMA,
  handleExportSubcommand,
  handleImportSubcommand,
} from "../src/commands/import-export.js";
import { createMockHarness } from "./helpers/mocks.js";
import { mockPackageCatalog } from "./helpers/package-catalog.js";

void test("/extensions export writes selected install recipes with scope and local warnings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-export-"));
  const exportPath = join(cwd, "pi-extensions-export.json");
  const restoreCatalog = mockPackageCatalog({
    packages: [
      { source: "npm:pi-foo", name: "pi-foo", scope: "global" },
      { source: "/Users/roaanv/dev/global-baz", name: "global-baz", scope: "global" },
      { source: "git:https://github.com/example/pi-bar.git", name: "pi-bar", scope: "project" },
      { source: "/Users/roaanv/dev/pi-baz", name: "pi-baz", scope: "project" },
    ],
  });

  try {
    const { pi, ctx, selectPrompts, notifications } = createMockHarness({
      cwd,
      hasUI: true,
      selectResult: "Export all selected (4)",
    });
    let exportChoices: string[] | undefined;
    const originalSelect = ctx.ui.select;
    (
      ctx.ui as { select: (title: string, items?: string[]) => Promise<string | undefined> }
    ).select = (title, items) => {
      exportChoices = items;
      return originalSelect(title, items ?? []);
    };

    await handleExportSubcommand([], ctx, pi);

    const parsed = JSON.parse(await readFile(exportPath, "utf8"));
    assert.equal(parsed.schema, EXTENSION_EXPORT_SCHEMA);
    assert.deepEqual(
      parsed.extensions.map(
        (entry: { source: string; scope: string; kind: string; localSourceRequired: boolean }) => ({
          source: entry.source,
          scope: entry.scope,
          kind: entry.kind,
          localSourceRequired: entry.localSourceRequired,
        })
      ),
      [
        { source: "npm:pi-foo", scope: "global", kind: "npm", localSourceRequired: false },
        {
          source: "/Users/roaanv/dev/global-baz",
          scope: "global",
          kind: "local",
          localSourceRequired: true,
        },
        {
          source: "git:https://github.com/example/pi-bar.git",
          scope: "project",
          kind: "git",
          localSourceRequired: false,
        },
        {
          source: "/Users/roaanv/dev/pi-baz",
          scope: "project",
          kind: "local",
          localSourceRequired: true,
        },
      ]
    );
    assert.deepEqual(selectPrompts, ["Select extensions to export"]);
    assert.deepEqual(exportChoices, [
      "Export all selected (4)",
      "Global",
      "  npm/git installed",
      "    [x] 1. npm:npm:pi-foo",
      "  local install",
      "    [x] 2. local:/Users/roaanv/dev/global-baz ⚠ local source required",
      "Project local",
      "  npm/git installed",
      "    [x] 3. git:git:https://github.com/example/pi-bar.git",
      "  local install",
      "    [x] 4. local:/Users/roaanv/dev/pi-baz ⚠ local source required",
      "Cancel",
    ]);
    assert.ok(notifications.some((entry) => entry.message.includes("Exported 4")));
  } finally {
    restoreCatalog();
  }
});

void test("/extensions import preserves scope, skips existing entries when prompted, and installs new recipes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-import-"));
  const exportPath = join(cwd, "recipes.json");
  await writeFile(
    exportPath,
    JSON.stringify({
      schema: EXTENSION_EXPORT_SCHEMA,
      createdAt: new Date().toISOString(),
      extensions: [
        { source: "npm:already-installed", scope: "global" },
        { source: "git:https://github.com/example/new-one.git", scope: "project" },
      ],
    })
  );

  const installs: { source: string; scope: string }[] = [];
  const restoreCatalog = mockPackageCatalog({
    packages: [{ source: "npm:already-installed", name: "already-installed", scope: "global" }],
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx, notifications } = createMockHarness({
      cwd,
      hasUI: true,
      confirmResult: false,
    });
    const selectResults = ["Import all selected (2)", "Skip"];
    (
      ctx.ui as { select: (title: string, items?: string[]) => Promise<string | undefined> }
    ).select = () => Promise.resolve(selectResults.shift());

    await handleImportSubcommand([exportPath], ctx, pi);

    assert.deepEqual(installs, [
      { source: "git:https://github.com/example/new-one.git", scope: "project" },
    ]);
    assert.ok(
      notifications.some((entry) =>
        entry.message.includes("Import complete: 1 installed, 1 skipped")
      )
    );
  } finally {
    restoreCatalog();
  }
});

void test("/extensions import warns and skips missing local sources", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-extmgr-import-local-"));
  const exportPath = join(cwd, "recipes.json");
  await writeFile(
    exportPath,
    JSON.stringify({
      schema: EXTENSION_EXPORT_SCHEMA,
      createdAt: new Date().toISOString(),
      extensions: [{ source: join(cwd, "missing-extension"), scope: "project" }],
    })
  );

  const installs: { source: string; scope: string }[] = [];
  const restoreCatalog = mockPackageCatalog({
    installImpl: (source, scope) => {
      installs.push({ source, scope });
    },
  });

  try {
    const { pi, ctx, notifications } = createMockHarness({
      cwd,
      hasUI: true,
      selectResult: "Import all selected (1)",
    });

    await handleImportSubcommand([exportPath], ctx, pi);

    assert.deepEqual(installs, []);
    assert.ok(notifications.some((entry) => entry.message.includes("local source does not exist")));
  } finally {
    restoreCatalog();
  }
});
