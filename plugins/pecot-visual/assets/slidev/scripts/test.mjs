#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetRoot = resolve(__dirname, "..");

const passthrough = process.argv.slice(2);

const defaultDirs = [
  "scripts/eslint/2layer/tests",
  "scripts/eslint/asset-path/tests",
  "scripts/eslint/pptx-compat/tests",
  "scripts/eslint/_shared/tests",
  "scripts/eslint/slidev-pages-lint/tests",
  "scripts/eslint/text-constraints/tests",
  "scripts/eslint/validate-references/tests",
  "scripts/design-lint/tests",
];

const targetDirs = defaultDirs.map((d) => join(assetRoot, d));

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function collectTests(extensions) {
  const files = [];
  for (const dir of targetDirs) {
    for (const f of walk(dir)) {
      for (const ext of extensions) {
        if (f.endsWith(ext)) {
          files.push(f);
          break;
        }
      }
    }
  }
  return files;
}

const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);

if (nodeMajor < 22) {
  console.error(
    `[test.mjs] Node ${process.versions.node} is not supported. Node 22+ is required ` +
      `(uses --experimental-strip-types to run .test.ts directly). Upgrade Node and retry.`,
  );
  process.exit(1);
}

const testFiles = collectTests([".test.ts"]);
const prefix = ["--experimental-strip-types", "--test"];

if (testFiles.length === 0) {
  console.error(
    `[test.mjs] No .test.ts files matched ). Aborting.\n` +
      `  searched dirs:\n${targetDirs.map((d) => `    - ${d}`).join("\n")}`,
  );
  process.exit(1);
}

const rel = (f) => relative(assetRoot, f);
console.log(`[test.mjs] node ${prefix.join(" ")} <${testFiles.length} files> ${passthrough.join(" ")}`.trimEnd());
for (const f of testFiles) console.log(`  - ${rel(f)}`);

const nodeArgs = [...prefix, ...testFiles, ...passthrough];
const result = spawnSync(process.execPath, nodeArgs, { cwd: assetRoot, stdio: "inherit" });
process.exit(result.status ?? 1);
