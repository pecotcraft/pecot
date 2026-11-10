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

const PRN = (commit) => Number(/\(#(\d+)\)\s*$/.exec(commit.subject)?.[1]);
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

test("単独の PR の本文から、directory・依存と旧版を読む", () => {
  const real = realCommits.find((commit) => commit.subject.endsWith("(#5)"));
  assert.deepEqual(parseCommit(real.subject, real.body), {
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
    directory: "/",
    updates: [{ name: "ajv", version: "8.20.0", type: "direct:production", from: "6.15.0" }],
  });
});

// #151（group）の実物。依存名の引用符と、本文の in the / directory を読む。
test("#113 の後の squash の本文（group）を読む", () => {
  const real = squashOf(151);
  const parsed = parseCommit(real.subject, real.body);
  assert.equal(parsed.directory, "/");
  assert.equal(parsed.updates.length, 28);
  assert.ok(parsed.updates.every((u) => u.from !== null && u.version !== ""));
  assert.deepEqual(parsed.updates.slice(0, 1).map((u) => u.name), [real.body.match(/dependency-name: "?([^"\n]+)/)[1]]);
});

test("旧版が本文から読めないときは from を null にする", () => {
  const body = "---\nupdated-dependencies:\n- dependency-name: foo\n  dependency-version: 2.0.0\n  dependency-type: direct:production\n...";
  assert.equal(parseCommit("build: bump foo", body).updates[0].from, null);
});

test("updated-dependencies が読めない本文は throw する", () => {
  assert.throws(() => parseCommit("build: bump foo", "本文なし"), /updated-dependencies/);
  assert.throws(() => parseCommit("build: bump foo", "updated-dependencies:\n..."), /項目がありません/);
  assert.throws(
    () => parseCommit("build: bump foo", "updated-dependencies:\n- dependency-name: foo\n..."),
    /項目が読めません/,
  );
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

test("1 件は「`名前` を 旧版 から 新版 に更新。」の 1 行で、(#N) は付けない", () => {
  assert.equal(
    renderPlan("pecot-tools", [{ name: "commander", from: "14.0.3", version: "15.0.0" }]),
    "---\npecot-tools: patch\n---\n\n`commander` を 14.0.3 から 15.0.0 に更新。\n",
  );
  assert.equal(
    renderPlan("pecot-tools", [{ name: "foo", from: null, version: "2.0.0" }]),
    "---\npecot-tools: patch\n---\n\n`foo` を 2.0.0 に更新。\n",
  );
});

test("2 件は件数の行の後に 1 件 1 行で並べる", () => {
  const text = renderPlan("pecot-tools", [
    { name: "commander", from: "14.0.3", version: "15.0.0" },
    { name: "foo", from: null, version: "2.0.0" },
  ]);
  assert.equal(
    text,
    "---\npecot-tools: patch\n---\n\n依存パッケージを 2 件更新。\n`commander` を 14.0.3 から 15.0.0 に更新。\n`foo` を 2.0.0 に更新。\n",
  );
});

test("3 件以上は 2 件まで載せ「ほか N 件」で締め、形式の上限に収める", () => {
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

test("実物の 11 件から作るのは #5・#6・#10・#16 の 4 件で、作った plan が 2 つの確認を通る", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("--dry-run は .nx/version-plans に書かず、パスと中身を出す", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = await replayRealCommits(dir, ["--dry-run"]);
  for (const result of results) assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), []);
  const printed = results.flatMap(({ lines }) => lines).join("\n");
  assert.match(printed, /5-dependabot-deps\.md\n---\npecot-tools: patch/);
  assert.match(printed, /`commander` を 14\.0\.3 から 15\.0\.0 に更新。\n/);
  assert.doesNotMatch(printed, /\(#\d+\)/);
  assert.equal(sumSummary(results)["作った plan ファイル"], 4);
});

test("引数の誤りはコード 2、読めない本文はコード 1", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("件名に (#N) が無い commit からも、--pr の番号で plan を作る", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("2 つの group に届く PR は、group ごとに別のファイルにする", async (t) => {
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

  const result = await runPr(dir, 30);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["30-dependabot-deps-pecot-tools.md", "30-dependabot-deps-text-rules.md"]);
});

test("--base で範囲を決める。base が HEAD なら commit が無く、plan を作らない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in / (#31)\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  assert.equal((await runPr(dir, 31, "HEAD")).code, 0);
  assert.deepEqual(plansIn(dir), []);
  assert.equal((await runPr(dir, 31, "HEAD~1")).code, 0);
  assert.deepEqual(plansIn(dir), ["31-dependabot-deps.md"]);
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
  const result = await runPr(dir, 50);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.match(fs.readFileSync(path.join(dir, ".nx/version-plans/50-dependabot-deps.md"), "utf8"), /人が書いた本文/);
  assert.equal(summaryOf(result.lines)["作らなかった plan ファイル（既にある）"], 1);
});

test("#113 の後の squash（#120・#151 の実物）から、root に uv.lock があっても group ごとの plan を作る", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("github-actions の PR は plan を作らず、「どの package にも当たらない」に数える", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("lock を読めない indirect は、sha を添えて throw する（コード 1）", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    t.after(() => fs.rmSync(other, { recursive: true, force: true }));
    commit(other, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
    commit(other, { "pnpm-lock.yaml": lock }, `build(repo): bump c in / (#61)\n\n${indirectBody}\n`);
    const broken = await runPr(other, 61);
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
  const result = await runPr(dir, 62, "HEAD~2");
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

  const result = await runPr(dir, 64);
  assert.equal(result.code, 1);
  assert.deepEqual(plansIn(dir), []);
  assert.match(result.errors.join("\n"), /書いた plan は消しました/);

  const dry = await runPr(dir, 64, "HEAD~1", ["--dry-run"]);
  assert.equal(dry.code, 1);
  assert.match(dry.errors.join("\n"), /\.pecot\/tmp\/dependabot-plans に残しました/);
  assert.ok(fs.existsSync(path.join(dir, ".pecot/tmp/dependabot-plans/64-dependabot-deps.md")));
});

test("同じ PR の同じ group に届く 2 commit は、1 つの plan に集約する", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("同じ PR で別の group に届く 2 commit は、group ごとの名前で 1 つずつ作る", async (t) => {
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
  const message = (directory) => `build: bump commander in ${directory}\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`;
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, message("/plugins/pecot-tools"));
  commit(dir, { "libs/text-rules/package.json": toolsPackage("^2.0.0") }, message("/libs/text-rules"));
  const result = await runPr(dir, 72, "HEAD~2");
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(plansIn(dir), ["72-dependabot-deps-pecot-tools.md", "72-dependabot-deps-text-rules.md"]);
});

// --check は、PR が足した plan が、dependabot の commit の届く group を覆うかを見る。
async function checkRepo(t, plan) {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^1.0.0") }, "chore: init");
  commit(dir, { "plugins/pecot-tools/package.json": toolsPackage("^2.0.0") }, `build: bump commander in /plugins/pecot-tools\n\n${dependabotBody("commander", "2.0.0", "direct:production", "1.0.0")}\n`);
  if (plan !== undefined) commit(dir, { ".nx/version-plans/9-dependabot-deps.md": plan }, "chore: plan");
  return dir;
}

test("--check: plan が足されていれば 0", async (t) => {
  const dir = await checkRepo(t, "---\npecot-tools: patch\n---\n\n依存を更新した。\n");
  const result = await run(dir, ["--check", "--base", "HEAD~2"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(plansIn(dir), ["9-dependabot-deps.md"]);
});

test("--check: plan が欠けていれば 1 で、sha と group 名を stderr に出す。plan は書かない", async (t) => {
  const dir = await checkRepo(t);
  const sha = git(dir, "rev-parse", "--short=7", "HEAD").trim();
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 1);
  assert.equal(result.errors.join("\n"), `${sha}: pecot-tools の version plan がありません`);
  assert.deepEqual(plansIn(dir), []);

  const other = await checkRepo(t, "---\ntext-rules: patch\n---\n\n依存を更新した。\n");
  assert.equal((await run(other, ["--check", "--base", "HEAD~2"])).code, 1);
});

test("--check: plan の要らない PR（開発用だけ・github-actions・dependabot の commit なし）は 0", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test("updated-dependencies を文中で触れるだけの commit は、対象に選ばない", async (t) => {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  commit(dir, {}, "chore: init");
  commit(dir, {}, "docs: note (#80)\n\nこの本文は updated-dependencies: の語に触れるだけです。\n");
  const result = await runPr(dir, 80);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

test("--check: --head の範囲だけを見る。HEAD が先へ進んでいて plan がそこにあっても、head に無ければ 1", async (t) => {
  const dir = await checkRepo(t, "---\npecot-tools: patch\n---\n\n依存を更新した。\n");
  assert.equal((await run(dir, ["--check", "--base", "HEAD~2", "--head", "HEAD~1"])).code, 1);
  assert.equal((await run(dir, ["--check", "--base", "HEAD~2", "--head", "HEAD"])).code, 0);
});

test("--check: CRLF の frontmatter と、引用符付きのキーを読む。bump の種類は問わない", async (t) => {
  const dir = await checkRepo(t, '---\r\n"pecot-tools": minor\r\n---\r\n\r\n依存を更新した。\r\n');
  const result = await run(dir, ["--check", "--base", "HEAD~2"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

// merge queue の squash は、依存の更新と plan が 1 commit に入り、本文に dependabot の本文が連なる。
async function squashCheckRepo(t, withPlan) {
  const dir = makeRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const real = squashOf(120);
  commit(dir, { ...ROOT_UV, ...Object.fromEntries(real.files.map((file) => [file.path, file.before])) }, "chore: setup");
  const extra = withPlan ? { ".nx/version-plans/120-dependabot-deps.md": "---\npecot-visual: patch\n---\n\n依存を更新した。\n" } : {};
  commit(dir, { ...extra, ...Object.fromEntries(real.files.map((file) => [file.path, file.after])) }, `${stripPr(real.subject)}\n\n${real.body}\n`);
  return dir;
}

test("--check: merge queue の squash に plan が入っていれば 0", async (t) => {
  const dir = await squashCheckRepo(t, true);
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 0, result.errors.join("\n"));
});

test("--check: merge queue の squash に plan が無ければ 1", async (t) => {
  const dir = await squashCheckRepo(t, false);
  const result = await run(dir, ["--check", "--base", "HEAD~1"]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /pecot-visual の version plan がありません/);
});
