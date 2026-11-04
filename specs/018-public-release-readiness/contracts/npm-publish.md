# Contract: MCP サーバの npm への publish

research の R4 の取り決め。リリース担当者は今と同じく `npx nx release --verbose --yes` を 1 回実行し、ほかの操作をしない。

## 手元の publish フェーズ（nx の target `nx-release-publish`）

`plugins/aist-visual` と `plugins/aist-tools` の `scripts/release/publish-mcp-dist.sh` を、次のとおりに変える。

| 段階 | 今 | 変えた後 |
|---|---|---|
| 冪等性の判定 | HEAD に `aist-visual-v<ver>` が無ければ何もしない | 同じ判定を `pecot-visual-v<ver>` で行う |
| 監査と、ブランドの語の確認 | 今のまま | 今のまま |
| 配布ツリーの組み立て | 今のまま | 今のまま。package.json の `name` を `@pecot/visual-mcp`、`bin` を `pecot-visual-mcp` にする |
| 固める | なし | 配布ツリーで `npm pack` を実行し、`pecot-visual-mcp-<ver>.tgz` を作る |
| 届ける | 配布リポへ clone・commit・tag・push | `gh release upload pecot-visual-v<ver> <tgz> --clobber` のあと、`gh workflow run publish-npm.yml -f tag=pecot-visual-v<ver>` |

aist-tools も同じ形で、名前は `@pecot/tools-mcp`・`pecot-tools-mcp`・`pecot-tools-v<ver>` にする。

- GitHub Release は、nx の changelog の段階（`createRelease: "github"`）で publish の前に作られている
- 配布リポへの clone・commit・push と、`AISTV_MCP_DIST_REPO`・`AIST_TOOLS_MCP_DIST_REPO` の上書きは消す
- `--dry-run` のときは、`npm pack` までを行い、`gh release upload` と `gh workflow run` を表示だけにする

## GitHub Actions のワークフロー `.github/workflows/publish-npm.yml`

| 項目 | 取り決め |
|---|---|
| 起動 | `workflow_dispatch`。入力は `tag`（必須、`pecot-visual-v*` か `pecot-tools-v*`） |
| 権限 | `contents: read`、`id-token: write` |
| 実行環境 | `ubuntu-latest`、Node 24 系（npm 11.5.1 以上） |
| 手順 1 | `tag` から パッケージ名と版を決める。形に合わなければ失敗する |
| 手順 2 | `npm view <pkg>@<ver> version` が版を返したら、何もせずに成功で終える |
| 手順 3 | `gh release download <tag> --pattern '*.tgz'` で添付物を取る |
| 手順 4 | `npm publish <tgz> --access public --provenance` |
| 秘密 | 使わない。trusted publishing（OIDC）で認証する |
| checkout | しない。ビルドは手元で済んでいる |

## 初回だけの手順

trusted publisher は、npm にパッケージがあることを設定の条件にする。そのため初回は次の順で行う。

1. npm の Organization `pecot` を作る（2FA を有効にしたアカウントで）
2. 手元で配布ツリーを組み立て、`npm publish --access public` を 2FA つきで実行する（2 パッケージ）
3. 各パッケージの設定で trusted publisher を登録する。リポは `pecotcraft/pecot`、ワークフローは `publish-npm.yml`
4. 次のリリースから、上の手元の publish フェーズとワークフローで出す

## 失敗したときのやり直し

| 失敗した段階 | やり直し |
|---|---|
| `npm pack` まで | 今と同じく `npx nx release publish` を再実行する |
| `gh release upload` | 同上（`--clobber` で上書きする） |
| ワークフロー | `gh workflow run publish-npm.yml -f tag=<tag>` を再実行する。publish 済みの版は手順 2 で飛ばす |
