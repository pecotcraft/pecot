import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { onTestFinished, test } from "vitest";

import { explains } from "../../../libs/interface-spec/src/vitest/explains.js";

// src は CommonJS なので、Node の require で読む。
const require = createRequire(import.meta.url);
const { GROUP_PATHS, parseCommit, parseUvLock, resolveGroups, renderPlan, main } = require("../src/dependabot-plans");
const realCommits = require("./_fixtures/dependabot-real.json");
const squashCommits = require("./_fixtures/dependabot-squash.json");

const PRN = (commit) => Number(/\(#(\d+)\)\s*$/.exec(commit.subject)?.[1]);
const TOOLS_ROOT = path.resolve(import.meta.dirname, "../../..");
const DIST_DEPS = new Set(["commander", "eslint", "@eslint/markdown"]);

const dependabotBody = (name, version, type, from) =>
  [
    `Bumps [${name}](https://example.com/${name}) from ${from} to ${version}.`,
    "- [Release notes](https://example.com/releases)",
    "",
    "---",
    "updated-dependencies:",
    `- dependency-name: ${name}`,
    `  dependency-version: ${version}`,
    `  dependency-type: ${type}`,
    "  update-type: version-update:semver-minor",
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@github.com>",
  ].join("\n");

const emptyCtx = (overrides = {}) => ({
  directory: "/",
  uv: false,
  uvLock: null,
  declarations: {},
  lock: null,
  distDeps: DIST_DEPS,
  ...overrides,
});
const decl = (file, section, changed = true) => ({ path: file, section, changed });
const update = (name, type = "direct:production", version = "2.0.0") => ({ name, version, type, from: "1.0.0" });

test("単独の PR の本文から、directory・依存と旧版を読む", async () => {
  await explains("dependabot の commit を解析する `parseCommit` のテストです。単独の依存を更新する PR の場合に、directory と、依存名・新版・種類・旧版を読み取ることを確認します。");
  const real = realCommits.find((commit) => commit.subject.endsWith("(#5)"));
  assert.deepEqual(parseCommit(real.subject, real.body), {
    directory: "/plugins/pecot-tools",
    updates: [{ name: "commander", version: "15.0.0", type: "direct:production", from: "14.0.3" }],
  });
});

test("group の PR の本文から、directory と複数の依存を読む", async () => {
  await explains("dependabot の commit を解析する `parseCommit` のテストです。複数の依存をまとめて更新する group の PR の場合に、directory と、すべての依存の名前・旧版・新版・種類を読み取ることを確認します。");
  const real = realCommits.find((commit) => commit.subject.endsWith("(#6)"));
  const parsed = parseCommit(real.subject, real.body);
  assert.equal(parsed.directory, "/plugins/pecot-workflow/cli");
  assert.deepEqual(
    parsed.updates.map((u) => [u.name, u.from, u.version, u.type]),
    [
      ["typer", "0.26.8", "0.27.3", "direct:production"],
      ["pydantic", "2.14.1", "2.14.2", "direct:production"],
      ["pytest", "9.1.1", "9.2.0", "direct:development"],
      ["ruff", "0.17.2", "0.17.3", "direct:development"],
      ["pytest-asyncio", "1.4.0", "1.4.1.post1", "direct:development"],
    ],
  );
});

const squashOf = (pr) => squashCommits.find((commit) => commit.pr === pr);

// #120（単独）の実物。dependabot と runtime-lock の 2 commit の本文が連なる。
test("#113 の後の squash の本文（単独）を読む。directory が無ければ / とみなす", async () => {
  await explains("merge queue の squash の commit を解析する `parseCommit` のテストです。単独の PR（#120）の実物の場合に、directory が書かれていなくても `/` として扱い、依存を 1 件読み取ることを確認します。");
  const real = squashOf(120);
  assert.deepEqual(parseCommit(real.subject, real.body), {
    directory: "/",
    updates: [{ name: "ajv", version: "8.20.0", type: "direct:production", from: "6.15.0" }],
  });
});

// #151（group）の実物。依存名の引用符と、本文の in the / directory を読む。
test("#113 の後の squash の本文（group）を読む", async () => {
  await explains("merge queue の squash の commit を解析する `parseCommit` のテストです。group の PR（#151）の実物の場合に、引用符付きの依存名を含む 28 件の依存と、directory を読み取ることを確認します。");
  const real = squashOf(151);
  const parsed = parseCommit(real.subject, real.body);
  assert.equal(parsed.directory, "/");
  assert.equal(parsed.updates.length, 28);
  assert.ok(parsed.updates.every((u) => u.from !== null && u.version !== ""));
  assert.deepEqual(parsed.updates.slice(0, 1).map((u) => u.name), [real.body.match(/dependency-name: "?([^"\n]+)/)[1]]);
});

test("旧版が本文から読めないときは from を null にする", async () => {
  await explains("dependabot の commit を解析する `parseCommit` のテストです。本文から旧版を読み取れない場合に、`from` が `null` になることを確認します。");
  const body = "---\nupdated-dependencies:\n- dependency-name: foo\n  dependency-version: 2.0.0\n  dependency-type: direct:production\n...";
  assert.equal(parseCommit("build: bump foo", body).updates[0].from, null);
});

test("updated-dependencies が読めない本文は throw する", async () => {
  await explains("dependabot の commit を解析する `parseCommit` のテストです。`updated-dependencies` を読み取れない本文の場合に、項目がない場合と項目を読み取れない場合を含め、それぞれ例外が発生することを確認します。");
  assert.throws(() => parseCommit("build: bump foo", "本文なし"), /updated-dependencies/);
  assert.throws(() => parseCommit("build: bump foo", "updated-dependencies:\n..."), /項目がありません/);
  assert.throws(
    () => parseCommit("build: bump foo", "updated-dependencies:\n- dependency-name: foo\n..."),
    /項目が読めません/,
  );
});

test("dependencies の宣言は、group の path の前方一致で plan の対象にする", async () => {
  await explains("依存の宣言から plan の対象を決める `resolveGroups` のテストです。`dependencies` と `optionalDependencies` の宣言は、`package.json` のパスが group のパスで始まる場合に、その group を対象とすることを確認します。");
  const ctx = emptyCtx({
    declarations: {
      commander: [decl("plugins/pecot-tools/cli/package.json", "dependencies")],
      zod: [decl("libs/text-rules/package.json", "optionalDependencies")],
      "@actions/core": [decl("actions/package.json", "dependencies")],
    },
  });
  assert.deepEqual(resolveGroups(update("commander"), ctx), { groups: ["pecot-tools"], reason: null });
  assert.deepEqual(resolveGroups(update("zod"), ctx), { groups: ["text-rules"], reason: null });
  assert.deepEqual(resolveGroups(update("@actions/core"), ctx), { groups: ["pecot-actions"], reason: null });
});

test("GROUP_PATHS は nx.json の release.groups のすべての group を持ち、パスが project の置き場所と合う", async () => {
  await explains("group とパスの対応表 `GROUP_PATHS` のテストです。`nx.json` の `release.groups` と同じ group を持ち、各パスの `project.json` の `name` がその group の `projects` に含まれることを確認します。");
  const groups = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, "nx.json"), "utf8")).release.groups;
  assert.deepEqual(Object.keys(GROUP_PATHS).sort(), Object.keys(groups).sort());
  for (const [group, prefix] of Object.entries(GROUP_PATHS)) {
    const project = JSON.parse(fs.readFileSync(path.join(TOOLS_ROOT, prefix, "project.json"), "utf8"));
    assert.ok(groups[group].projects.includes(project.name), `${group}: ${prefix}project.json の name は ${project.name}`);
  }
});

test("devDependencies だけの宣言は「開発用」で、pecot-visual は配布物の依存名なら対象にする", async () => {
  await explains("依存の宣言から plan の対象を決める `resolveGroups` のテストです。`devDependencies` だけの宣言は開発用として対象から外し、pecot-visual は配布物の依存名の場合だけ対象とすることを確認します。");
  const ctx = emptyCtx({
    declarations: {
      vitest: [decl("plugins/pecot-tools/cli/package.json", "devDependencies")],
      eslint: [decl("plugins/pecot-visual/assets/slidev/package.json", "devDependencies")],
      knip: [decl("plugins/pecot-visual/cli/package.json", "devDependencies")],
    },
  });
  assert.deepEqual(resolveGroups(update("vitest"), ctx), { groups: [], reason: "dev" });
  assert.deepEqual(resolveGroups(update("eslint"), ctx), { groups: ["pecot-visual"], reason: null });
  assert.deepEqual(resolveGroups(update("knip"), ctx), { groups: [], reason: "dev" });
});

test("root と tests/ の下の宣言は、どの package にも当たらない", async () => {
  await explains("依存の宣言から plan の対象を決める `resolveGroups` のテストです。ルートの `package.json` と `tests/` 配下の宣言、および宣言のない依存は、どの package にも当たらないものとして扱うことを確認します。");
  const ctx = emptyCtx({
    declarations: {
      nx: [decl("package.json", "dependencies")],
      yaml: [decl("plugins/pecot-visual/cli/tests/fixtures/minimal-slidev/package.json", "dependencies")],
    },
  });
  assert.deepEqual(resolveGroups(update("nx"), ctx), { groups: [], reason: "none" });
  assert.deepEqual(resolveGroups(update("yaml"), ctx), { groups: [], reason: "none" });
  assert.deepEqual(resolveGroups(update("unknown"), ctx), { groups: [], reason: "none" });
});

test("版の割れた @types/node は、指定の変わった package だけに作る", async () => {
  await explains("依存の宣言から plan の対象を決める `resolveGroups` のテストです。版が package ごとに異なる `@types/node` の場合に、指定が変更された package だけを対象とすることを確認します。");
  const ctx = emptyCtx({
    declarations: {
      "@types/node": [
        decl("plugins/pecot-tools/cli/package.json", "dependencies", true),
        decl("plugins/pecot-workflow/cli/package.json", "dependencies", false),
        decl("libs/text-rules/package.json", "dependencies", false),
      ],
    },
  });
  assert.deepEqual(resolveGroups(update("@types/node"), ctx), { groups: ["pecot-tools"], reason: null });
});

test("lock だけが変わったときは、宣言している package.json の全部を根拠にする", async () => {
  await explains("依存の宣言から plan の対象を決める `resolveGroups` のテストです。lock だけが変更された場合に、その依存を宣言しているすべての `package.json` の group を対象とすることを確認します。");
  const ctx = emptyCtx({
    declarations: {
      yaml: [
        decl("plugins/pecot-tools/cli/package.json", "dependencies", false),
        decl("libs/text-rules/package.json", "dependencies", false),
      ],
    },
  });
  assert.deepEqual(resolveGroups(update("yaml"), ctx).groups.sort(), ["pecot-tools", "text-rules"]);
});

test("uv は directory の group と YAML の dependency-type で決める", async () => {
  await explains("uv の依存から plan の対象を決める `resolveGroups` のテストです。directory に対応する group と依存の種類に応じて、対象になる場合、開発用として外れる場合、どの package にも当たらない場合に分かれることを確認します。");
  const ctx = emptyCtx({ uv: true, directory: "/plugins/pecot-workflow/cli" });
  assert.deepEqual(resolveGroups(update("typer"), ctx), { groups: ["pecot-workflow"], reason: null });
  assert.deepEqual(resolveGroups(update("pytest", "direct:development"), ctx), { groups: [], reason: "dev" });
  assert.deepEqual(resolveGroups(update("typer"), emptyCtx({ uv: true, directory: "/tools" })), { groups: [], reason: "none" });
});

const UV_LOCK = `version = 1

[[package]]
name = "app"
version = "0.0.0"
source = { editable = "." }
dependencies = [
    { name = "gql", extra = ["httpx"] },
    { name = "typer" },
]

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[package.optional-dependencies]
docs = [
    { name = "mkdocs" },
]

[[package]]
name = "gql"
version = "4.0.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "graphql-core" },
]

[package.optional-dependencies]
httpx = [
    { name = "httpx", marker = "python_full_version < '3.11'" },
]

[[package]]
name = "typer"
version = "0.27.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "click" },
]

[[package]]
name = "pytest"
version = "9.2.0"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "pluggy" },
]

[[package]]
name = "mkdocs"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "httpx"
version = "0.28.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "graphql-core"
version = "3.2.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "click"
version = "8.3.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pluggy"
version = "1.6.0"
source = { registry = "https://pypi.org/simple" }
`;

test("uv の indirect は、プロジェクトの本番の依存から届くときだけ作る。dev からだけなら「開発用」", async () => {
  await explains("uv の間接依存から plan の対象を決める `resolveGroups` のテストです。本番の依存から届く間接依存は対象とし、開発用の依存からだけ届く間接依存は開発用として外すことを確認します。");
  const uvLock = parseUvLock(UV_LOCK);
  assert.deepEqual(uvLock.packages.filter((pkg) => pkg.project).map((pkg) => pkg.name), ["app"]);
  const ctx = emptyCtx({ uv: true, directory: "/plugins/pecot-workflow/cli", uvLock });
  const resolve = (name, version) => resolveGroups(update(name, "indirect", version), ctx);
  assert.deepEqual(resolve("click", "8.3.0"), { groups: ["pecot-workflow"], reason: null });
  assert.deepEqual(resolve("graphql-core", "3.2.0"), { groups: ["pecot-workflow"], reason: null });
  assert.deepEqual(resolve("httpx", "0.28.0"), { groups: ["pecot-workflow"], reason: null });
  assert.deepEqual(resolve("pluggy", "1.6.0"), { groups: [], reason: "dev" });
  assert.deepEqual(resolve("mkdocs", "1.0.0"), { groups: [], reason: "dev" });
  assert.deepEqual(resolve("click", "9.0.0"), { groups: [], reason: "none" });
});

test("uv の indirect で uv.lock を読めていないときは throw する", async () => {
  await explains("uv の間接依存から plan の対象を決める `resolveGroups` のテストです。`uv.lock` を読み込んでいない場合に、`uv.lock` に関する例外が発生することを確認します。");
  const ctx = emptyCtx({ uv: true, directory: "/plugins/pecot-workflow/cli" });
  assert.throws(() => resolveGroups(update("click", "indirect"), ctx), /uv\.lock/);
});

const lockOf = (importers, snapshots) => ({ importers, snapshots });
const dep = (version) => ({ version });

test("indirect は、group の本番の依存から辿って新版へ届くとき作る", async () => {
  await explains("pnpm の間接依存から plan の対象を決める `resolveGroups` のテストです。group の本番の依存を辿って新しい版へ届く場合は、届いたすべての group を対象とすることを確認します。");
  const lock = lockOf(
    { "plugins/pecot-tools/cli": { dependencies: { a: dep("1.0.0") } }, "libs/text-rules": { dependencies: { z: dep("1.0.0") } } },
    {
      "a@1.0.0": { dependencies: { b: "2.0.0(peer@1.0.0)" } },
      "b@2.0.0(peer@1.0.0)": { optionalDependencies: { c: "3.0.0" } },
      "c@3.0.0": {},
      "z@1.0.0": { dependencies: { c: "3.0.0" } },
    },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("c", "indirect", "3.0.0"), ctx).groups.sort(), ["pecot-tools", "text-rules"]);
  assert.deepEqual(resolveGroups(update("b", "indirect", "2.0.0"), ctx), { groups: ["pecot-tools"], reason: null });
});

test("indirect が dev の依存からしか届かないときと、どこにも届かないときは作らない", async () => {
  await explains("pnpm の間接依存から plan の対象を決める `resolveGroups` のテストです。開発用の依存からだけ届く場合は開発用、どこにも届かない場合や lock がない場合はどの package にも当たらないものとして扱うことを確認します。");
  const lock = lockOf(
    { "plugins/pecot-tools/cli": { devDependencies: { vitest: dep("5.0.0") }, dependencies: { a: dep("1.0.0") } } },
    { "vitest@5.0.0": { dependencies: { d: "1.0.0" } }, "d@1.0.0": {}, "a@1.0.0": {}, "e@1.0.0": {} },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("d", "indirect", "1.0.0"), ctx), { groups: [], reason: "dev" });
  assert.deepEqual(resolveGroups(update("e", "indirect", "1.0.0"), ctx), { groups: [], reason: "none" });
  assert.deepEqual(resolveGroups(update("d", "indirect", "1.0.0"), emptyCtx()), { groups: [], reason: "none" });
});

test("pecot-visual の配布物の dev 依存から届く indirect は作る", async () => {
  await explains("pnpm の間接依存から plan の対象を決める `resolveGroups` のテストです。pecot-visual の配布物の開発用の依存から届く間接依存は対象とし、配布物ではない依存から届くものは開発用として外すことを確認します。");
  const lock = lockOf(
    { "plugins/pecot-visual/assets/slidev": { devDependencies: { eslint: dep("10.0.0"), knip: dep("6.0.0") } } },
    { "eslint@10.0.0": { dependencies: { f: "1.0.0" } }, "f@1.0.0": {}, "knip@6.0.0": { dependencies: { g: "1.0.0" } }, "g@1.0.0": {} },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("f", "indirect", "1.0.0"), ctx), { groups: ["pecot-visual"], reason: null });
  assert.deepEqual(resolveGroups(update("g", "indirect", "1.0.0"), ctx), { groups: [], reason: "dev" });
});

test("actions の本番の依存から届く indirect は pecot-actions に作り、dev の依存からだけなら作らない", async () => {
  await explains("pnpm の間接依存から plan の対象を決める `resolveGroups` のテストです。lock の importer `actions` の本番の依存から届く間接依存は pecot-actions を対象とし、開発用の依存からだけ届くものは開発用として外すことを確認します。");
  const lock = lockOf(
    { actions: { dependencies: { "@actions/core": dep("3.0.1") }, devDependencies: { rollup: dep("4.68.8") } } },
    {
      "@actions/core@3.0.1": { dependencies: { "@actions/http-client": "4.0.1" } },
      "@actions/http-client@4.0.1": { dependencies: { undici: "6.29.1" } },
      "undici@6.29.1": {},
      "rollup@4.68.8": { optionalDependencies: { fsevents: "2.3.3" } },
      "fsevents@2.3.3": {},
    },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("undici", "indirect", "6.29.1"), ctx), { groups: ["pecot-actions"], reason: null });
  assert.deepEqual(resolveGroups(update("fsevents", "indirect", "2.3.3"), ctx), { groups: [], reason: "dev" });
});

test("1 件は「`名前` を 旧版 から 新版 に更新。」の 1 行で、(#N) は付けない", async () => {
  await explains("plan の本文を作成する `renderPlan` のテストです。依存が 1 件の場合に、旧版がある場合とない場合のそれぞれで、1 行の本文になり、PR 番号が付かないことを確認します。");
  assert.equal(
    renderPlan("pecot-tools", [{ name: "commander", from: "14.0.3", version: "15.0.0" }]),
    "---\npecot-tools: patch\n---\n\n`commander` を 14.0.3 から 15.0.0 に更新。\n",
  );
  assert.equal(
    renderPlan("pecot-tools", [{ name: "foo", from: null, version: "2.0.0" }]),
    "---\npecot-tools: patch\n---\n\n`foo` を 2.0.0 に更新。\n",
  );
});

test("2 件は件数の行の後に 1 件 1 行で並べる", async () => {
  await explains("plan の本文を作成する `renderPlan` のテストです。依存が 2 件の場合に、件数の行の後に、1 件ずつ 1 行で並ぶことを確認します。");
  const text = renderPlan("pecot-tools", [
    { name: "commander", from: "14.0.3", version: "15.0.0" },
    { name: "foo", from: null, version: "2.0.0" },
  ]);
  assert.equal(
    text,
    "---\npecot-tools: patch\n---\n\n依存パッケージを 2 件更新。\n`commander` を 14.0.3 から 15.0.0 に更新。\n`foo` を 2.0.0 に更新。\n",
  );
});

test("3 件以上は 2 件まで載せ「ほか N 件」で締め、形式の上限に収める", async () => {
  await explains("plan の本文を作成する `renderPlan` のテストです。依存が 3 件以上の場合に、2 件までを載せて「ほか N 件」で締め、長い名前でも 1 行 100 字以内・全体 200 字以内に収まることを確認します。");
  const short = renderPlan(
    "pecot-visual",
    ["a", "b", "c", "d", "e"].map((name) => ({ name, from: "1.0.0", version: "1.1.0" })),
  );
  assert.equal(
    short,
    "---\npecot-visual: patch\n---\n\n依存パッケージを 5 件更新。\n`a` を 1.0.0 から 1.1.0 に更新。\n`b` を 1.0.0 から 1.1.0 に更新、ほか 3 件。\n",
  );
  const deps = Array.from({ length: 12 }, (_, i) => ({
    name: `@long-scope/package-with-a-very-long-name-${i}`,
    from: "10.100.1000",
    version: "11.200.2000",
  }));
  const lines = renderPlan("pecot-visual", deps).split("---\n\n")[1].trimEnd().split("\n");
  assert.ok(lines.length <= 3, lines.join("\n"));
  assert.ok(lines.every((line) => [...line].length <= 100), lines.join("\n"));
  assert.ok([...lines.join("")].length <= 200, lines.join("\n"));
  assert.equal(lines[0], "依存パッケージを 12 件更新。");
  const shown = lines.slice(1).length;
  assert.match(lines.at(-1), new RegExp(`、ほか ${12 - shown} 件。$`));
});

// 結合のテスト。一時の git リポに commit を並べ、main() を通す。
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "dependabot[bot]",
      GIT_AUTHOR_EMAIL: "49699333+dependabot[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "dependabot[bot]",
      GIT_COMMITTER_EMAIL: "49699333+dependabot[bot]@users.noreply.github.com",
    },
  });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dependabot-plans-test-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "user.name", "dependabot[bot]");
  git(dir, "config", "user.email", "49699333+dependabot[bot]@users.noreply.github.com");
  return dir;
}

function writeFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
}

function commit(dir, files, message, extraArgs = []) {
  writeFiles(dir, files);
  git(dir, "add", "-A");
  const messageFile = path.join(dir, ".git", "COMMIT_MSG_TEST");
  fs.writeFileSync(messageFile, message);
  git(dir, "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", messageFile, ...extraArgs);
  return git(dir, "rev-parse", "HEAD").trim();
}

async function run(dir, argv = []) {
  const lines = [];
  const errors = [];
  const code = await main({
    argv,
    repoDir: dir,
    toolsRoot: TOOLS_ROOT,
    loadDistDeps: () => DIST_DEPS,
    stdout: (line) => lines.push(line),
    stderr: (line) => errors.push(line),
  });
  return { code, lines, errors };
}

const plansIn = (dir) => {
  const plansDir = path.join(dir, ".nx/version-plans");
  return fs.existsSync(plansDir) ? fs.readdirSync(plansDir).sort() : [];
};
const summaryOf = (lines) => Object.fromEntries(lines.filter((line) => /^作った|^作らなかった/.test(line)).map((line) => {
  const [label, count] = line.split(": ");
  return [label, Number.parseInt(count, 10)];
}));
const pkg = (deps) => `${JSON.stringify(deps, null, 2)}\n`;
const toolsPackage = (version) => pkg({ name: "tools", dependencies: { commander: version } });

// 実物のリポの root には、ruff 用の pyproject.toml と uv.lock がある。
const ROOT_UV = { "pyproject.toml": "[project]\nname = 'root'\n", "uv.lock": "version = 1\n" };

const stripPr = (subject) => subject.replace(/ \(#\d+\)\s*$/, "");
const runPr = (dir, pr, base = "HEAD~1", extra = []) => run(dir, ["--pr", String(pr), "--base", base, ...extra]);

// 実物を 1 件ずつ commit し、そのつど --pr <番号> --base HEAD~1 で通す。件名の (#N) は取り除く。
async function replayRealCommits(dir, extra = []) {
  commit(dir, { ...ROOT_UV, "plugins/pecot-workflow/cli/pyproject.toml": "[project]\nname = 'x'\n" }, "chore: init");
  const results = [];
  for (const real of realCommits) {
    writeFiles(dir, Object.fromEntries(real.files.map((file) => [file.path, file.before])));
    git(dir, "add", "-A");
    if (git(dir, "status", "--porcelain").trim() !== "") commit(dir, {}, `chore: setup ${real.sha}`);
    commit(dir, Object.fromEntries(real.files.map((file) => [file.path, file.after])), `${stripPr(real.subject)}\n\n${real.body}\n`);
    results.push(await runPr(dir, PRN(real), "HEAD~1", extra));
  }
  return results;
}

const sumSummary = (results) =>
  results.reduce((total, { lines }) => {
    for (const [key, count] of Object.entries(summaryOf(lines))) total[key] = (total[key] ?? 0) + count;
    return total;
  }, {});

test("実物の 11 件から作るのは #5・#6・#10・#16 の 4 件で、作った plan が 2 つの確認を通る", async () => {
  await explains("実物の dependabot の commit 11 件を順に通す `main` のテストです。plan を作成するのは #5・#6・#10・#16 の 4 件で、作成した plan の本文と集計の行が期待どおりであることを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = await replayRealCommits(dir);
  for (const result of results) assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), [
    "10-dependabot-deps.md",
    "16-dependabot-deps.md",
    "5-dependabot-deps.md",
    "6-dependabot-deps.md",
  ]);
  const read = (name) => fs.readFileSync(path.join(dir, ".nx/version-plans", name), "utf8");
  assert.equal(read("5-dependabot-deps.md"), "---\npecot-tools: patch\n---\n\n`commander` を 14.0.3 から 15.0.0 に更新。\n");
  assert.equal(read("10-dependabot-deps.md"), "---\npecot-workflow: patch\n---\n\n`commander` を 14.0.3 から 15.0.0 に更新。\n");
  assert.equal(read("16-dependabot-deps.md"), "---\npecot-visual: patch\n---\n\n`commander` を 14.0.3 から 15.0.0 に更新。\n");
  assert.equal(
    read("6-dependabot-deps.md"),
    "---\npecot-workflow: patch\n---\n\n依存パッケージを 2 件更新。\n`typer` を 0.26.8 から 0.27.3 に更新。\n`pydantic` を 2.14.1 から 2.14.2 に更新。\n",
  );
  assert.deepEqual(sumSummary(results), {
    "作った plan ファイル": 4,
    "作らなかった dependabot の PR（開発用）": 7,
    "作らなかった dependabot の PR（どの package にも当たらない）": 0,
    "作らなかった plan ファイル（既にある）": 0,
  });
});

test("--dry-run は .nx/version-plans に書かず、パスと中身を出す", async () => {
  await explains("`--dry-run` を指定した `main` のテストです。実物の dependabot の commit を順に通した場合に、`.nx/version-plans` に書き込まず、plan のパスと本文を出力することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = await replayRealCommits(dir, ["--dry-run"]);
  for (const result of results) assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  const printed = results.flatMap(({ lines }) => lines).join("\n");
  assert.match(printed, /5-dependabot-deps\.md\n---\npecot-tools: patch/);
  assert.match(printed, /`commander` を 14\.0\.3 から 15\.0\.0 に更新。\n/);
  assert.doesNotMatch(printed, /\(#\d+\)/);
  assert.equal(sumSummary(results)["作った plan ファイル"], 4);
});

test("引数の誤りはコード 2、読めない本文はコード 1", async () => {
  await explains("`main` の引数と本文の検証のテストです。誤った引数の組み合わせの場合は使い方を出力して終了コード 2、読み取れない本文の場合は終了コード 1 で終了することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  for (const argv of [
    ["--unknown"],
    ["--base"],
    ["--base", "HEAD"],
    ["--pr", "3"],
    ["--pr", "x1", "--base", "HEAD"],
    ["--pr", "3", "--base", "HEAD", "--check"],
    ["--check", "--base", "HEAD", "--dry-run"],
    ["--check"],
    ["--base", "--dry-run", "--pr", "3"],
    ["--pr", "3", "--base", "HEAD", "--head"],
    ["--pr", "3", "--base", "HEAD", "--head", "--dry-run"],
    ["--check", "--base", "HEAD", "--pr", "3"],
  ]) {
    const result = await run(dir, argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.errors.join("\n"), /使い方: dependabot-plans\.js/);
  }

  commit(dir, {}, "build: bump foo\n\nupdated-dependencies:\n- dependency-name: foo\n...\n");
  const broken = await runPr(dir, 3);
  assert.equal(broken.code, 1);
  assert.match(broken.errors.join("\n"), /項目が読めません/);
});

test("件名に (#N) が無い commit からも、--pr の番号で plan を作る", async () => {
  await explains("`--pr` を指定した `main` のテストです。件名に `(#N)` がない commit の場合でも、`--pr` の番号を使って plan を作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in /plugins/pecot-tools\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  const result = await runPr(dir, 12);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["12-dependabot-deps.md"]);
  assert.equal(
    fs.readFileSync(path.join(dir, ".nx/version-plans/12-dependabot-deps.md"), "utf8"),
    "---\npecot-tools: patch\n---\n\n`commander` を 1.0.0 から 2.0.0 に更新。\n",
  );
});

test("2 つの group に届く PR は、group ごとに別のファイルにする", async () => {
  await explains("複数の group に届く PR を扱う `main` のテストです。2 つの group に影響する PR の場合に、group ごとに別のファイルとして plan を作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(
    dir,
    {
      "plugins/pecot-tools/package.json": toolsPackage("^1.0.0"),
      "libs/text-rules/package.json": toolsPackage("^1.0.0"),
    },
    "chore: init",
  );
  commit(
    dir,
    {
      "plugins/pecot-tools/package.json": toolsPackage("^2.0.0"),
      "libs/text-rules/package.json": toolsPackage("^2.0.0"),
    },
    `build: bump commander in / (#30)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );

  const result = await runPr(dir, 30);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["30-dependabot-deps-pecot-tools.md", "30-dependabot-deps-text-rules.md"]);
});

test("--base で範囲を決める。base が HEAD なら commit が無く、plan を作らない", async () => {
  await explains("`--base` を指定した `main` のテストです。`--base` が `HEAD` の場合は対象の commit がなく plan を作成せず、`HEAD~1` の場合は plan を作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in / (#31)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  assert.equal((await runPr(dir, 31, "HEAD")).code, 0);
  assert.deepEqual(plansIn(dir), []);
  assert.equal((await runPr(dir, 31, "HEAD~1")).code, 0);
  assert.deepEqual(plansIn(dir), ["31-dependabot-deps.md"]);
});

test("同じ名前の plan が既にあるときは上書きしない", async () => {
  await explains("既存の plan がある場合の `main` のテストです。同じ名前の plan がすでに存在する場合に、上書きせず、集計の「既にある」に数えることを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    {
      "plugins/pecot-tools/package.json": toolsPackage("^2.0.0"),
      ".nx/version-plans/50-dependabot-deps.md": "---\npecot-tools: minor\n---\n\n人が書いた本文。\n",
    },
    `build: bump commander in /plugins/pecot-tools (#50)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  const result = await runPr(dir, 50);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.match(fs.readFileSync(path.join(dir, ".nx/version-plans/50-dependabot-deps.md"), "utf8"), /人が書いた本文/);
  assert.equal(summaryOf(result.lines)["作らなかった plan ファイル（既にある）"], 1);
});

test("#113 の後の squash（#120・#151 の実物）から、root に uv.lock があっても group ごとの plan を作る", async () => {
  await explains("merge queue の squash の commit（#120・#151 の実物）を扱う `main` のテストです。ルートに `uv.lock` がある場合でも、group ごとの plan を作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const real of squashCommits) {
    commit(dir, { ...ROOT_UV, ...Object.fromEntries(real.files.map((file) => [file.path, file.before])) }, `chore: setup ${real.pr}`);
    commit(dir, Object.fromEntries(real.files.map((file) => [file.path, file.after])), `${stripPr(real.subject)}\n\n${real.body}\n`);
    const result = await runPr(dir, real.pr);
    assert.equal(result.code, 0, result.errors.join("\n"));
  }
  assert.deepEqual(plansIn(dir), [
    "120-dependabot-deps.md",
    "151-dependabot-deps-pecot-tools.md",
    "151-dependabot-deps-pecot-visual.md",
    "151-dependabot-deps-pecot-workflow.md",
    "151-dependabot-deps-text-rules.md",
  ]);
  assert.match(fs.readFileSync(path.join(dir, ".nx/version-plans/120-dependabot-deps.md"), "utf8"), /^pecot-visual: patch$/m);
});

const actionsBody = [
  "Bumps [actions/checkout](https://github.com/actions/checkout) from 4.0.0 to 5.0.0.",
  "",
  "---",
  "updated-dependencies:",
  "- dependency-name: actions/checkout",
  "  dependency-version: 5.0.0",
  "  dependency-type: direct:production",
  "  update-type: version-update:semver-major",
  "...",
].join("\n");

test("github-actions の PR は plan を作らず、「どの package にも当たらない」に数える", async () => {
  await explains("github-actions の PR を扱う `main` のテストです。plan を作成せず、集計の「どの package にも当たらない」に数えることを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { ".github/workflows/ci.yml": "name: x\n" }, `build(repo): bump actions/checkout from 4.0.0 to 5.0.0 in / (#60)\n\n${actionsBody}\n`);
  const result = await runPr(dir, 60);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  const summary = summaryOf(result.lines);
  assert.equal(summary["作った plan ファイル"], 0);
  assert.equal(summary["作らなかった dependabot の PR（どの package にも当たらない）"], 1);
});

const indirectBody = dependabotBody("c", "3.0.0", "indirect", "2.0.0");

test("lock を読めない indirect は、sha を添えて throw する（コード 1）", async () => {
  await explains("間接依存の PR を扱う `main` のテストです。lock を読み取れない場合に、commit の sha を添えた例外が発生し、終了コード 1 で終了することを確認します。lock が存在しない場合と、形式が不正な場合の両方を対象とします。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  const sha = commit(dir, {}, `build(repo): bump c in / (#61)\n\n${indirectBody}\n`);
  const result = await runPr(dir, 61);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), new RegExp(`${sha.slice(0, 7)}: pnpm-lock\\.yaml がありません`));

  for (const [lock, pattern] of [
    ["importers: [\n", /pnpm-lock\.yaml を parse できません/],
    ["lockfileVersion: '9.0'\n", /importers がありません/],
  ]) {
    const other = makeRepo();
    onTestFinished(() => fs.rmSync(other, { recursive: true, force: true }));
    commit(other, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
    commit(other, { "pnpm-lock.yaml": lock }, `build(repo): bump c in / (#61)\n\n${indirectBody}\n`);
    const broken = await runPr(other, 61);
    assert.equal(broken.code, 1);
    assert.match(broken.errors.join("\n"), pattern);
  }
});

test("例外のときは、書いた plan を残さない", async () => {
  await explains("例外が発生した場合の `main` のテストです。複数の PR の途中で例外が発生した場合に、すでに書き込んだ plan を残さないことを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") },
    `build: bump commander in /plugins/pecot-tools (#62)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  commit(dir, {}, `build(repo): bump c in / (#63)\n\n${indirectBody}\n`);
  const result = await runPr(dir, 62, "HEAD~2");
  assert.equal(result.code, 1);
  assert.deepEqual(plansIn(dir), []);
});

test("検証を通らない plan は消す。dry-run では .pecot/tmp に残した旨を出す", async () => {
  await explains("plan の検証のテストです。検証を通らない plan は削除し、`--dry-run` の場合は `.pecot/tmp/dependabot-plans` に残した旨を出力して、いずれも終了コード 1 で終了することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") },
    `build: bump commander in /plugins/pecot-tools (#64)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  process.env.PECOT_PLAN_MAX_LINE_CHARS = "10";
  onTestFinished(() => delete process.env.PECOT_PLAN_MAX_LINE_CHARS);

  const result = await runPr(dir, 64);
  assert.equal(result.code, 1);
  assert.deepEqual(plansIn(dir), []);
  assert.match(result.errors.join("\n"), /書いた plan は消しました/);

  const dry = await runPr(dir, 64, "HEAD~1", ["--dry-run"]);
  assert.equal(dry.code, 1);
  assert.match(dry.errors.join("\n"), /\.pecot\/tmp\/dependabot-plans に残しました/);
  assert.ok(fs.existsSync(path.join(dir, ".pecot/tmp/dependabot-plans/64-dependabot-deps.md")));
});

test("同じ PR の同じ group に届く 2 commit は、1 つの plan に集約する", async () => {
  await explains("同じ PR の同じ group に届く複数の commit を扱う `main` のテストです。3 件の commit の場合に、重複を除いて 1 つの plan に集約し、更新の行が順に並ぶことを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  const message = (version, from) => `build: bump commander in /plugins/pecot-tools\n\n${dependabotBody("commander", version, "direct:production", from)}\n`;
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message("2.0.0", "1.0.0"));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message("2.0.0", "1.0.0"));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^3.0.0") }, message("3.0.0", "2.0.0"));
  const result = await runPr(dir, 71, "HEAD~3");
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["71-dependabot-deps.md"]);
  assert.match(
    fs.readFileSync(path.join(dir, ".nx/version-plans/71-dependabot-deps.md"), "utf8"),
    /`commander` を 1\.0\.0 から 2\.0\.0 に更新。\n`commander` を 2\.0\.0 から 3\.0\.0 に更新。/,
  );
  assert.equal(summaryOf(result.lines)["作らなかった plan ファイル（既にある）"], 0);
});

test("同じ PR で別の group に届く 2 commit は、group ごとの名前で 1 つずつ作る", async () => {
  await explains("同じ PR で別の group に届く複数の commit を扱う `main` のテストです。2 件の commit の場合に、group ごとの名前で plan を 1 つずつ作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(
    dir,
    {
      "plugins/pecot-tools/package.json": toolsPackage("^1.0.0"),
      "libs/text-rules/package.json": toolsPackage("^1.0.0"),
    },
    "chore: init",
  );
  const message = (directory) => `build: bump commander in ${directory}\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`;
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message("/plugins/pecot-tools"));
  commit(dir, { "libs/text-rules/package.json": toolsPackage("^2.0.0") }, message("/libs/text-rules"));
  const result = await runPr(dir, 72, "HEAD~2");
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["72-dependabot-deps-pecot-tools.md", "72-dependabot-deps-text-rules.md"]);
});

// --check は、PR が足した plan が、dependabot の commit の届く group を覆うかを見る。
async function checkRepo(plan) {
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in /plugins/pecot-tools\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  if (plan !== undefined) commit(dir, { ".nx/version-plans/9-dependabot-deps.md": plan }, "chore: plan");
  return dir;
}

test("--check: plan が足されていれば 0", async () => {
  await explains("`--check` のテストです。dependabot の commit が届く group を覆う plan が追加されている場合に、何も出力せず、終了コード 0 で終了することを確認します。");
  const dir = await checkRepo("---\npecot-tools: patch\n---\n\n依存を更新した。\n");
  const result = await run(dir, ["--check", "--base", "HEAD~2"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(plansIn(dir), ["9-dependabot-deps.md"]);
});

test("--check: plan が欠けていれば 1 で、sha と group 名を stderr に出す。plan は書かない", async () => {
  await explains("`--check` のテストです。plan が不足している場合に、commit の sha と group 名を標準エラーに出力して終了コード 1 で終了し、plan を書き込まないことを確認します。");
  const dir = await checkRepo();
  const sha = git(dir, "rev-parse", "--short=7", "HEAD").trim();
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 1);
  assert.equal(result.errors.join("\n"), `${sha}: pecot-tools の version plan がありません`);
  assert.deepEqual(plansIn(dir), []);

  const other = await checkRepo("---\ntext-rules: patch\n---\n\n依存を更新した。\n");
  assert.equal((await run(other, ["--check", "--base", "HEAD~2"])).code, 1);
});

test("--check: plan の要らない PR（開発用だけ・github-actions・dependabot の commit なし）は 0", async () => {
  await explains("`--check` のテストです。plan が不要な PR（開発用の依存だけ・github-actions・dependabot の commit がない場合）は、終了コード 0 で終了することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": pkg({ name: "tools", devDependencies: { vitest: "^1.0.0" } }) }, "chore: init");
  commit(
    dir,
    { "plugins/pecot-tools/package.json": pkg({ name: "tools", devDependencies: { vitest: "^2.0.0" } }) },
    `build: bump vitest in /plugins/pecot-tools\n\n${dependabotBody("vitest", "2.0.0", "direct:development", "1.0.0")}\n`,
  );
  commit(dir, { ".github/workflows/ci.yml": "name: x\n" }, `build(repo): bump actions/checkout from 4.0.0 to 5.0.0 in /\n\n${actionsBody}\n`);
  commit(dir, {}, "docs: note\n\nupdated-dependencies: の語に触れるだけです。\n");
  const result = await run(dir, ["--check", "--base", "HEAD~3"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});

test("updated-dependencies を文中で触れるだけの commit は、対象に選ばない", async () => {
  await explains("dependabot の commit の抽出のテストです。本文で `updated-dependencies` の語に触れるだけの commit は、対象に選ばず、終了コード 0 で終了することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, {}, "chore: init");
  commit(dir, {}, "docs: note (#80)\n\nこの本文は updated-dependencies: の語に触れるだけです。\n");
  const result = await runPr(dir, 80);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

test("--check: --head の範囲だけを見る。HEAD が先へ進んでいて plan がそこにあっても、head に無ければ 1", async () => {
  await explains("`--check` と `--head` のテストです。`--head` で指定した範囲だけを対象とし、HEAD が先に進んで plan が追加されていても、指定した範囲に plan がなければ終了コード 1 になることを確認します。");
  const dir = await checkRepo("---\npecot-tools: patch\n---\n\n依存を更新した。\n");
  assert.equal((await run(dir, ["--check", "--base", "HEAD~2", "--head", "HEAD~1"])).code, 1);
  assert.equal((await run(dir, ["--check", "--base", "HEAD~2", "--head", "HEAD"])).code, 0);
});

test("--check: CRLF の frontmatter と、引用符付きのキーを読む。bump の種類は問わない", async () => {
  await explains("`--check` の plan の解析のテストです。改行が CRLF の frontmatter と、引用符付きのキーを読み取り、bump の種類にかかわらず終了コード 0 で終了することを確認します。");
  const dir = await checkRepo('---\r\n"pecot-tools": minor\r\n---\r\n\r\n依存を更新した。\r\n');
  const result = await run(dir, ["--check", "--base", "HEAD~2"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

// merge queue の squash は、依存の更新と plan が 1 commit に入り、本文に dependabot の本文が連なる。
async function squashCheckRepo(withPlan) {
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = squashOf(120);
  commit(dir, { ...ROOT_UV, ...Object.fromEntries(real.files.map((file) => [file.path, file.before])) }, "chore: setup");
  const extra = withPlan ? { ".nx/version-plans/120-dependabot-deps.md": "---\npecot-visual: patch\n---\n\n依存を更新した。\n" } : {};
  commit(dir, { ...extra, ...Object.fromEntries(real.files.map((file) => [file.path, file.after])) }, `${stripPr(real.subject)}\n\n${real.body}\n`);
  return dir;
}

test("--check: merge queue の squash に plan が入っていれば 0", async () => {
  await explains("`--check` のテストです。依存の更新と plan が 1 つの commit に入る merge queue の squash の場合に、plan が含まれていれば終了コード 0 で終了することを確認します。");
  const dir = await squashCheckRepo(true);
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

test("--check: merge queue の squash に plan が無ければ 1", async () => {
  await explains("`--check` のテストです。依存の更新だけが入る merge queue の squash の場合に、pecot-visual の plan が不足している旨を出力して終了コード 1 で終了することを確認します。");
  const dir = await squashCheckRepo(false);
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /pecot-visual の version plan がありません/);
});

// pecot-actions は依存を actions/<処理>/dist に同梱して commit する。
const actionsPackage = (core, rollup) =>
  pkg({ name: "@pecot/actions", dependencies: { "@actions/core": core }, devDependencies: { rollup } });

test("actions の dependencies を上げた commit から、pecot-actions の plan を作る", async () => {
  await explains("pecot-actions の依存を扱う `main` のテストです。`actions/package.json` の `dependencies` を更新した commit の場合に、`pecot-actions: patch` の plan を作成することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "actions/package.json": actionsPackage("^3.0.1", "^4.68.8") }, "chore: init");
  commit(
    dir,
    { "actions/package.json": actionsPackage("^3.1.0", "^4.68.8") },
    `build(repo): bump @actions/core in / (#70)\n\n${dependabotBody("@actions/core", "3.1.0", "direct:production", "3.0.1")}\n`,
  );
  const result = await runPr(dir, 70);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.equal(
    fs.readFileSync(path.join(dir, ".nx/version-plans/70-dependabot-deps.md"), "utf8"),
    "---\npecot-actions: patch\n---\n\n`@actions/core` を 3.0.1 から 3.1.0 に更新。\n",
  );
});

test("actions の devDependencies の更新は、作業ツリーの dist が変わったときだけ pecot-actions の plan を作る", async () => {
  await explains("dist を作り直した PR を扱う `main` のテストです。`actions/package.json` の `devDependencies` の更新は、作業ツリーの dist が変わった場合だけ plan を作成することを確認します。");
  const setup = () => {
    const dir = makeRepo();
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    commit(dir, { "actions/package.json": actionsPackage("^3.0.1", "^4.68.8"), "actions/x/dist/index.js": "a\n" }, "chore: init");
    commit(
      dir,
      { "actions/package.json": actionsPackage("^3.0.1", "^4.69.0") },
      `build(repo): bump rollup in / (#71)\n\n${dependabotBody("rollup", "4.69.0", "direct:development", "4.68.8")}\n`,
    );
    return dir;
  };
  const unchanged = setup();
  const devOnly = await runPr(unchanged, 71);
  assert.equal(devOnly.code, 0, devOnly.errors.join("\n"));
  assert.deepEqual(plansIn(unchanged), []);
  assert.equal(summaryOf(devOnly.lines)["作らなかった dependabot の PR（開発用）"], 1);

  const rebuilt = setup();
  writeFiles(rebuilt, { "actions/x/dist/index.js": "b\n" });
  const result = await runPr(rebuilt, 71);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.equal(
    fs.readFileSync(path.join(rebuilt, ".nx/version-plans/71-dependabot-deps.md"), "utf8"),
    "---\npecot-actions: patch\n---\n\n`rollup` を 4.68.8 から 4.69.0 に更新。\n",
  );
  assert.equal(summaryOf(result.lines)["作らなかった dependabot の PR（開発用）"], 0);
});

test("--check: 範囲で actions の dist が変わったのに pecot-actions の plan が無ければ 1、あれば 0", async () => {
  await explains("`--check` と dist のテストです。範囲の commit で `actions/*/dist` が変わった場合に、pecot-actions の plan の有無で終了コードが 1 と 0 に分かれることを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "actions/package.json": actionsPackage("^3.0.1", "^4.68.8"), "actions/x/dist/index.js": "a\n" }, "chore: init");
  commit(
    dir,
    { "actions/package.json": actionsPackage("^3.0.1", "^4.69.0") },
    `build(repo): bump rollup in / (#72)\n\n${dependabotBody("rollup", "4.69.0", "direct:development", "4.68.8")}\n`,
  );
  commit(dir, { "actions/x/dist/index.js": "b\n" }, "chore(repo): dist を作り直す");
  const missing = await run(dir, ["--check", "--base", "HEAD~2"]);
  assert.equal(missing.code, 1);
  assert.match(missing.errors.join("\n"), /pecot-actions の version plan がありません（actions\/\*\/dist が変わっています）/);

  commit(dir, { ".nx/version-plans/72-dependabot-deps.md": "---\npecot-actions: patch\n---\n\n`rollup` を更新。\n" }, "chore(repo): plan");
  const covered = await run(dir, ["--check", "--base", "HEAD~3"]);
  assert.equal(covered.code, 0, covered.errors.join("\n"));
});

test("dist が変わり actions に届く依存が無いときは、範囲の更新をすべて pecot-actions の plan に載せる", async () => {
  await explains("dist を作り直した PR を扱う `main` のテストです。actions に届く依存がない更新で dist が変わった場合に、範囲の更新を載せた pecot-actions の plan を作成し、作らなかった PR に数えないことを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "package.json": pkg({ name: "root", devDependencies: { rollup: "^4.68.8" } }), "actions/x/dist/index.js": "a\n" }, "chore: init");
  commit(
    dir,
    { "package.json": pkg({ name: "root", devDependencies: { rollup: "^4.69.0" } }) },
    `build(repo): bump rollup in / (#73)\n\n${dependabotBody("rollup", "4.69.0", "direct:development", "4.68.8")}\n`,
  );
  writeFiles(dir, { "actions/x/dist/index.js": "b\n" });
  const result = await runPr(dir, 73);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.equal(
    fs.readFileSync(path.join(dir, ".nx/version-plans/73-dependabot-deps.md"), "utf8"),
    "---\npecot-actions: patch\n---\n\n`rollup` を 4.68.8 から 4.69.0 に更新。\n",
  );
  const summary = summaryOf(result.lines);
  assert.equal(summary["作らなかった dependabot の PR（開発用）"], 0);
  assert.equal(summary["作らなかった dependabot の PR（どの package にも当たらない）"], 0);
});

test("--check: dependabot の commit が無い範囲では、dist が変わっていても plan を求めない", async () => {
  await explains("`--check` と dist のテストです。範囲に dependabot の commit がない場合は、`actions/*/dist` が変わっていても plan を求めず、終了コード 0 で終了することを確認します。");
  const dir = makeRepo();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "actions/x/dist/index.js": "a\n" }, "chore: init");
  commit(dir, { "actions/x/dist/index.js": "b\n" }, "fix(actions): dist を作り直す");
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
});
