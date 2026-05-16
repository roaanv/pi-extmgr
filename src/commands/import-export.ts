import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getPackageCatalog } from "../packages/catalog.js";
import { type InstalledPackage, type Scope } from "../types/index.js";
import { notify, error as notifyError, success } from "../utils/notify.js";
import { fileExists } from "../utils/fs.js";
import { logPackageInstall } from "../utils/history.js";
import {
  getPackageSourceKind,
  normalizePackageIdentity,
  parsePackageNameAndVersion,
  type PackageSourceKind,
} from "../utils/package-source.js";
import { updateExtmgrStatus } from "../utils/status.js";
import { confirmReload } from "../utils/ui-helpers.js";

export const DEFAULT_EXTENSION_EXPORT_FILE = "pi-extensions-export.json";
export const EXTENSION_EXPORT_SCHEMA = "pi-extmgr.extension-install-export.v1";

const EXPORT_ALL_LABEL = "Export all selected";
const IMPORT_ALL_LABEL = "Import all selected";
const CANCEL_LABEL = "Cancel";
const SKIP_LABEL = "Skip";
const REINSTALL_LABEL = "Reinstall";

export interface ExtensionInstallRecipe {
  source: string;
  scope: Scope;
  kind: PackageSourceKind;
  localSourceRequired: boolean;
}

export interface ExtensionInstallExportFile {
  schema: typeof EXTENSION_EXPORT_SCHEMA;
  createdAt: string;
  extensions: ExtensionInstallRecipe[];
}

function resolveExportPath(ctx: ExtensionCommandContext, maybePath?: string): string {
  const target = maybePath?.trim() || DEFAULT_EXTENSION_EXPORT_FILE;
  return isAbsolute(target) ? target : resolve(ctx.cwd, target);
}

function scopeBaseCwd(scope: Scope, ctx: ExtensionCommandContext): string {
  return scope === "project" ? ctx.cwd : getAgentDir();
}

function recipeFromPackage(pkg: InstalledPackage): ExtensionInstallRecipe {
  const kind = getPackageSourceKind(pkg.source);
  return {
    source: pkg.source,
    scope: pkg.scope,
    kind,
    localSourceRequired: kind === "local",
  };
}

function recipeIdentity(recipe: ExtensionInstallRecipe, ctx: ExtensionCommandContext): string {
  return normalizePackageIdentity(recipe.source, { cwd: scopeBaseCwd(recipe.scope, ctx) });
}

function resolveLocalSourcePath(
  recipe: ExtensionInstallRecipe,
  ctx: ExtensionCommandContext
): string {
  if (recipe.source.startsWith("file://")) {
    try {
      return fileURLToPath(recipe.source);
    } catch {
      return recipe.source;
    }
  }

  if (recipe.source.startsWith("~/")) {
    return resolve(homedir(), recipe.source.slice(2));
  }

  return isAbsolute(recipe.source)
    ? recipe.source
    : resolve(scopeBaseCwd(recipe.scope, ctx), recipe.source);
}

function packageIdentity(pkg: InstalledPackage, ctx: ExtensionCommandContext): string {
  return normalizePackageIdentity(pkg.source, {
    ...(pkg.resolvedPath ? { resolvedPath: pkg.resolvedPath } : {}),
    cwd: scopeBaseCwd(pkg.scope, ctx),
  });
}

function findInstalledMatch(
  recipe: ExtensionInstallRecipe,
  installed: InstalledPackage[],
  ctx: ExtensionCommandContext
): InstalledPackage | undefined {
  const identity = recipeIdentity(recipe, ctx);
  return installed.find(
    (pkg) => pkg.scope === recipe.scope && packageIdentity(pkg, ctx) === identity
  );
}

function formatRecipeLabel(recipe: ExtensionInstallRecipe): string {
  const warning = recipe.localSourceRequired ? " ⚠ local source required" : "";
  return `${recipe.kind}:${recipe.source}${warning}`;
}

function groupRecipesForDisplay(recipes: ExtensionInstallRecipe[]): Array<{
  recipe: ExtensionInstallRecipe;
  originalIndex: number;
}> {
  const groups = [
    { scope: "global", local: false },
    { scope: "global", local: true },
    { scope: "project", local: false },
    { scope: "project", local: true },
  ] as const;

  return groups.flatMap((group) =>
    recipes
      .map((recipe, originalIndex) => ({ recipe, originalIndex }))
      .filter(
        ({ recipe }) => recipe.scope === group.scope && recipe.localSourceRequired === group.local
      )
  );
}

function buildRecipeChoices(
  recipes: ExtensionInstallRecipe[],
  selected: Set<number>,
  actionLabel: string
): string[] {
  const choices = [`${actionLabel} (${selected.size})`];
  const grouped = groupRecipesForDisplay(recipes);
  let currentScope: Scope | undefined;
  let currentLocal: boolean | undefined;

  for (const { recipe, originalIndex } of grouped) {
    if (recipe.scope !== currentScope) {
      currentScope = recipe.scope;
      currentLocal = undefined;
      choices.push(recipe.scope === "global" ? "Global" : "Project local");
    }

    if (recipe.localSourceRequired !== currentLocal) {
      currentLocal = recipe.localSourceRequired;
      choices.push(recipe.localSourceRequired ? "  local install" : "  npm/git installed");
    }

    choices.push(
      `    ${selected.has(originalIndex) ? "[x]" : "[ ]"} ${originalIndex + 1}. ${formatRecipeLabel(recipe)}`
    );
  }

  choices.push(CANCEL_LABEL);
  return choices;
}

async function selectRecipes(
  ctx: ExtensionCommandContext,
  title: string,
  recipes: ExtensionInstallRecipe[],
  actionLabel: string
): Promise<ExtensionInstallRecipe[] | undefined> {
  if (recipes.length === 0) return [];

  const selected = new Set(recipes.map((_recipe, index) => index));

  while (true) {
    const choices = buildRecipeChoices(recipes, selected, actionLabel);

    const choice = await ctx.ui.select(title, choices);
    if (!choice || choice === CANCEL_LABEL) return undefined;
    if (choice.startsWith(actionLabel)) {
      return recipes.filter((_recipe, index) => selected.has(index));
    }

    const match = choice.match(/^\s*\[[ x]\]\s+(\d+)\./);
    const index = match?.[1] ? Number.parseInt(match[1], 10) - 1 : -1;
    if (index >= 0 && index < recipes.length) {
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
    }
  }
}

function isExtensionInstallExportFile(value: unknown): value is ExtensionInstallExportFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExtensionInstallExportFile>;
  return candidate.schema === EXTENSION_EXPORT_SCHEMA && Array.isArray(candidate.extensions);
}

function normalizeRecipe(value: unknown): ExtensionInstallRecipe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ExtensionInstallRecipe>;
  if (typeof candidate.source !== "string") return undefined;
  if (candidate.scope !== "global" && candidate.scope !== "project") return undefined;

  const kind = getPackageSourceKind(candidate.source);
  return {
    source: candidate.source,
    scope: candidate.scope,
    kind,
    localSourceRequired: kind === "local" || candidate.localSourceRequired === true,
  };
}

async function readExportFile(path: string): Promise<ExtensionInstallRecipe[]> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);

  if (!isExtensionInstallExportFile(parsed)) {
    throw new Error(
      `Unsupported extension export file. Expected schema ${EXTENSION_EXPORT_SCHEMA}.`
    );
  }

  return parsed.extensions
    .map(normalizeRecipe)
    .filter((recipe): recipe is ExtensionInstallRecipe => Boolean(recipe));
}

async function promptConflictAction(
  ctx: ExtensionCommandContext,
  recipe: ExtensionInstallRecipe
): Promise<typeof SKIP_LABEL | typeof REINSTALL_LABEL | typeof CANCEL_LABEL> {
  const choice = await ctx.ui.select(`${recipe.source} is already installed in ${recipe.scope}`, [
    SKIP_LABEL,
    REINSTALL_LABEL,
    CANCEL_LABEL,
  ]);

  if (choice === REINSTALL_LABEL) return REINSTALL_LABEL;
  if (choice === CANCEL_LABEL || !choice) return CANCEL_LABEL;
  return SKIP_LABEL;
}

async function installRecipe(
  recipe: ExtensionInstallRecipe,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<boolean> {
  try {
    await getPackageCatalog(ctx.cwd).install(recipe.source, recipe.scope);
    const parsed = parsePackageNameAndVersion(recipe.source);
    logPackageInstall(pi, recipe.source, parsed.name, parsed.version, recipe.scope, true);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logPackageInstall(pi, recipe.source, recipe.source, undefined, recipe.scope, false, message);
    notifyError(ctx, `Install failed for ${recipe.source}: ${message}`);
    return false;
  }
}

export async function handleExportSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  _pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Extension export requires interactive mode.", "warning");
    return;
  }

  const packages = await getPackageCatalog(ctx.cwd).listInstalledPackages({ dedupe: false });
  if (packages.length === 0) {
    notify(ctx, "No installed packages found to export.", "info");
    return;
  }

  const selected = await selectRecipes(
    ctx,
    "Select extensions to export",
    packages.map(recipeFromPackage),
    EXPORT_ALL_LABEL
  );

  if (!selected || selected.length === 0) {
    notify(ctx, "Export cancelled.", "info");
    return;
  }

  const path = resolveExportPath(ctx, tokens.join(" "));
  const output: ExtensionInstallExportFile = {
    schema: EXTENSION_EXPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    extensions: selected,
  };

  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  success(ctx, `Exported ${selected.length} extension install recipe(s) to ${path}`);
}

export async function handleImportSubcommand(
  tokens: string[],
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Extension import requires interactive mode.", "warning");
    return;
  }

  const path = resolveExportPath(ctx, tokens.join(" "));
  let recipes: ExtensionInstallRecipe[];
  try {
    recipes = await readExportFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyError(ctx, `Import failed: ${message}`);
    return;
  }

  if (recipes.length === 0) {
    notify(ctx, "No extension install recipes found in export file.", "info");
    return;
  }

  const selected = await selectRecipes(
    ctx,
    "Select extensions to import",
    recipes,
    IMPORT_ALL_LABEL
  );
  if (!selected || selected.length === 0) {
    notify(ctx, "Import cancelled.", "info");
    return;
  }

  let installed = await getPackageCatalog(ctx.cwd).listInstalledPackages({ dedupe: false });
  let imported = 0;
  let skipped = 0;

  for (const recipe of selected) {
    if (recipe.localSourceRequired && !(await fileExists(resolveLocalSourcePath(recipe, ctx)))) {
      notify(ctx, `Skipping ${formatRecipeLabel(recipe)}: local source does not exist.`, "warning");
      skipped += 1;
      continue;
    }

    const existing = findInstalledMatch(recipe, installed, ctx);
    if (existing) {
      const action = await promptConflictAction(ctx, recipe);
      if (action === CANCEL_LABEL) {
        notify(ctx, "Import cancelled.", "info");
        break;
      }
      if (action === SKIP_LABEL) {
        skipped += 1;
        continue;
      }
    }

    const didInstall = await installRecipe(recipe, ctx, pi);
    if (didInstall) {
      imported += 1;
      installed = await getPackageCatalog(ctx.cwd).listInstalledPackages({ dedupe: false });
    } else {
      skipped += 1;
    }
  }

  success(ctx, `Import complete: ${imported} installed, ${skipped} skipped.`);
  if (imported > 0) {
    const reloaded = await confirmReload(ctx, "Extensions imported.");
    if (!reloaded) {
      void updateExtmgrStatus(ctx, pi);
    }
  } else {
    void updateExtmgrStatus(ctx, pi);
  }
}
