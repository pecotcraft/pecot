# Quickstart: 公開を確かめる手順

spec の Success Criteria を、公開の後に確かめる手順。値と形は [data-model](data-model.md) と [contracts](contracts/) に従う。

## 前提

- GitHub と npm に認証していない環境を 1 つ用意する。新しい devcontainer か、`gh auth logout` と `npm logout` を済ませたユーザー
- 所有者の環境では、`gh` が `pecotcraft` に対して認証済み

## 1. 名前（SC-001・SC-002）

```bash
gh api orgs/pecotcraft -q .login                  # pecotcraft
npm view @pecot/tools-mcp name                   # @pecot/tools-mcp
```

導入した環境で、利用者に見える名前から `aist` が消えていることを確かめる。

```bash
claude plugin list | grep -i aist                # 出力なし
ls -a ~/.local/share | grep -i aist              # 出力なし（新しい環境の場合）
```

## 2. 認証なしの導入（SC-003・SC-004・SC-005）

1. [contracts/install.md](contracts/install.md) のプラグインの導入の 4 行を、認証していない環境で実行する
2. `/pecot-w:w-help` を呼び、応答が返る
3. MCP クライアントに `@pecot/tools-mcp` と `@pecot/visual-mcp` の設定を登録し、ツールの一覧が返る

## 3. リリース（SC-006・SC-011）

1. 小さな変更で Issue を作り、ワークフローで PR をマージする
2. `npx nx release --verbose --yes` を実行する
3. ワークフロー `publish-npm.yml` が成功し、`npm view @pecot/tools-mcp version` が新しい版を返す
4. ruleset に止められた操作が無いことを、リリースのログで確かめる

## 4. 配布リポの削除（SC-007）

```bash
gh api repos/aistcraft/aist-visual-mcp 2>&1 | grep -c 'Not Found'   # 1
gh api repos/aistcraft/aist-tools-mcp 2>&1 | grep -c 'Not Found'    # 1
git -C <pecot の clone> grep -l -E 'aist-(visual|tools)-mcp'       # 出力なし
```

## 5. 中身の点検（SC-008・SC-009）

```bash
git clone https://github.com/pecotcraft/pecot.git && cd pecot
git rev-list --count HEAD                                      # 公開時点では 1
git grep -l -i -E 'github\.dxc\.com|dxc|khayakawa|zscaler|社内'  # 例外の一覧のファイルだけ
gh pr list -R pecotcraft/pecot --state all -q '.[].createdAt'   # 公開より前の PR が無い
```

npm の配布物も同じ語で確かめる。

```bash
npm pack @pecot/visual-mcp && tar -tzf pecot-visual-mcp-*.tgz | grep -i -E 'cert|\.map$'   # 出力なし
```

## 6. 公開後の設定（SC-010）

[data-model の公開後の設定](data-model.md#公開後の設定) の表の確かめ方を、上から順に実行する。

force push と削除が拒否されることは、使い捨てのブランチではなく main で `--dry-run` を付けずに試さない。ruleset の規則の一覧で確かめる。
