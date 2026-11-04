"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { PecotVersionActions } = require("../src/version-actions");
const { PecotPackageVersionActions } = require("../src/package-version-actions");

// 親クラスの init() を通さず、manifestsToUpdate と projectGraphNode だけを持つ
// インスタンスを作る（本番では init() がこの 2 つを埋める）。
function makeActions(manifestPaths) {
  const actions = Object.create(PecotVersionActions.prototype);
  actions.manifestsToUpdate = manifestPaths.map((manifestPath) => ({ manifestPath }));
  actions.projectGraphNode = { name: "pecot-workflow" };
  return actions;
}

// nx の Tree のうち read / write だけを持つメモリ上の木。
function makeTree(files) {
  const store = new Map(Object.entries(files));
  return {
    read: (path) => (store.has(path) ? Buffer.from(store.get(path)) : null),
    write: (path, content) => store.set(path, content),
    get: (path) => store.get(path),
  };
}

const CLAUDE = "plugins/pecot-workflow/.claude-plugin/plugin.json";
const COPILOT = "plugins/pecot-workflow/.github/plugin/plugin.json";

test("先頭の plugin.json から現在の version を読む", async () => {
  const tree = makeTree({ [CLAUDE]: '{"name":"pecot-w","version":"1.29.3"}\n' });
  const result = await makeActions([CLAUDE]).readCurrentVersionFromSourceManifest(tree);
  assert.deepEqual(result, { currentVersion: "1.29.3", manifestPath: CLAUDE });
});

test("version が空なら throw する", async () => {
  const tree = makeTree({ [CLAUDE]: '{"name":"pecot-w","version":""}\n' });
  await assert.rejects(
    makeActions([CLAUDE]).readCurrentVersionFromSourceManifest(tree),
    /version フィールド/,
  );
});

test("manifestsToUpdate が空なら throw する", async () => {
  await assert.rejects(
    makeActions([]).readCurrentVersionFromSourceManifest(makeTree({})),
    /manifestsToUpdate が空/,
  );
});

test("両配布チャネルの plugin.json の version を書き換え、他のフィールドを保つ", async () => {
  const tree = makeTree({
    [CLAUDE]: '{"name":"pecot-w","version":"1.29.3"}\n',
    [COPILOT]: '{"name":"pecot-w","version":"1.29.3","hooks":"hooks/hooks-copilot.json"}\n',
  });
  const logs = await makeActions([CLAUDE, COPILOT]).updateProjectVersion(tree, "2.0.0");
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(tree.get(CLAUDE)), { name: "pecot-w", version: "2.0.0" });
  assert.deepEqual(JSON.parse(tree.get(COPILOT)), {
    name: "pecot-w",
    version: "2.0.0",
    hooks: "hooks/hooks-copilot.json",
  });
});

test("Agent Plugins 1.0 形式のルートの plugin.json も更新し、$schema など他のフィールドを保つ", async () => {
  const claude = "plugins/pecot-visual/.claude-plugin/plugin.json";
  const root = "plugins/pecot-visual/plugin.json";
  const tree = makeTree({
    [claude]: '{"name":"pecot-v","version":"0.67.0"}\n',
    [root]:
      '{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"pecot-v","version":"0.67.0"}\n',
  });
  const logs = await makeActions([claude, root]).updateProjectVersion(tree, "0.68.0");
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(tree.get(claude)), { name: "pecot-v", version: "0.68.0" });
  assert.deepEqual(JSON.parse(tree.get(root)), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "pecot-v",
    version: "0.68.0",
  });
});

test("末尾改行の有無を元の manifest に合わせる", async () => {
  const tree = makeTree({
    [CLAUDE]: '{"version":"1.0.0"}\n',
    [COPILOT]: '{"version":"1.0.0"}',
  });
  await makeActions([CLAUDE, COPILOT]).updateProjectVersion(tree, "1.1.0");
  assert.ok(tree.get(CLAUDE).endsWith("}\n"));
  assert.ok(tree.get(COPILOT).endsWith("}"));
});

test("manifest を読めなければ throw する", async () => {
  await assert.rejects(
    makeActions([CLAUDE]).updateProjectVersion(makeTree({}), "1.1.0"),
    /manifest を読めません/,
  );
});

// --- 実 project.json から init() 経由で manifest を展開する ---

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

// 実ファイルに委ねる最小の Tree。init() は exists しか使わない。
const fsTree = {
  exists: (p) => fs.existsSync(path.join(REPO_ROOT, p)),
  read: (p) => fs.readFileSync(path.join(REPO_ROOT, p)),
};

// nx が project.json から作る finalConfigForProject のうち init() が読む部分。
function readProject(root) {
  const projectJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, root, "project.json"), "utf8"),
  );
  return {
    projectGraphNode: { name: projectJson.name, data: { root } },
    finalConfigForProject: {
      manifestRootsToUpdate: [...projectJson.release.version.manifestRootsToUpdate],
    },
  };
}

const EXPECTED_MANIFESTS = {
  "pecot-workflow": [
    "plugins/pecot-workflow/.claude-plugin/plugin.json",
    "plugins/pecot-workflow/.github/plugin/plugin.json",
  ],
  // pecot-visual / pecot-tools の Copilot CLI 向けは Agent Plugins 1.0 形式のルートの plugin.json を使う。
  // .github/plugin/plugin.json は持たない。先頭の .claude-plugin/plugin.json が現在の版の基準。
  "pecot-visual": [
    "plugins/pecot-visual/.claude-plugin/plugin.json",
    "plugins/pecot-visual/plugin.json",
  ],
  "pecot-tools": [
    "plugins/pecot-tools/.claude-plugin/plugin.json",
    "plugins/pecot-tools/plugin.json",
  ],
};

for (const [dir, expected] of Object.entries(EXPECTED_MANIFESTS)) {
  test(`${dir}: init() が project.json の manifestRootsToUpdate を実在する plugin.json に展開する`, async () => {
    const { projectGraphNode, finalConfigForProject } = readProject(`plugins/${dir}`);
    const actions = new PecotVersionActions({}, projectGraphNode, finalConfigForProject);
    await actions.init(fsTree);
    assert.deepEqual(actions.validManifestFilenames, ["plugin.json"]);
    assert.deepEqual(
      actions.manifestsToUpdate.map((m) => m.manifestPath),
      expected,
    );
    for (const { manifestPath } of actions.manifestsToUpdate) {
      assert.ok(fsTree.exists(manifestPath), `${manifestPath} が存在しない`);
    }
    const { currentVersion } = await actions.readCurrentVersionFromSourceManifest(fsTree);
    assert.match(currentVersion, /^\d+\.\d+\.\d+/);
    // 展開した manifest はすべて同じ版（bump の前提）。
    for (const { manifestPath } of actions.manifestsToUpdate) {
      assert.equal(JSON.parse(fsTree.read(manifestPath).toString()).version, currentVersion, manifestPath);
    }
  });
}

// --- package.json を manifest とする project（libs/text-rules） ---

const LIB_MANIFESTS = ["libs/text-rules/package.json"];

test("libs/text-rules: init() が実体の package.json に展開する", async () => {
  const { projectGraphNode, finalConfigForProject } = readProject("libs/text-rules");
  const actions = new PecotPackageVersionActions({}, projectGraphNode, finalConfigForProject);
  await actions.init(fsTree);
  assert.deepEqual(actions.validManifestFilenames, ["package.json"]);
  assert.deepEqual(
    actions.manifestsToUpdate.map((m) => m.manifestPath),
    LIB_MANIFESTS,
  );
  const { currentVersion } = await actions.readCurrentVersionFromSourceManifest(fsTree);
  assert.match(currentVersion, /^\d+\.\d+\.\d+/);
  for (const { manifestPath } of actions.manifestsToUpdate) {
    assert.equal(JSON.parse(fsTree.read(manifestPath).toString()).version, currentVersion, manifestPath);
  }
});

test("libs/text-rules: package.json の version を書き換え、他のフィールドを保つ", async () => {
  const tree = makeTree({
    "libs/text-rules/package.json": '{"name":"@pecot/text-rules-src","version":"0.0.0","type":"module"}\n',
  });
  const actions = Object.create(PecotPackageVersionActions.prototype);
  actions.manifestsToUpdate = LIB_MANIFESTS.map((manifestPath) => ({ manifestPath }));
  actions.projectGraphNode = { name: "text-rules" };
  const logs = await actions.updateProjectVersion(tree, "0.1.0");
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(tree.get("libs/text-rules/package.json")), {
    name: "@pecot/text-rules-src",
    version: "0.1.0",
    type: "module",
  });
});
