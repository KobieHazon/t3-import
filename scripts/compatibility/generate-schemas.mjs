import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const refs = JSON.parse(readFileSync(join(root, "scripts/compatibility/references.json"), "utf8"));
const base = join(root, "artifacts/compatibility");
mkdirSync(base, { recursive: true });
const run = mkdtempSync(join(base, "schema-generation-"));
const schemas = {};
for (const ref of refs) {
  const home = join(run, String(ref.migration));
  mkdirSync(home);
  writeFileSync(join(home, ".compatibility-fixture"), "synthetic");
  const output = join(home, "schema.json");
  execFileSync(process.execPath, ["--import", "tsx", join(base, String(ref.migration), "runner.mjs"), "schema", home, output], { cwd: root, stdio: "pipe" });
  const schema = JSON.parse(readFileSync(output, "utf8"));
  if (Math.max(...schema.migrations.map((row) => row.migration_id)) !== ref.migration) throw new Error(`Wrong migration at ${ref.commit}`);
  // Execution timestamps are not part of the schema; keep fixtures reproducible.
  for (const row of schema.migrations) row.created_at = "2026-01-01 00:00:00";
  schemas[ref.migration] = { commit: ref.commit, ...schema };
  console.log(`Generated actual migration-${ref.migration} schema`);
}
mkdirSync(join(root, "test/fixtures"), { recursive: true });
writeFileSync(join(root, "test/fixtures/t3-schemas.json"), JSON.stringify(schemas, null, 2) + "\n");
