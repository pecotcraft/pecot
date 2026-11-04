"use strict";

/**
 * package.json を manifest とする project 用の VersionActions。
 *
 * libs/ 配下のライブラリ（現在は text-rules）は、実体の package.json（libs/<name>/）の version を bump する。
 * project.json の `manifestRootsToUpdate` に `{projectRoot}` を列挙する。
 * 親クラスの init() が `validManifestFilenames=["package.json"]` を first-match で展開する。
 * 既定の versionActions（@nx/js）は root に入っていないため、PecotVersionActions を継承して使う。
 *
 * 回帰テスト: `.nx/nx-release/tests/version-actions.test.js`。
 */

const { PecotVersionActions } = require("./version-actions");

class PecotPackageVersionActions extends PecotVersionActions {
  constructor(...args) {
    super(...args);
    this.validManifestFilenames = ["package.json"];
  }
}

module.exports = PecotPackageVersionActions;
module.exports.default = PecotPackageVersionActions;
module.exports.PecotPackageVersionActions = PecotPackageVersionActions;
