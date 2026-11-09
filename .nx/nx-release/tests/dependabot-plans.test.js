"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseCommit, parseUvLock, resolveGroups, renderPlan, main } = require("../src/dependabot-plans");
const realCommits = require("./_fixtures/dependabot-real.json");
const squashCommits = require("./_fixtures/dependabot-squash.json");

const TOOLS_ROOT = path.resolve(__dirname, "../../..");
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

test("単独の PR の本文から、PR 番号・directory・依存と旧版を読む", () => {
  const real = realCommits.find((commit) => commit.subject.endsWith("(#5)"));
  assert.deepEqual(parseCommit(real.subject, real.body), {
    pr: 5,
    directory: "/plugins/pecot-tools",
    updates: [{ name: "commander", version: "15.0.0", type: "direct:production", from: "14.0.3" }],
  });
});

test("group の PR の本文から、directory と複数の依存を読む", () => {
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
test("#113 の後の squash の本文（単独）を読む。directory が無ければ / とみなす", () => {
  const real = squashOf(120);
  assert.deepEqual(parseCommit(real.subject, real.body), {
    pr: 120,
    directory: "/",
    updates: [{ name: "ajv", version: "8.20.0", type: "direct:production", from: "6.15.0" }],
  });
});

// #151（group）の実物。依存名の引用符と、本文の in the / directory を読む。
test("#113 の後の squash の本文（group）を読む", () => {
  const real = squashOf(151);
  const parsed = parseCommit(real.subject, real.body);
  assert.equal(parsed.pr, 151);
  assert.equal(parsed.directory, "/");
  assert.equal(parsed.updates.length, 28);
  assert.ok(parsed.updates.every((u) => u.from !== null && u.version !== ""));
  assert.deepEqual(parsed.updates.slice(0, 1).map((u) => u.name), [real.body.match(/dependency-name: "?([^"\n]+)/)[1]]);
});

test("旧版が本文から読めないときは from を null にする", () => {
  const body = "---\nupdated-dependencies:\n- dependency-name: foo\n  dependency-version: 2.0.0\n  dependency-type: direct:production\n...";
  assert.equal(parseCommit("build: bump foo (#9)", body).updates[0].from, null);
});

test("updated-dependencies が読めない本文と、件名に (#N) が無いコミットは throw する", () => {
  assert.throws(() => parseCommit("build: bump foo (#9)", "本文なし"), /updated-dependencies/);
  assert.throws(() => parseCommit("build: bump foo (#9)", "updated-dependencies:\n..."), /項目がありません/);
  assert.throws(
    () => parseCommit("build: bump foo (#9)", "updated-dependencies:\n- dependency-name: foo\n..."),
    /項目が読めません/,
  );
  assert.throws(() => parseCommit("build: bump foo", dependabotBody("foo", "2.0.0", "direct:production", "1.0.0")), /\(#N\)/);
});

test("dependencies の宣言は、group の path の前方一致で plan の対象にする", () => {
  const ctx = emptyCtx({
    declarations: {
      commander: [decl("plugins/pecot-tools/cli/package.json", "dependencies")],
      zod: [decl("libs/text-rules/package.json", "optionalDependencies")],
    },
  });
  assert.deepEqual(resolveGroups(update("commander"), ctx), { groups: ["pecot-tools"], reason: null });
  assert.deepEqual(resolveGroups(update("zod"), ctx), { groups: ["text-rules"], reason: null });
});

test("devDependencies だけの宣言は「開発用」で、pecot-visual は配布物の依存名なら対象にする", () => {
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

test("root と tests/ の下の宣言は、どの package にも当たらない", () => {
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

test("版の割れた @types/node は、指定の変わった package だけに作る", () => {
  const ctx = emptyCtx({
    declarations: {
      "@types/node": [
        decl("plugins/pecot-tools/cli/package.json", "dependencies", true),
        decl("plugins/pecot-workflow/cli-node/package.json", "dependencies", false),
        decl("libs/text-rules/package.json", "dependencies", false),
      ],
    },
  });
  assert.deepEqual(resolveGroups(update("@types/node"), ctx), { groups: ["pecot-tools"], reason: null });
});

test("lock だけが変わったときは、宣言している package.json の全部を根拠にする", () => {
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

test("uv は directory の group と YAML の dependency-type で決める", () => {
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

test("uv の indirect は、プロジェクトの本番の依存から届くときだけ作る。dev からだけなら「開発用」", () => {
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

test("uv の indirect で uv.lock を読めていないときは throw する", () => {
  const ctx = emptyCtx({ uv: true, directory: "/plugins/pecot-workflow/cli" });
  assert.throws(() => resolveGroups(update("click", "indirect"), ctx), /uv\.lock/);
});

const lockOf = (importers, snapshots) => ({ importers, snapshots });
const dep = (version) => ({ version });

test("indirect は、group の本番の依存から辿って新版へ届くとき作る", () => {
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

test("indirect が dev の依存からしか届かないときと、どこにも届かないときは作らない", () => {
  const lock = lockOf(
    { "plugins/pecot-tools/cli": { devDependencies: { vitest: dep("5.0.0") }, dependencies: { a: dep("1.0.0") } } },
    { "vitest@5.0.0": { dependencies: { d: "1.0.0" } }, "d@1.0.0": {}, "a@1.0.0": {}, "e@1.0.0": {} },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("d", "indirect", "1.0.0"), ctx), { groups: [], reason: "dev" });
  assert.deepEqual(resolveGroups(update("e", "indirect", "1.0.0"), ctx), { groups: [], reason: "none" });
  assert.deepEqual(resolveGroups(update("d", "indirect", "1.0.0"), emptyCtx()), { groups: [], reason: "none" });
});

test("pecot-visual の配布物の dev 依存から届く indirect は作る", () => {
  const lock = lockOf(
    { "plugins/pecot-visual/assets/slidev": { devDependencies: { eslint: dep("10.0.0"), knip: dep("6.0.0") } } },
    { "eslint@10.0.0": { dependencies: { f: "1.0.0" } }, "f@1.0.0": {}, "knip@6.0.0": { dependencies: { g: "1.0.0" } }, "g@1.0.0": {} },
  );
  const ctx = emptyCtx({ lock });
  assert.deepEqual(resolveGroups(update("f", "indirect", "1.0.0"), ctx), { groups: ["pecot-visual"], reason: null });
  assert.deepEqual(resolveGroups(update("g", "indirect", "1.0.0"), ctx), { groups: [], reason: "dev" });
});

test("本文は 1 文で、末尾に (#N) が付く。旧版が無い依存は「名前 → 新版」にする", () => {
  const text = renderPlan(
    "pecot-tools",
    [
      { name: "commander", from: "14.0.3", version: "15.0.0" },
      { name: "foo", from: null, version: "2.0.0" },
    ],
    5,
  );
  assert.equal(text, "---\npecot-tools: patch\n---\n\n依存を更新した（commander 14.0.3 → 15.0.0、foo → 2.0.0）。(#5)\n");
});

test("100 字を超えるときは「ほか N 件」で締めて 100 字以内に収める", () => {
  const deps = Array.from({ length: 12 }, (_, i) => ({ name: `package-${i}`, from: "1.0.0", version: "1.1.0" }));
  const body = renderPlan("pecot-visual", deps, 77).split("\n").at(-2);
  assert.ok([...body].length <= 100, body);
  assert.match(body, /^依存を更新した（package-0 1\.0\.0 → 1\.1\.0、.*、ほか \d+ 件）。\(#77\)$/);
  const shown = (body.match(/package-/g) ?? []).length;
  assert.match(body, new RegExp(`ほか ${12 - shown} 件`));
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

function replayRealCommits(dir) {
  commit(dir, { ...ROOT_UV, "plugins/pecot-workflow/cli/pyproject.toml": "[project]\nname = 'x'\n" }, "chore: init");
  for (const real of realCommits) {
    writeFiles(dir, Object.fromEntries(real.files.map((file) => [file.path, file.before])));
    git(dir, "add", "-A");
    if (git(dir, "status", "--porcelain").trim() !== "") commit(dir, {}, `chore: setup ${real.sha}`);
    commit(dir, Object.fromEntries(real.files.map((file) => [file.path, file.after])), `${real.subject}\n\n${real.body}\n`);
  }
}

test("実物の 11 件から作るのは #5・#6・#10・#16 の 4 件で、作った plan が 2 つの確認を通る", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  replayRealCommits(dir);

  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), [
    "10-dependabot-deps.md",
    "16-dependabot-deps.md",
    "5-dependabot-deps.md",
    "6-dependabot-deps.md",
  ]);
  const read = (name) => fs.readFileSync(path.join(dir, ".nx/version-plans", name), "utf8");
  assert.equal(read("5-dependabot-deps.md"), "---\npecot-tools: patch\n---\n\n依存を更新した（commander 14.0.3 → 15.0.0）。(#5)\n");
  assert.equal(read("10-dependabot-deps.md"), "---\npecot-workflow: patch\n---\n\n依存を更新した（commander 14.0.3 → 15.0.0）。(#10)\n");
  assert.equal(read("16-dependabot-deps.md"), "---\npecot-visual: patch\n---\n\n依存を更新した（commander 14.0.3 → 15.0.0）。(#16)\n");
  assert.equal(
    read("6-dependabot-deps.md"),
    "---\npecot-workflow: patch\n---\n\n依存を更新した（typer 0.26.8 → 0.27.3、pydantic 2.14.1 → 2.14.2）。(#6)\n",
  );
  assert.deepEqual(summaryOf(result.lines), {
    "作った plan ファイル": 4,
    "作らなかった dependabot の PR（開発用）": 7,
    "作らなかった dependabot の PR（どの package にも当たらない）": 0,
    "作らなかった plan ファイル（既にある）": 0,
  });

  const again = await run(dir);
  assert.equal(again.code, 0);
  assert.equal(summaryOf(again.lines)["作らなかった plan ファイル（既にある）"], 4);
  assert.equal(plansIn(dir).length, 4);
});

test("--dry-run は .nx/version-plans に書かず、パスと中身を出す", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  replayRealCommits(dir);

  const result = await run(dir, ["--dry-run"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  const printed = result.lines.join("\n");
  assert.match(printed, /5-dependabot-deps\.md\n---\npecot-tools: patch/);
  assert.match(printed, /依存を更新した（commander 14\.0\.3 → 15\.0\.0）。\(#5\)/);
  assert.equal(summaryOf(result.lines)["作った plan ファイル"], 4);
});

test("引数の誤りはコード 2、読めない本文と (#N) の無い件名はコード 1", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  assert.equal((await run(dir, ["--unknown"])).code, 2);
  assert.equal((await run(dir, ["--since-ref"])).code, 2);

  commit(dir, {}, "build: bump foo (#3)\n\nupdated-dependencies:\n- dependency-name: foo\n...\n");
  const broken = await run(dir);
  assert.equal(broken.code, 1);
  assert.match(broken.errors.join("\n"), /項目が読めません/);

  const noPr = makeRepo();
  t.after(() => fs.rmSync(noPr, { recursive: true, force: true }));
  commit(noPr, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(noPr, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  const result = await run(noPr);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /\(#N\)/);
});

test("2 つの group に届く PR は、group ごとに別のファイルにする。範囲で除かれても名前は変わらない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  git(dir, "tag", "text-rules-v1.0.0");

  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["30-dependabot-deps-pecot-tools.md"]);
});

test("--since-ref で全 group の起点をそろえられる", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in / (#31)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  const head = git(dir, "rev-parse", "HEAD").trim();
  assert.equal((await run(dir, ["--since-ref", head])).code, 0);
  assert.deepEqual(plansIn(dir), []);
  assert.equal((await run(dir, ["--since-ref", "HEAD~1"])).code, 0);
  assert.deepEqual(plansIn(dir), ["31-dependabot-deps.md"]);
});

test("FR-030: tag の後に履歴を書き換え、diff が同じ commit を作り直しても plan を作らない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  const message = `build: bump commander in /plugins/pecot-tools (#40)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`;
  const original = commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message);
  git(dir, "tag", "pecot-tools-v1.0.0", original);

  git(dir, "reset", "-q", "--hard", "HEAD~1");
  const rewritten = commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message, ["--date=2030-01-01T00:00:00"]);
  assert.notEqual(rewritten, original);

  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  assert.equal(summaryOf(result.lines)["作った plan ファイル"], 0);

  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^3.0.0") }, `build: bump commander in /plugins/pecot-tools (#41)\n\n${dependabotBody("commander", "3.0.0", "direct:production", "2.0.0")}\n`);
  assert.equal((await run(dir)).code, 0);
  assert.deepEqual(plansIn(dir), ["41-dependabot-deps.md"]);
});

test("同じ名前の plan が既にあるときは上書きしない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    {
      "plugins/pecot-tools/package.json": toolsPackage("^2.0.0"),
      ".nx/version-plans/50-dependabot-deps.md": "---\npecot-tools: minor\n---\n\n人が書いた本文。\n",
    },
    `build: bump commander in /plugins/pecot-tools (#50)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.match(fs.readFileSync(path.join(dir, ".nx/version-plans/50-dependabot-deps.md"), "utf8"), /人が書いた本文/);
  assert.equal(summaryOf(result.lines)["作らなかった plan ファイル（既にある）"], 1);
});

test("#113 の後の squash（#120・#151 の実物）から、root に uv.lock があっても group ごとの plan を作る", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const real of squashCommits) {
    commit(dir, { ...ROOT_UV, ...Object.fromEntries(real.files.map((file) => [file.path, file.before])) }, `chore: setup ${real.pr}`);
    commit(dir, Object.fromEntries(real.files.map((file) => [file.path, file.after])), `${real.subject}\n\n${real.body}\n`);
  }

  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
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

test("github-actions の PR は plan を作らず、「どの package にも当たらない」に数える", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { ".github/workflows/ci.yml": "name: x\n" }, `build(repo): bump actions/checkout from 4.0.0 to 5.0.0 in / (#60)\n\n${actionsBody}\n`);
  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  const summary = summaryOf(result.lines);
  assert.equal(summary["作った plan ファイル"], 0);
  assert.equal(summary["作らなかった dependabot の PR（どの package にも当たらない）"], 1);
});

const indirectBody = dependabotBody("c", "3.0.0", "indirect", "2.0.0");

test("lock を読めない indirect は、sha を添えて throw する（コード 1）", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  const sha = commit(dir, {}, `build(repo): bump c in / (#61)\n\n${indirectBody}\n`);
  const result = await run(dir);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), new RegExp(`${sha.slice(0, 7)}: pnpm-lock\\.yaml がありません`));

  for (const [lock, pattern] of [
    ["importers: [\n", /pnpm-lock\.yaml を parse できません/],
    ["lockfileVersion: '9.0'\n", /importers がありません/],
  ]) {
    const other = makeRepo();
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    commit(other, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
    commit(other, { "pnpm-lock.yaml": lock }, `build(repo): bump c in / (#61)\n\n${indirectBody}\n`);
    const broken = await run(other);
    assert.equal(broken.code, 1);
    assert.match(broken.errors.join("\n"), pattern);
  }
});

test("例外のときは、書いた plan を残さない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") },
    `build: bump commander in /plugins/pecot-tools (#62)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  commit(dir, {}, `build(repo): bump c in / (#63)\n\n${indirectBody}\n`);
  const result = await run(dir);
  assert.equal(result.code, 1);
  assert.deepEqual(plansIn(dir), []);
});

test("検証を通らない plan は消す。dry-run では .pecot/tmp に残した旨を出す", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(
    dir,
    { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") },
    `build: bump commander in /plugins/pecot-tools (#64)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`,
  );
  process.env.PECOT_PLAN_MAX_LINE_CHARS = "10";
  t.after(() => delete process.env.PECOT_PLAN_MAX_LINE_CHARS);

  const result = await run(dir);
  assert.equal(result.code, 1);
  assert.deepEqual(plansIn(dir), []);
  assert.match(result.errors.join("\n"), /書いた plan は消しました/);

  const dry = await run(dir, ["--dry-run"]);
  assert.equal(dry.code, 1);
  assert.match(dry.errors.join("\n"), /\.pecot\/tmp\/dependabot-plans に残しました/);
  assert.ok(fs.existsSync(path.join(dir, ".pecot/tmp/dependabot-plans/64-dependabot-deps.md")));
});

test("plan は commit の古い順に出す", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(
    dir,
    { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0"), "libs/text-rules/package.json": toolsPackage("^1.0.0") },
    "chore: init",
  );
  const message = (pr) => `build: bump commander in / (#${pr})\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`;
  commit(dir, { "libs/text-rules/package.json": toolsPackage("^2.0.0") }, message(71));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message(72));
  const result = await run(dir, ["--dry-run", "--since-ref", "HEAD~2"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  const printed = result.lines.filter((line) => /dependabot-deps\.md$/.test(line.split("\n")[0]));
  assert.deepEqual(printed.map((line) => path.basename(line.split("\n")[0])), ["71-dependabot-deps.md", "72-dependabot-deps.md"]);
});

test("updated-dependencies を文中で触れるだけの commit は、対象に選ばない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, {}, "chore: init");
  commit(dir, {}, "docs: note (#80)\n\nこの本文は updated-dependencies: の語に触れるだけです。\n");
  const result = await run(dir);
  assert.equal(result.code, 0, result.errors.join("\n"));
});
