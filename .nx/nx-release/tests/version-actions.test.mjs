import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { test } from "vitest";

// src は CommonJS なので、Node の require で読む。
const require = createRequire(import.meta.url);
const { PecotVersionActions } = require("../src/version-actions");
const { PecotPackageVersionActions } = require("../src/package-version-actions");

// 親クラスの init() を通さず、manifestsToUpdate と projectGraphNode だけを持つ
// インスタンスを作る（本番では init() がこの 2 つを埋める）。
function makeActions(manifestPaths, name = "pecot-workflow") {
  const actions = Object.create(PecotVersionActions.prototype);
  actions.manifestsToUpdate = manifestPaths.map((manifestPath) => ({ manifestPath }));
  actions.projectGraphNode = { name, data: { root: `plugins/${name}` } };
  return actions;
}

// nx の Tree のうち exists / read / write だけを持つメモリ上の木。
function makeTree(files) {
  const store = new Map(Object.entries(files));
  return {
    exists: (path) => store.has(path),
    read: (path) => (store.has(path) ? Buffer.from(store.get(path)) : null),
    write: (path, content) => store.set(path, content),
    get: (path) => store.get(path),
  };
}

const CLAUDE = "plugins/pecot-workflow/.claude-plugin/plugin.json";
const COPILOT = "plugins/pecot-workflow/plugin.json";

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
    [COPILOT]: '{"name":"pecot-w","version":"1.29.3","$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"}\n',
  });
  const logs = await makeActions([CLAUDE, COPILOT]).updateProjectVersion(tree, "2.0.0");
  assert.equal(logs.length, 2);
  assert.deepEqual(JSON.parse(tree.get(CLAUDE)), { name: "pecot-w", version: "2.0.0" });
  assert.deepEqual(JSON.parse(tree.get(COPILOT)), {
    name: "pecot-w",
    version: "2.0.0",
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
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

// --- MCP の登録（.mcp.json・mcp.json）の npm の版 ---

const TOOLS_CLAUDE = "plugins/pecot-tools/.claude-plugin/plugin.json";
const TOOLS_MCP = "plugins/pecot-tools/.mcp.json";
const TOOLS_AGENT_MCP = "plugins/pecot-tools/mcp.json";
const TOOLS_MCP_BEFORE = `{
  "mcpServers": {
    "pecot-tools": {
      "command": "npx",
      "args": [
        "--prefix=\${CLAUDE_PLUGIN_DATA}",
        "-y",
        "@pecot/tools-mcp@3.1.0"
      ]
    }
  }
}
`;
const TOOLS_AGENT_MCP_BEFORE = `{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "pecot-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["--prefix=\${PLUGIN_DATA}", "-y", "@pecot/tools-mcp@3.1.0"]
    }
  }
}`;

test(".mcp.json・mcp.json の @pecot/<名前>-mcp の版だけを書き換え、整形を保つ", async () => {
  const tree = makeTree({
    [TOOLS_CLAUDE]: '{"name":"pecot-t","version":"3.1.0"}\n',
    [TOOLS_MCP]: TOOLS_MCP_BEFORE,
    [TOOLS_AGENT_MCP]: TOOLS_AGENT_MCP_BEFORE,
  });
  const logs = await makeActions([TOOLS_CLAUDE], "pecot-tools").updateProjectVersion(tree, "4.0.0-rc.0");
  assert.equal(tree.get(TOOLS_MCP), TOOLS_MCP_BEFORE.replace("@pecot/tools-mcp@3.1.0", "@pecot/tools-mcp@4.0.0-rc.0"));
  assert.equal(
    tree.get(TOOLS_AGENT_MCP),
    TOOLS_AGENT_MCP_BEFORE.replace("@pecot/tools-mcp@3.1.0", "@pecot/tools-mcp@4.0.0-rc.0"),
  );
  assert.deepEqual(logs, [
    `Updated ${TOOLS_CLAUDE} to 4.0.0-rc.0`,
    `Updated ${TOOLS_MCP} to 4.0.0-rc.0`,
    `Updated ${TOOLS_AGENT_MCP} to 4.0.0-rc.0`,
  ]);
});

test("ほかの project の npm の指定は書き換えない", async () => {
  const visualMcp = `{"mcpServers":{"pecot-visual-playwright":{"command":"npx","args":["-y","@playwright/mcp@0.0.83","@pecot/tools-mcp@3.1.0"]}}}\n`;
  const visualClaude = "plugins/pecot-visual/.claude-plugin/plugin.json";
  const tree = makeTree({
    [visualClaude]: '{"name":"pecot-v","version":"0.67.0"}\n',
    "plugins/pecot-visual/.mcp.json": visualMcp,
  });
  const logs = await makeActions([visualClaude], "pecot-visual").updateProjectVersion(tree, "0.68.0");
  assert.equal(tree.get("plugins/pecot-visual/.mcp.json"), visualMcp);
  assert.deepEqual(logs, [`Updated ${visualClaude} to 0.68.0`]);
});

test(".mcp.json・mcp.json が無ければ何もしない", async () => {
  const tree = makeTree({ [TOOLS_CLAUDE]: '{"name":"pecot-t","version":"3.1.0"}\n' });
  const logs = await makeActions([TOOLS_CLAUDE], "pecot-tools").updateProjectVersion(tree, "4.0.0");
  assert.equal(tree.exists(TOOLS_MCP), false);
  assert.equal(tree.exists(TOOLS_AGENT_MCP), false);
  assert.deepEqual(logs, [`Updated ${TOOLS_CLAUDE} to 4.0.0`]);
});

// --- 実 project.json から init() 経由で manifest を展開する ---

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

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
  // Copilot CLI 向けは 3 プラグインとも Agent Plugins 1.0 形式のルートの plugin.json を使う。
  // .github/plugin/plugin.json は持たない。先頭の .claude-plugin/plugin.json が現在の版の基準。
  "pecot-workflow": [
    "plugins/pecot-workflow/.claude-plugin/plugin.json",
    "plugins/pecot-workflow/plugin.json",
  ],
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
  actions.projectGraphNode = { name: "text-rules", data: { root: "libs/text-rules" } };
  const logs = await actions.updateProjectVersion(tree, "0.1.0");
  assert.equal(logs.length, 1);
  assert.deepEqual(JSON.parse(tree.get("libs/text-rules/package.json")), {
    name: "@pecot/text-rules-src",
    version: "0.1.0",
    type: "module",
  });
});
