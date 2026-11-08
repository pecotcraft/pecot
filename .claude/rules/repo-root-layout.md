# リポジトリのルート直下に置くもの

ルート直下に置いてよいのは、次の表の名前だけです。
`.githooks/pre-commit/check-root-entries.sh` が、追跡しているファイルの先頭の名前を、この表と同じ一覧と比べて止めます。

| 名前 | 役割 |
|:---|:---|
| `.claude` | Claude Code の設定と規則（`rules/`） |
| `.claude-plugin` | プラグインの marketplace の定義 |
| `.devcontainer` | devcontainer の定義 |
| `.githooks` | root 共通の hook・lib・スクリプトとそのテスト |
| `.github` | GitHub Actions のワークフロー・Dependabot の設定 |
| `.gitignore` | git の管理外の指定 |
| `.gitlint` | commit メッセージの lint の設定 |
| `.markdownlint-cli2.jsonc` | markdownlint の設定 |
| `.npmrc` | pnpm の設定 |
| `.nx` | nx の version plan |
| `.nxignore` | nx の対象外の指定 |
| `.pecot` | pecot の設定と状態（追跡するのは `.gitignore` だけ） |
| `.pre-commit-config.yaml` | pre-commit の hook の定義 |
| `.specify` | Spec Kit の設定とテンプレート |
| `.yamllint` | yamllint の設定 |
| `CLAUDE.md` | エージェント向けのリポの規約 |
| `LICENSE` | ライセンス |
| `README.md` | リポの説明 |
| `SECURITY.md` | 脆弱性の報告の窓口 |
| `libs` | ライブラリ（`libs/<name>/`） |
| `nx.json` | nx workspace の設定 |
| `package.json` | root の package（nx project `pecot`） |
| `plugins` | 配布するプラグイン（`plugins/<name>/`） |
| `pnpm-lock.yaml` | pnpm の lock |
| `pnpm-workspace.yaml` | pnpm の workspace の定義 |
| `pyproject.toml` | root の Python の設定 |
| `setup.sh` | 開発環境のセットアップ |
| `specs` | Spec Kit の仕様 |
| `uv.lock` | uv の lock |

## 新しいものの置き場所

| 置くもの | 置き場所 |
|:---|:---|
| リポ全体で使うスクリプト（install・CI・リリース・hook の entry から呼ぶもの） | `.githooks/scripts/` |
| hook | `.githooks/<stage>/`（`pre-commit` / `commit-msg` / `pre-push`） |
| hook が共有する関数 | `.githooks/lib/` |
| root 共通のテスト | `.githooks/tests/` |
| プラグインの中身 | `plugins/<name>/` |
| ライブラリ | `libs/<name>/` |
| ワークフロー | `.github/workflows/` |
| 作業ファイル・evidence・スクラッチ | `.pecot/work/<Issue番号>/` |

## どうしてもルートに足すとき

hook の許可の一覧（`check-root-entries.sh` の `ALLOWED`）と、この表を同じ変更で直します。
一方だけ直すと、`test_check_root_entries.py` が落ちます。
