// @ts-check
"use strict";

/**
 * actions/ の VersionActions。package.json の version を上げ、雛形が指す `@pecot-actions/v<版>` を新しい版に書き換える。
 * 雛形は正（actions/templates/）と、プラグインが配る写し（plugins/pecot-workflow/cli/templates/workflow/）の 2 か所にある。
 *
 * 回帰テスト: `.nx/nx-release/tests/actions-version-actions.test.mjs`。
 */

const { PecotPackageVersionActions } = require("./package-version-actions");

/** @typedef {import("nx/src/generators/tree").Tree} Tree */

const TEMPLATE_DIRECTORIES = ["actions/templates", "plugins/pecot-workflow/cli/templates/workflow"];

/**
 * @param {string} version
 * @returns {string}
 */
function escapeVersion(version) {
  return version.replaceAll(".", "\\.");
}

/**
 * 雛形の版の印を from から to に書き換え、ログの行を返す。
 * @param {Tree} tree
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
function rewriteTemplates(tree, from, to) {
  const pattern = new RegExp(`@pecot-actions/v${escapeVersion(from)}(?![0-9A-Za-z.-])`, "g");
  const logs = [];
  for (const directory of TEMPLATE_DIRECTORIES) {
    if (!tree.exists(directory)) continue;
    for (const name of tree.children(directory).filter((child) => child.endsWith(".yml")).sort()) {
      const file = `${directory}/${name}`;
      const original = tree.read(file)?.toString() ?? "";
      const updated = original.replace(pattern, `@pecot-actions/v${to}`);
      if (updated === original) continue;
      tree.write(file, updated);
      logs.push(`Updated ${file} to @pecot-actions/v${to}`);
    }
  }
  return logs;
}

class PecotActionsVersionActions extends PecotPackageVersionActions {
  /**
   * @param {Tree} tree
   * @param {string} newVersion
   */
  async updateProjectVersion(tree, newVersion) {
    const { currentVersion } = await this.readCurrentVersionFromSourceManifest(tree);
    const logs = await super.updateProjectVersion(tree, newVersion);
    return [...logs, ...rewriteTemplates(tree, currentVersion, newVersion)];
  }
}

module.exports = { PecotActionsVersionActions, rewriteTemplates, default: PecotActionsVersionActions };
