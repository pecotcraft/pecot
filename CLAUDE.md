敬語を使ってください。

## リポジトリ構成

Claude Code / GitHub Copilot CLI 向けプラグインの monorepo（nx workspace）。1 ディレクトリ = 1 nx project。

| ディレクトリ | 役割 | nx project | test レーン（target） |
|---|---|---|---|
| `plugins/pecot-workflow` | Issue/PR/リリース運用のワークフロー管理 | `pecot-workflow` | `test-py` / `test-cli` / `test-hooks` / `test-skills` |
| `plugins/pecot-visual` | ビジュアル系スキル（Slidev / draw.io） | `pecot-visual` | `test-cli` / `test-bootstrap` / `test-slidev` / `test-hooks` / `test-compare` / `test-release` / `test-skills` |
| `plugins/pecot-tools` | 許可リストで限定した awscli コマンドの MCP サーバ | `pecot-tools` | `test-cli` / `test-bootstrap` / `test-release` |
| `libs/text-rules` | テキスト規則ライブラリ（pecot-visual への同梱と root フックが使う） | `text-rules` | `test-unit` |
| `libs/interface-spec` | インタフェース定義書の形式と検証。配布しない | `interface-spec` | `test-unit` |
| `.githooks` | root 共通の hook とそのテスト | `githooks` | `test-nx-cache` / `test-nx-affected` / `test-ci` / `test-checks` |

- `test` target は全量実行（`nx run-many -t test`）の起点で、入力を持たない。`nx affected -t test` は 0 件で成功するので、チェックはレーン名を列挙して `nx affected` で要求する
- lint は pecot-visual・pecot-workflow が `lint-*` のレーン、interface-spec が `lint`・`lint-defs`、ほかは `lint` 1 つ

## プラグイン製品としての前提

- 成果物は配布物（各 `SKILL.md`・`plugins/pecot-workflow/cli/templates/`・CLI 検証）。利用環境のエージェントの挙動はこれだけで決まる
- Issue / PR 本文・コメントの品質問題は製品欠陥として配布成果物で直す。エージェントメモリ・心がけ・ローカル設定で直さない
- Issue / PR / コメント本文は aist-roadmap#119 を唯一の基準とする。GitHub が UI で出す情報（Files changed・sub-issue・Development 欄）は書かず、読者の判断に使う情報だけ残す

## テスト・lint

- 検証は PR ごとの CI（`ci.yml`）が担う。必須チェックは `ci-result` と `version-plan`
- 手元では、変更箇所に絞ったテストと CI の失敗の再現だけを動かす。push 前にレーンの全量を動かさない
  - 絞り方は、vitest / pytest はファイル・ケース、`*.test.sh` は 1 本
- CI の失敗の再現は ci-repro スキルに従う
- 手元の検証は pre-commit（lint は `nx-affected-lint`）と commit-msg が行う。仕組みと手で打つコマンドは `.githooks/README.md`

## 作業ファイルの置き場所

- 一時ファイル・evidence・スクラッチは `.pecot/work/<Issue番号>/` に置く。直下のディレクトリ名は Issue 番号の数字だけ。Issue の無い作業は先に起票する
- `/tmp/` 直下は使わない（ユーザーの指定と、`find /tmp` などの調査は除く）。`.pecot/tmp/` は CLI / hooks 専用
- 各 worktree の `.pecot/work` は base へのシンボリックリンク。base の絶対パスを `.claude/settings.json` の `additionalDirectories` に置いている

## リリース

- `main` の trunk-based。`gh workflow run release.yml --ref main` で起動し、手元で `nx release` を打たない
- Environment `release` の承認はユーザーが GitHub の画面で行う。エージェントは承認しない
- 手順とやり直しは w-release スキル

## 環境の既知事項

- `base/pecot` だけに `.pnpm-store/`（約 1.6 GB）ができるのは正常（bind mount で filesystem が分かれるため。gitignore 済み）
- 起動されたディレクトリの外の worktree を操作しない。base で起動されたら base でブランチ作業し、終わったら main に戻す
