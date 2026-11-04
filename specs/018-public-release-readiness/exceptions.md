# Exceptions: 点検の語を含んだまま公開するファイル

pecotcraft/aist-plugin#35 の T026 の成果物。SC-008 の判定に使う。
点検の語は FR-013 の 5 つで、一致は大文字小文字を区別せずに数える。
記録の形と規則は data-model.md の「例外の一覧」に従う。

## 点検の条件

- 点検した commit: `ada0a3549be743d2dbaacf1da9dc51e5b5ce2bfe`（merge 前のブランチ `feat/public-content-audit/35`）
- 配布ツリー: 同じ commit で `publish-mcp-dist.sh --dry-run --out-dir=...` を 2 つのプラグインで実行して作った
- CHANGELOG は対象から外した。中身は #37 の T036 で先頭の見出しと 1 文だけにする（FR-019）
- 検索コマンド:

```bash
RE='github\.dxc\.com|dxc|khayakawa|zscaler|社内'
git grep -l -i -E "$RE" HEAD -- ':!**/CHANGELOG.md'   # 中身
git ls-files | grep -i -E "$RE"                       # パスの名前
grep -rli -E "$RE" <配布ツリー>                        # 配布ツリーの中身
find <配布ツリー> | grep -i -E "$RE"                   # 配布ツリーのパスの名前
```

## リポのファイル

| パス | 一致した語 | 理由 |
|---|---|---|
| `libs/text-rules/package-lock.json` | `dxc` | integrity の base64 の部分一致。一致した行はすべて `integrity` の行 |
| `plugins/*/pnpm-lock.yaml`（3 本） | `dxc` | 同じく integrity の base64 の部分一致。一致した行はすべて `sha512-` の値 |
| `specs/018-public-release-readiness/spec.md` | 5 つすべて | 点検の語の定義（FR-013）と、点検を始める前の状態の記録 |
| `specs/018-public-release-readiness/plan.md` | `Zscaler` | 中身の点検のフェーズの説明 |
| `specs/018-public-release-readiness/research.md` | `Zscaler` | 同梱の CA を外す決定（R6）の記録 |
| `specs/018-public-release-readiness/quickstart.md` | 5 つすべて | 点検の語の検索コマンド |
| `specs/018-public-release-readiness/exceptions.md` | 5 つすべて | このファイル。点検の語の検索コマンドと、例外の一覧 |

パスの名前の一致は 0 件。

## 配布ツリー

| 配布ツリー | パス | 一致した語 | 理由 |
|---|---|---|---|
| pecot-visual | `npm-shrinkwrap.json` | `dxc` | integrity の base64 の部分一致。一致した行はすべて `integrity` の行 |

pecot-tools の配布ツリーの一致は 0 件。2 つの配布ツリーとも、パスの名前の一致は 0 件。

## lockfile の確かめ方

lockfile をファイルごと例外にすると、同じファイルに入った本物の一致が検索に出なくなる。
そこで、一致した行から integrity の行を除くと 0 件になることを確かめた。

```bash
git grep -n -i -E "$RE" HEAD -- '*lock*' | grep -v -E 'integrity|sha512-'        # 出力なし
grep -n -i -E "$RE" <配布ツリー>/npm-shrinkwrap.json | grep -v -E 'integrity|sha512-'  # 出力なし
```

## 語の検索で拾えない記述

Issue のコメントの指示で、`.devcontainer/` を読み、ほかの組織に寄った記述が無いかを見た。
中身は、公開のベースイメージ・公開の devcontainer features・オープンな書体（Noto CJK・Inter・Carlito）・汎用のパスだけだった。
消すものは無かった。
