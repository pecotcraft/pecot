// @ts-check
"use strict";

/**
 * pecot monorepo 専用 VersionActions 実装。
 *
 * 配布チャネルごとの plugin.json の version を同期更新する。
 *   - Claude Code: `.claude-plugin/plugin.json`（全プラグイン）。
 *   - Copilot CLI: pecot-workflow は `.github/plugin/plugin.json`。
 *     pecot-visual / pecot-tools は、Agent Plugins 1.0 形式のルートの `plugin.json`。
 *     `plugin.json` は `$schema` 付き。
 *     Copilot はこの形式では `.github/plugin/plugin.json` を読まない。
 *
 * pyproject.toml / uv.lock の bump は不要 — `cli/__init__.py` が
 * CLAUDE_PLUGIN_ROOT から plugin.json を直接読む。
 * そのため Python 側の version は 0.0.0 で pin できる。
 *
 * project.json で `manifestRootsToUpdate` に plugin.json を持つ root を列挙する。
 * 親クラスの init() が各 root で `validManifestFilenames=["plugin.json"]` を first-match で展開する。
 * この流れは標準の処理に乗る。
 *
 * 回帰テスト: `.nx/nx-release/tests/version-actions.test.js`。
 * 実際の 3 プラグインの project.json から init() を通して、manifest の展開と読み書きを単体で確かめる。
 */

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
    return logs;
  }

  async updateProjectDependencies() {
    return [];
  }
}

module.exports = { PecotVersionActions, default: PecotVersionActions };
