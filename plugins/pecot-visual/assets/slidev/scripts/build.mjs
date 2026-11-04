#!/usr/bin/env node
// build / prepare / prelint の実体。package manager を介さず node だけで完結させる (#1217)。
// scripts から `node "$npm_execpath" run ...` で自己呼び出しする方式は使わない。
// pnpm 12 が packageManager のバージョンを @pnpm/exe（単一実行ファイル）で起動すると、
// $npm_execpath が ELF を指して動かなくなる。
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetRoot = resolve(__dirname, "..");

// text-constraints が読む text-rules を先に build する。
// libs/text-rules は、リンクで載せた repo 共通のライブラリ。
// build の実体は libs/text-rules/scripts/build.mjs の 1 本で、ここでは起動するだけにする。
// nx 経由では text-rules:build が先に済ませている。
// PECOTV_SKIP_LIB_BUILD=1 のときは飛ばす。同じ dist を並行して消し、作り直すのを避けるため。
if (process.env.PECOTV_SKIP_LIB_BUILD !== "1") {
  const textRules = resolve(assetRoot, "../../libs/text-rules");
  const textRulesBuild = spawnSync(process.execPath, [join(textRules, "scripts/build.mjs")], {
    cwd: textRules,
    stdio: "inherit",
  });
  if (textRulesBuild.error) throw textRulesBuild.error;
  if (textRulesBuild.status !== 0) process.exit(textRulesBuild.status ?? 1);
}

// tsc7 を明示パスで起動する理由は package.json の "//tsc7-path-reason" を参照。
const tsc = resolve(assetRoot, "../../node_modules/typescript7/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-b", "tsconfig.build.json"], {
  cwd: assetRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// validate-references は schema.json を実行時に dist/lib から読むため、tsc が emit しない json をコピーする。
const validateReferences = join(assetRoot, "scripts/eslint/validate-references");
mkdirSync(join(validateReferences, "dist/lib"), { recursive: true });
cpSync(join(validateReferences, "lib/schema.json"), join(validateReferences, "dist/lib/schema.json"));
