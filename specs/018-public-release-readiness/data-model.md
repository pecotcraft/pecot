# Data Model: AIST から名前を変えて公開し、MCP の単体配布を npm に移す

## 名前の対応表

利用者に見える名前（spec の FR-003）の、今の名前と新しい名前の 1 対 1 の対応。SC-002 の判定に使う。

| 種類 | 今 | 新しい名前 | 定義している場所 |
|---|---|---|---|
| GitHub の Organization | `aistcraft` | `pecotcraft` | GitHub の設定（R2） |
| ボード | `AIST-project` | `pecot-project` | GitHub Projects の設定（2026-11-03 に変更済み） |
| 公開するリポ | `aistcraft/aist-plugin` | `pecotcraft/pecot` | 新しく作る（R3） |
| 改名して残すリポ | `aistcraft/aist-plugin` | `pecotcraft/aist-plugin-private` | GitHub の設定 |
| marketplace | `aistcraft` | `pecot` | `.claude-plugin/marketplace.json` |
| プラグイン | `aist-w`・`aist-v`・`aist-t` | `pecot-w`・`pecot-v`・`pecot-t` | 各プラグインの `.claude-plugin/plugin.json` |
| plugin.json の author | `aistcraft` | `pecot` | 同上 |
| ワークフローのスキル | `a-*`（15 本） | `w-*` | `plugins/aist-workflow/skills/*/SKILL.md` の `name:` |
| ワークフローの agents | `a-e2e-planner` など 3 本 | `w-e2e-planner` など | `plugins/aist-workflow/agents/*.md` |
| visual のスキルと agents | `v-*` | 変えない | — |
| CLI | `aist`・`aistv`・`aist-tools` | `pecot`・`pecotv`・`pecot-tools` | 各プラグインの `bin/`、`plugins/aist-workflow/cli/pyproject.toml` |
| MCP サーバ | `aist-visual`・`aist-visual-playwright`・`aist-tools` | `pecot-visual`・`pecot-visual-playwright`・`pecot-tools` | 各プラグインの `.mcp.json`・`mcp.json` |
| npm のパッケージ | 配布リポ `aist-visual-mcp`・`aist-tools-mcp` | `@pecot/visual-mcp`・`@pecot/tools-mcp` | `finalize-dist.mjs` の `buildDistManifest` |
| npm の bin | `aist-visual-mcp`・`aist-tools-mcp` | `pecot-visual-mcp`・`pecot-tools-mcp` | 同上 |
| 設定のディレクトリ | `.aist/`・`.aistv/` | `.pecot/`・`.pecotv/` | `cli/core/paths.py`、`cli-node/src/infra/paths.ts`、各 hooks |
| データの置き場 | `~/.local/share/aist/` | `~/.local/share/pecot/` | 3 つの `bin/_lib.sh` |
| 利用者が設定する環境変数 | `AIST_GITHUB_<HOST>_TOKEN`・`AISTV_AUTO_INSTALL_BROWSER`・`AISTV_WSL_MOUNT_ROOT` | `PECOT_GITHUB_<HOST>_TOKEN`・`PECOTV_AUTO_INSTALL_BROWSER`・`PECOTV_WSL_MOUNT_ROOT` | `cli/core/github/auth.py`、`cli-node/src/infra/github/auth.ts`、aist-visual の README |
| ボードのフィールドの接頭辞 | `aist-workflow-` | `pecot-workflow-` | `cli/core/config.py`、`cli/commands/project.py`、`cli-node/src/domain/config.ts` |
| タグの接頭辞 | `aist-workflow-v`・`aist-visual-v`・`aist-tools-v` | `pecot-workflow-v`・`pecot-visual-v`・`pecot-tools-v` | `nx.json` の `releaseTagPattern` |
| ログの接頭辞 | `[aistv bootstrap]`・`[aist-tools bootstrap]` | `[pecotv bootstrap]`・`[pecot-tools bootstrap]` | 各 `bin/_lib.sh` |
| 文書の製品名 | `aist-plugin`・`aist-workflow plugin` など | `pecot`・`pecot-workflow plugin` など | README 群、`SECURITY.md`、`mcp-dist-README.md` |

FR-005 により、内部の名前も新しい名前にする。表に無い名前は、`aist`→`pecot`・`Aist`→`Pecot`・`AIST`→`PECOT` の置換で決まる。
次の名前は、リポの外に実体があるので変えない。

- リポの名前 `aist-roadmap`・`aist-plugin` と、配布リポ `aist-visual-mcp`・`aist-tools-mcp`（配布リポは FR-009 で削除する）
- ほかのリポのブランチ `develop-aist` と、ファイル `AIST-CHANGELOG.md`
- spec のディレクトリ名（`specs/011-aistv-mcp-server` など）
- `text-rules` のタグ（`text-rules-v*`。製品名を含まない）

GitHub Copilot CLI 向けの構成は、本 spec では変えない。`.github/plugin/` と Agent Plugins 1.0 のマニフェストが該当し、Epic aistcraft/aist-roadmap#10 で扱う。
導入先のパスは marketplace 名・プラグイン名・CLI 名から決まるので、新しい名前に従う。

## 例外の一覧

公開するリポの既定ブランチと npm の配布物に、点検の語（FR-013）を含んだまま残すファイルと理由。SC-008 の判定に使う。

| 項目 | 内容 |
|---|---|
| パス | ファイルか glob |
| 一致した語 | 点検の語のどれか |
| 理由 | 1 行 |

規則:

- CHANGELOG は先頭の見出しと 1 文だけにするため、例外に載せない（FR-019）
- リポの外に実体がある名前に含まれる `aist` は、点検の語に入れない。点検の語は FR-013 の 5 つ
- 理由の無い一致は消す

## 秘密情報のスキャンの結果

| 項目 | 内容 |
|---|---|
| スキャナと版 | gitleaks v8.30.1 |
| 対象 | 1 commit にまとめる前の作業ツリー（commit の SHA を記録する） |
| 検出 | ファイル・行・規則の名前 |
| 決定 | 消す・秘密ではない |
| 理由 | 「秘密ではない」の場合の 1 行（例: テストの偽のトークン） |

## 第三者の素材の一覧

| 素材 | ライセンス | 表記の置き場所 | npm の配布物に入るか |
|---|---|---|---|
| `plugins/pecot-visual/assets/drawio-icons/`（Lucide） | ISC | 同じディレクトリの `LICENSE` | 入る。同じディレクトリの `LICENSE` も入る（#35 の dry-run の配布ツリーで確かめた） |
| テストの書体（Inter・Noto Sans JP） | OFL 1.1 | `cli/tests/fixtures/themes/with-declaration/public/fonts/*-OFL.txt` | 入らない（テストだけ） |

## 公開後の設定

| 設定 | 期待する状態 | 確かめ方 |
|---|---|---|
| Dependabot alerts | 有効 | `gh api repos/pecotcraft/pecot/vulnerability-alerts` が 204 |
| Private vulnerability reporting | 有効 | `gh api repos/pecotcraft/pecot/private-vulnerability-reporting` の `enabled` が true |
| secret scanning | 有効 | `gh api repos/pecotcraft/pecot` の `security_and_analysis.secret_scanning.status` が `enabled` |
| push protection | 有効 | 同じく `secret_scanning_push_protection.status` が `enabled` |
| main の ruleset | 削除と force push を禁止 | `gh api repos/pecotcraft/pecot/rulesets` に `deletion` と `non_fast_forward` の規則がある |

## 状態の移り変わり

```text
#14 完了
  → 名前の取得（GitHub の Organization を改名、npm の Organization を作る）
  → aist-plugin（private）の中で改名と点検を終える
  → 初回の npm の publish（手元から、2FA つき）→ trusted publisher を設定
  → 配布リポ 2 つを削除
  → aist-plugin を aist-plugin-private に改名 → pecotcraft/pecot を 1 commit で作る → タグを付ける
  → Issue の起票し直し、ボードへの登録、開発環境の clone し直し
  → public にする → 公開後の設定 → ワークフローで 1 回リリースを通す
```
