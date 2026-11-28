// @ts-check
"use strict";

/**
 * pecot monorepo 専用 VersionActions 実装。
 *
 * 配布チャネルごとの plugin.json の version を同期更新する。
 *   - Claude Code: `.claude-plugin/plugin.json`（全プラグイン）。
 *   - Copilot CLI: 3 プラグインとも、Agent Plugins 1.0 形式のルートの `plugin.json`（`$schema` 付き）。
 *     Copilot はこの形式では `.github/plugin/plugin.json` を読まない。
 *
 * Node の CLI は自分の配布物の plugin.json から版を読むので、package.json の version は bump しない。
 * project の直下の `.mcp.json`・`mcp.json` が npx で起動する `@pecot/<名前>-mcp@<版>` も、同じ版に書き換える。
 *
 * project.json で `manifestRootsToUpdate` に plugin.json を持つ root を列挙する。
 * 親クラスの init() が各 root で `validManifestFilenames=["plugin.json"]` を first-match で展開する。
 * この流れは標準の処理に乗る。
 *
 * release の依存には、`implicitDependencies` の辺も数える（`readDependencies`）。
 *
 * 回帰テスト: `.nx/nx-release/tests/version-actions.test.mjs`。
 * 実際の 3 プラグインの project.json から init() を通して、manifest の展開と読み書きを単体で確かめる。
 */

const path = require("node:path");
const { VersionActions } = require("nx/src/command-line/release/version/version-actions");

/** @typedef {import("nx/src/generators/tree").Tree} Tree */

class PecotVersionActions extends VersionActions {
  /** @param {ConstructorParameters<typeof VersionActions>} args */
  constructor(...args) {
    super(...args);
    this.validManifestFilenames = ["plugin.json"];
  }

  /** @param {Tree} tree */
  async readCurrentVersionFromSourceManifest(tree) {
    const [first] = this.manifestsToUpdate;
    if (!first) {
      throw new Error(
        `[pecot-nx-release] project "${this.projectGraphNode.name}" の manifestsToUpdate が空`,
      );
    }
    const raw = tree.read(first.manifestPath);
    if (!raw) {
      throw new Error(
        `[pecot-nx-release] manifest を読めません: ${first.manifestPath} ` +
          `(project: ${this.projectGraphNode.name})`,
      );
    }
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (e) {
      throw new Error(
        `[pecot-nx-release] JSON parse 失敗: ${first.manifestPath}: ${/** @type {Error} */ (e).message}`,
        { cause: e },
      );
    }
    if (typeof data.version !== 'string' || data.version === '') {
      throw new Error(
        `[pecot-nx-release] ${first.manifestPath} の version フィールドが文字列でないまたは空`,
      );
    }
    return { currentVersion: data.version, manifestPath: first.manifestPath };
  }

  /** @returns {Promise<never>} */
  async readCurrentVersionFromRegistry() {
    // currentVersionResolver: "disk" 固定。registry の処理に入ったら誤設定として明示 throw。
    throw new Error(
      "[pecot-nx-release] currentVersionResolverMetadata: registry は未サポート。" +
        "nx.json で currentVersionResolver: 'disk' を使用してください。",
    );
  }

  async readCurrentVersionOfDependency() {
    return { currentVersion: null, dependencyCollection: null };
  }

  /**
   * @param {Tree} tree
   * @param {string} newVersion
   */
  async updateProjectVersion(tree, newVersion) {
    const logs = [];
    for (const { manifestPath } of this.manifestsToUpdate) {
      const raw = tree.read(manifestPath);
      if (!raw) {
        throw new Error(
          `[pecot-nx-release] manifest を読めません: ${manifestPath} ` +
            `(project: ${this.projectGraphNode.name})`,
        );
      }
      const original = raw.toString();
      let data;
      try {
        data = JSON.parse(original);
      } catch (e) {
        throw new Error(
          `[pecot-nx-release] JSON parse 失敗: ${manifestPath}: ${/** @type {Error} */ (e).message}`,
          { cause: e },
        );
      }
      data.version = newVersion;
      const serialized = JSON.stringify(data, null, 2);
      // manifest の末尾改行を維持
      tree.write(manifestPath, original.endsWith("\n") ? serialized + "\n" : serialized);
      logs.push(`Updated ${manifestPath} to ${newVersion}`);
    }
    logs.push(...this.updateMcpPackageVersion(tree, newVersion));
    return logs;
  }

  /**
   * JSON を parse して書き戻さず、版の文字列だけを置き換えて整形を保つ。
   * @param {Tree} tree
   * @param {string} newVersion
   */
  updateMcpPackageVersion(tree, newVersion) {
    const { name, data } = this.projectGraphNode;
    const packageName = `@pecot/${name.replace(/^pecot-/, "")}-mcp@`;
    const pattern = new RegExp(`(${packageName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")})[^"\\s]+`, "g");
    const logs = [];
    for (const file of [".mcp.json", "mcp.json"]) {
      const filePath = path.posix.join(data.root, file);
      if (!tree.exists(filePath)) continue;
      const original = tree.read(filePath)?.toString() ?? "";
      const updated = original.replace(pattern, `$1${newVersion}`);
      if (updated === original) continue;
      tree.write(filePath, updated);
      logs.push(`Updated ${filePath} to ${newVersion}`);
    }
    return logs;
  }

  async updateProjectDependencies() {
    return [];
  }

  /**
   * nx の既定は implicit の辺を外し、`implicitDependencies` の依存先の版上げが届かない（#907）。
   * @param {Tree} _tree
   * @param {import("nx/src/config/project-graph").ProjectGraph} projectGraph
   */
  async readDependencies(_tree, projectGraph) {
    return projectGraph.dependencies[this.projectGraphNode.name] ?? [];
  }
}

module.exports = { PecotVersionActions, default: PecotVersionActions };
