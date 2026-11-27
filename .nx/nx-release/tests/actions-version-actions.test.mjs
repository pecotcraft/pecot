import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { test } from "vitest";

import { explains } from "../../../libs/interface-spec/src/vitest/explains.js";

// src は CommonJS なので、Node の require で読む。
const require = createRequire(import.meta.url);
const { PecotActionsVersionActions } = require("../src/actions-version-actions");

const MANIFEST = "actions/package.json";
const TEMPLATE = "actions/templates/pecot-board-sync.yml";
const COPY = "plugins/pecot-workflow/cli/templates/workflow/pecot-board-sync.yml";

function makeActions() {
  const actions = Object.create(PecotActionsVersionActions.prototype);
  actions.manifestsToUpdate = [{ manifestPath: MANIFEST }];
  actions.projectGraphNode = { name: "actions", data: { root: "actions" } };
  return actions;
}

// nx の Tree のうち read・write・exists・children だけを持つメモリ上の木
function makeTree(files) {
  const store = new Map(Object.entries(files));
  const childrenOf = (directory) => [...store.keys()]
    .filter((path) => path.startsWith(`${directory}/`))
    .map((path) => path.slice(directory.length + 1))
    .filter((rest) => !rest.includes("/"));
  return {
    read: (path) => (store.has(path) ? Buffer.from(store.get(path)) : null),
    write: (path, content) => store.set(path, content),
    exists: (path) => store.has(path) || childrenOf(path).length > 0,
    children: childrenOf,
    get: (path) => store.get(path),
  };
}

test("package.json の版を上げ、正と写しの雛形の版の印を書き換える", async () => {
  await explains("actions の版を上げる `updateProjectVersion` のテストです。`actions/package.json` の版を上げ、正の雛形とプラグインの写しにある `pecot-actions/v<版>` の印を書き換え、README は書き換えないことを確認します。");
  const uses = (version) => `      - uses: pecotcraft/pecot/actions/board-sync@pecot-actions/v${version}\n`;
  const tree = makeTree({
    [MANIFEST]: '{"name":"@pecot/actions","version":"1.0.0"}\n',
    [TEMPLATE]: uses("1.0.0"),
    [COPY]: uses("1.0.0"),
    "actions/templates/README.md": uses("1.0.0"),
  });
  const logs = await makeActions().updateProjectVersion(tree, "1.1.0");
  assert.deepEqual(JSON.parse(tree.get(MANIFEST)), { name: "@pecot/actions", version: "1.1.0" });
  assert.equal(tree.get(TEMPLATE), uses("1.1.0"));
  assert.equal(tree.get(COPY), uses("1.1.0"));
  assert.equal(tree.get("actions/templates/README.md"), uses("1.0.0"));
  assert.equal(logs.length, 3);
});

test("前の版で始まる別の版の印は書き換えない", async () => {
  await explains("actions の版を上げる `updateProjectVersion` のテストです。`v1.0.1` から上げるときに、前の版で始まる別の版（`v1.0.10`）の印を書き換えないことを確認します。");
  const text = "uses: pecotcraft/pecot/actions/auto-gate@pecot-actions/v1.0.10\n";
  const tree = makeTree({
    [MANIFEST]: '{"name":"@pecot/actions","version":"1.0.1"}\n',
    [TEMPLATE]: text,
  });
  await makeActions().updateProjectVersion(tree, "1.0.2");
  assert.equal(tree.get(TEMPLATE), text);
});
