import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

import { test } from "vitest";

import { explains } from "../../../libs/interface-spec/src/vitest/explains.js";

// nx の release の内部は CommonJS なので、Node の require で読む。
const require = createRequire(import.meta.url);
const { createProjectGraphAsync } = require("nx/src/project-graph/project-graph");
const { readNxJson } = require("nx/src/config/nx-json");
const { createNxReleaseConfig } = require("nx/src/command-line/release/config/config");
const { createReleaseGraph } = require("nx/src/command-line/release/utils/release-graph");
const { createProjectFileMapUsingProjectGraph } = require("nx/src/project-graph/file-map-utils");
const { FsTree } = require("nx/src/generators/tree");

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * nx.json の release の設定から、groups の並びだけを入れ替えて release の依存の表を作る。
 * @param {string[]} leading 先頭に並べる group の名前
 */
async function sortedGroups(leading) {
  const projectGraph = await createProjectGraphAsync({ exitOnError: false });
  const release = readNxJson(REPO_ROOT).release ?? {};
  const names = [...leading, ...Object.keys(release.groups).filter((name) => !leading.includes(name))];
  const groups = Object.fromEntries(names.map((name) => [name, release.groups[name]]));
  const { error, nxReleaseConfig } = await createNxReleaseConfig(
    projectGraph,
    await createProjectFileMapUsingProjectGraph(projectGraph),
    { ...release, groups },
  );
  assert.equal(error, null);
  const graph = await createReleaseGraph({
    tree: new FsTree(REPO_ROOT, false),
    projectGraph,
    nxReleaseConfig,
    filters: {},
    skipVersionResolution: true,
  });
  return { configured: Object.keys(nxReleaseConfig.groups), sorted: graph.sortedReleaseGroups };
}

/**
 * @param {string[]} sorted
 * @param {string} before
 * @param {string} after
 */
function assertBefore(sorted, before, after) {
  assert.ok(sorted.indexOf(before) < sorted.indexOf(after), `${before} が ${after} より前にない: ${sorted.join(", ")}`);
}

test.for([
  { name: "nx.json の並び", leading: [] },
  { name: "pecot-workflow・pecot-actions が先頭の並び", leading: ["pecot-workflow", "pecot-actions"] },
])("release.groups が $name のときも、implicitDependencies の依存先のグループを先に処理する", async ({ leading }) => {
  await explains("実際の project graph と `nx.json` から作る、release のグループの処理順のテストです。`release.groups` の並びに関わらず、`implicitDependencies` と static の依存先のグループが先に処理されることを確認します。");
  const { configured, sorted } = await sortedGroups(leading);
  assert.deepEqual(configured.slice(0, leading.length), leading);
  assertBefore(sorted, "workflow-core", "pecot-actions");
  assertBefore(sorted, "pecot-actions", "pecot-workflow");
  assertBefore(sorted, "text-rules", "pecot-visual");
});
