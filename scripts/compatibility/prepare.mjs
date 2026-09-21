// Development-only reference extraction. Never changes the reference checkout.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, copyFileSync, realpathSync, lstatSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const references = JSON.parse(readFileSync(join(root, "scripts/compatibility/references.json"), "utf8"));
const base = join(root, "artifacts/compatibility");
const repo = resolve(process.env.T3_REFERENCE_REPO ?? join(root, "repos/t3code"));
mkdirSync(base, { recursive: true });
const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");

function link(target, path) {
  if (existsSync(path)) {
    if (realpathSync(path) === realpathSync(target)) return;
    // Only remove the reference link itself, never its target directory.
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`Not a reference link: ${path}`);
    unlinkSync(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

for (const version of [...new Set(references.map((ref) => ref.effect))]) {
  const pool = join(base, "dependencies-pinned", version);
  mkdirSync(pool, { recursive: true });
  const manifest = { private: true, type: "module", dependencies: {
    effect: version, "@effect/platform-node": version, "@effect/platform-node-shared": version, yaml: "2.9.0", jose: "6.2.2",
    "@noble/curves": "1.9.1", "@noble/hashes": "1.8.0",
  }, overrides: { effect: version, "@effect/platform-node-shared": version } };
  writeFileSync(join(pool, "package.json"), JSON.stringify(manifest, null, 2));
  execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: pool, stdio: "inherit" });
}

for (const ref of references) {
  const snapshot = join(base, String(ref.migration));
  mkdirSync(snapshot, { recursive: true });
  if (!existsSync(join(snapshot, ".reference"))) {
    const archive = join(base, `${ref.migration}.tar`);
    execFileSync("git", ["-C", repo, "archive", "--format=tar", `--output=${archive}`, ref.commit,
      "apps/server/src", "packages/contracts", "packages/shared", "packages/effect-codex-app-server", "pnpm-workspace.yaml"]);
    execFileSync("tar", ["-xf", archive, "-C", snapshot]);
    writeFileSync(join(snapshot, ".reference"), ref.commit);
  }
  if (readFileSync(join(snapshot, ".reference"), "utf8") !== ref.commit) throw new Error(`Wrong reference in ${snapshot}`);
  // Newer ProviderService imports device helpers backed by the workspace SSH package.
  // Also fill existing cached snapshots when the harness gains a dependency.
  const packages = ["contracts", "shared", "effect-codex-app-server"];
  if (execFileSync("git", ["-C", repo, "ls-tree", ref.commit, "packages/ssh"], { encoding: "utf8" }).trim()) {
    packages.push("ssh");
    if (!existsSync(join(snapshot, "packages/ssh/package.json"))) {
      const archive = join(base, `${ref.migration}-ssh.tar`);
      execFileSync("git", ["-C", repo, "archive", "--format=tar", `--output=${archive}`, ref.commit, "packages/ssh"]);
      execFileSync("tar", ["-xf", archive, "-C", snapshot]);
    }
  }
  writeFileSync(join(snapshot, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(join(snapshot, "apps/server/package.json"), execFileSync("git", ["-C", repo, "show", `${ref.commit}:apps/server/package.json`]));
  const modules = join(snapshot, "node_modules");
  const poolModules = join(base, "dependencies-pinned", ref.effect, "node_modules");
  for (const name of readdirSync(poolModules)) {
    if (name.startsWith(".")) continue;
    link(join(poolModules, name), join(modules, name));
  }
  for (const name of packages) {
    link(join(snapshot, "packages", name), join(modules, "@t3tools", name));
  }
  copyFileSync(join(root, "scripts/compatibility/reference-runner.mjs"), join(snapshot, "runner.mjs"));
  copyFileSync(join(root, "scripts/compatibility/reference-resume.mjs"), join(snapshot, "resume.mjs"));
  console.log(`Prepared migration ${ref.migration}: ${ref.commit}`);
}
