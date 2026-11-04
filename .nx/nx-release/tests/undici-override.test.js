"use strict";

// root package.json の overrides.undici を固定し続けるか、撤去するかを判定する。
//
// なぜ override があるか:
//   nx が dependencies.undici を 7.29.0 に完全一致で固定しており、GHSA の修正版
//   7.30.1 に届かない。そのため root の overrides で 7.30.1 に上げている（#1266）。
//   修正版 7.30.1 を要求する advisory は GHSA-xjj6-f33q-929c。7.29.1 を要求する
//   他の 6 件は、7.30.1 に上げれば包含して解消される。
//
// 撤去条件:
//   nx が宣言する undici の最小版が overrides.undici 以上になったら、override は
//   不要になる。その時点でこのテストが落ちるので、次の 2 段で撤去する。
//     1. root package.json の overrides.undici を外す
//     2. このテストファイルを削除する

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// GHSA-xjj6-f33q-929c の修正版。overrides.undici がこれを下回ると脆弱版へ戻る。
const ADVISORY_FIXED_VERSION = "7.30.1";

const REMOVAL_STEPS =
  "root package.json の overrides.undici を外し、このテストファイルも削除する";
const SKIP_REASON = "nx が undici を宣言していない。test 1 を見る";

const rootDir = path.resolve(__dirname, "../../..");
const rootPackage = require(path.join(rootDir, "package.json"));
const nxPackagePath = require.resolve("nx/package.json", { paths: [rootDir] });
const nxDir = path.dirname(nxPackagePath);
const nxPackage = require(nxPackagePath);
// nx の宣言依存として解決する（root は semver を直接持たない）。
const semver = require(require.resolve("semver", { paths: [nxDir] }));

// nx の undici 宣言。dependencies と optionalDependencies の両方を見る。
const nxSpec =
  nxPackage.dependencies?.undici ?? nxPackage.optionalDependencies?.undici;

function requireOverride() {
  const override = rootPackage.overrides?.undici;
  assert.ok(
    override,
    "root package.json の overrides.undici が無い。" +
      "nx がまだ修正版未満を宣言しているなら override を戻す。" +
      "nx が修正版以上を宣言していて撤去済みなら、このテストファイルも削除する",
  );
  return override;
}

test("nx が undici を依存に宣言している（無ければ override が死蔵になっている）", () => {
  assert.ok(
    nxSpec,
    `nx/package.json に undici の宣言（dependencies / optionalDependencies）が無い。${REMOVAL_STEPS}`,
  );
});

test("overrides.undici が脆弱版へ戻っていない（GHSA-xjj6-f33q-929c の修正版以上）", () => {
  const override = requireOverride();
  assert.ok(
    semver.gte(override, ADVISORY_FIXED_VERSION),
    `overrides.undici (${override}) が修正版 ${ADVISORY_FIXED_VERSION} 未満。${ADVISORY_FIXED_VERSION} 以上に戻す`,
  );
});

test("nx の宣言する undici の最小版が overrides.undici 未満である（以上なら override 不要）", (t) => {
  if (!nxSpec) return t.skip(SKIP_REASON);
  const override = requireOverride();
  assert.ok(
    semver.lt(semver.minVersion(nxSpec), override),
    `nx が undici ${nxSpec} を宣言しており overrides.undici (${override}) 以上に届いた。${REMOVAL_STEPS}`,
  );
});

test("overrides.undici が nx から解決される undici の実体版と一致する", (t) => {
  if (!nxSpec) return t.skip(SKIP_REASON);
  const override = requireOverride();
  const installed = require(
    require.resolve("undici/package.json", { paths: [nxDir] }),
  ).version;
  assert.equal(
    override,
    installed,
    `overrides.undici (${override}) が実体 (${installed}) と違う。npm install で lock を再生成する`,
  );
});
