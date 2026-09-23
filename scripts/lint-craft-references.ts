import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const repoRoot = path.resolve(import.meta.dirname, "..");
const craftRoot = path.join(repoRoot, "craft");
const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

export type CraftReference = {
  manifestPath: string;
  slug: unknown;
};

export type CraftReferenceViolation = CraftReference & {
  kind: "invalid" | "unresolved";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsenceError(error: unknown): boolean {
  return isRecord(error) && (error["code"] === "ENOENT" || error["code"] === "ENOTDIR");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isAbsenceError(error)) return false;
    throw error;
  }
}

function toRepositoryPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export function extractCraftRequiresSlugs(source: string): unknown[] {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match?.[1]) return [];

  const data: unknown = parse(match[1]);
  if (!isRecord(data)) return [];
  const od = data["od"];
  if (!isRecord(od)) return [];

  const craft = od["craft"];
  if (!isRecord(craft)) return [];

  const requires = craft["requires"];
  return Array.isArray(requires) ? [...requires] : [];
}

export function extractDesignSystemCraftSlugs(source: string): unknown[] {
  const manifest: unknown = JSON.parse(source);
  if (!isRecord(manifest)) return [];
  const craft = manifest["craft"];
  if (!isRecord(craft)) return [];
  return ["applies", "suggested", "exemptions"].flatMap((key) =>
    Array.isArray(craft[key]) ? [...craft[key]] : [],
  );
}

export function findCraftReferenceViolations(
  references: CraftReference[],
  existingSlugs: ReadonlySet<string>,
): CraftReferenceViolation[] {
  const violations: CraftReferenceViolation[] = [];

  for (const reference of references) {
    if (typeof reference.slug !== "string" || !slugPattern.test(reference.slug)) {
      violations.push({ ...reference, kind: "invalid" });
      continue;
    }
    if (!existingSlugs.has(reference.slug)) {
      violations.push({ ...reference, kind: "unresolved" });
    }
  }

  return violations;
}

async function collectNamedManifests(directory: string, fileName: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const manifests: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await collectNamedManifests(fullPath, fileName)));
    } else if (entry.isFile() && entry.name === fileName) {
      manifests.push(fullPath);
    }
  }

  return manifests;
}

export async function collectCraftReferences(root: string = repoRoot): Promise<CraftReference[]> {
  const skillManifests = await collectNamedManifests(path.join(root, "skills"), "SKILL.md");
  const designSystemManifests = await collectNamedManifests(
    path.join(root, "design-systems"),
    "manifest.json",
  );
  const references: CraftReference[] = [];

  for (const manifestPath of skillManifests) {
    let slugs: unknown[];
    try {
      slugs = extractCraftRequiresSlugs(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read craft references from ${toRepositoryPath(root, manifestPath)}.`, {
        cause: error,
      });
    }
    for (const slug of slugs) {
      references.push({
        manifestPath: toRepositoryPath(root, manifestPath),
        slug,
      });
    }
  }

  for (const manifestPath of designSystemManifests) {
    let slugs: unknown[];
    try {
      slugs = extractDesignSystemCraftSlugs(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read craft references from ${toRepositoryPath(root, manifestPath)}.`, {
        cause: error,
      });
    }
    for (const slug of slugs) {
      references.push({
        manifestPath: toRepositoryPath(root, manifestPath),
        slug,
      });
    }
  }

  return references.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

async function collectExistingCraftSlugs(): Promise<Set<string>> {
  const entries = await readdir(craftRoot, { withFileTypes: true });
  const slugs = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;

    const slug = path.basename(entry.name, ".md");
    if (slugPattern.test(slug)) slugs.add(slug);
  }

  return slugs;
}

function formatSlug(slug: unknown): string {
  return typeof slug === "string" ? `'${slug}'` : JSON.stringify(slug);
}

function printViolations(violations: CraftReferenceViolation[]): void {
  const invalid = violations.filter((violation) => violation.kind === "invalid");
  const unresolved = violations.filter((violation) => violation.kind === "unresolved");

  if (invalid.length > 0) {
    console.error("Invalid craft reference entries:");
    for (const violation of invalid) {
      console.error(`- ${violation.manifestPath}: ${formatSlug(violation.slug)}`);
    }
    console.error("Craft slugs must be strings containing lowercase letters, digits, and hyphens only.");
  }

  if (unresolved.length > 0) {
    console.error("Unresolved craft reference slugs:");
    for (const violation of unresolved) {
      console.error(`- ${violation.manifestPath}: ${formatSlug(violation.slug)}`);
    }
    console.error("Add craft/<slug>.md or correct the manifest reference.");
  }
}

export async function checkCraftReferences(): Promise<boolean> {
  const references = await collectCraftReferences();
  const existingSlugs = await collectExistingCraftSlugs();
  const violations = findCraftReferenceViolations(references, existingSlugs);
  const manifestCount = new Set(references.map((reference) => reference.manifestPath)).size;

  if (violations.length > 0) {
    printViolations(violations);
    return false;
  }

  console.log(
    `Craft reference check passed: ${references.length} references across ${manifestCount} manifests resolve.`,
  );
  return true;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain && !(await checkCraftReferences())) {
  process.exitCode = 1;
}
