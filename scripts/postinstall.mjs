import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

// Keep postinstall limited to the presentation product's actual runtime/build
// closure. Desktop packaging, release tooling and legacy standalone/download
// packages were intentionally removed during LCT distillation.
const buildTargets = [
  "packages/release",
  "packages/contracts",
  "packages/components",
  "packages/platform",
  "packages/host",
  "packages/registry-protocol",
  "packages/agui-adapter",
  "packages/plugin-runtime",
  "packages/sidecar-proto",
  "packages/launcher-proto",
  "packages/sidecar",
  "packages/diagnostics",
  "apps/daemon",
  "tools/dev",
  "tools/serve",
];

const jsExtensions = new Set([".js", ".cjs", ".mjs"]);

function resolvePackageManagerInvocation() {
  const pnpmExecPath = process.env.npm_execpath;
  if (pnpmExecPath) {
    if (jsExtensions.has(extname(pnpmExecPath).toLowerCase())) {
      return { argsPrefix: [pnpmExecPath], command: process.execPath };
    }
    return { argsPrefix: [], command: pnpmExecPath };
  }
  return { argsPrefix: [], command: process.platform === "win32" ? "pnpm.cmd" : "pnpm" };
}

const packageManager = resolvePackageManagerInvocation();

function availableBuildTargets() {
  return buildTargets.filter((target) => {
    if (existsSync(resolve(repoRoot, target, "tsconfig.json"))) return true;
    process.stdout.write(`postinstall: skipping ${target} (no tsconfig.json in this context)\n`);
    return false;
  });
}

function runBuildTarget(target) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      packageManager.command,
      [...packageManager.argsPrefix, "-C", target, "run", "build"],
      { cwd: repoRoot, stdio: "inherit" },
    );
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) return resolvePromise();
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      rejectPromise(new Error(`postinstall: ${target} failed with ${suffix}`));
    });
  });
}

function readPackageJson(target) {
  const req = createRequire(resolve(repoRoot, target, "package.json"));
  return req("./package.json");
}

function workspaceDependencyNames(pkg) {
  const names = new Set();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = pkg[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && specifier.startsWith("workspace:")) names.add(name);
    }
  }
  return names;
}

function buildDependencyMap(targets) {
  const targetSet = new Set(targets);
  const nameToTarget = new Map();
  for (const target of targets) {
    const pkg = readPackageJson(target);
    if (typeof pkg.name === "string") nameToTarget.set(pkg.name, target);
  }
  const dependenciesByTarget = new Map();
  for (const target of targets) {
    const pkg = readPackageJson(target);
    const dependencies = [];
    for (const name of workspaceDependencyNames(pkg)) {
      const dependencyTarget = nameToTarget.get(name);
      if (dependencyTarget && targetSet.has(dependencyTarget)) dependencies.push(dependencyTarget);
    }
    dependenciesByTarget.set(target, dependencies);
  }
  return dependenciesByTarget;
}

function postinstallConcurrency() {
  const raw = process.env.LCT_POSTINSTALL_CONCURRENCY;
  if (!raw?.trim()) return 1;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`LCT_POSTINSTALL_CONCURRENCY must be a positive integer, got: ${raw}`);
  }
  return value;
}

async function runBuildTargets() {
  const targets = availableBuildTargets();
  const dependenciesByTarget = buildDependencyMap(targets);
  const remaining = new Set(targets);
  const completed = new Set();
  const concurrency = postinstallConcurrency();

  while (remaining.size > 0) {
    const ready = targets.filter(
      (target) => remaining.has(target) && dependenciesByTarget.get(target).every((dep) => completed.has(dep)),
    );
    if (ready.length === 0) {
      throw new Error(`postinstall: dependency cycle or missing build target: ${[...remaining].join(", ")}`);
    }
    for (let index = 0; index < ready.length; index += concurrency) {
      const batch = ready.slice(index, index + concurrency);
      process.stdout.write(`postinstall: building ${batch.join(", ")}\n`);
      await Promise.all(batch.map(runBuildTarget));
      for (const target of batch) {
        remaining.delete(target);
        completed.add(target);
      }
    }
  }
}

try {
  await runBuildTargets();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

// Verify better-sqlite3 against the active Node ABI.
const req = createRequire(resolve(repoRoot, "apps/daemon/package.json"));
let needsRebuild = false;
try {
  const Database = req("better-sqlite3");
  new Database(":memory:").close();
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") needsRebuild = true;
}

if (needsRebuild) {
  process.stdout.write(`postinstall: rebuilding better-sqlite3 for Node.js ${process.version}...\n`);
  const rebuild = spawnSync(
    packageManager.command,
    [...packageManager.argsPrefix, "--filter", "@lct/daemon", "rebuild", "better-sqlite3"],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (rebuild.error) throw rebuild.error;
  if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);
}
