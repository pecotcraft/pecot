# Quickstart: PR ごとのテストとリリースを CI で確かめる

実装の後に、次の順で確かめる。workflow と ruleset の約束は [contracts/workflows.md](contracts/workflows.md) にある。

## 0. 準備（リポジトリの管理者が 1 回だけ行う）

| 手順 | 操作 |
|---|---|
| App を作る | Organization に GitHub App を作る。権限は [research.md](research.md) の R6 の表のとおり。pecotcraft/pecot にだけ入れる |
| 変数 | リポジトリの変数（Repository variables）`PECOT_BOT_CLIENT_ID` に App の client id を置く。job の `if` で読むため、Environment の変数では空になり、2 つの job が skipped になる |
| Environment `release` | 作る。必須レビュアーにリリース担当者を入れ、deployment branch を `main` だけにする。起動者が承認者を兼ねるなら、「Prevent self-review」は切る |
| Environment `release-plan` | 作る。承認者は置かず、deployment branch を `main` だけにする |
| 秘密を置く | 2 つの Environment の secret に、秘密鍵を `PECOT_BOT_PRIVATE_KEY` で置く。Dependabot secrets への配置は、自動マージ（Phase 7）の作業として行う |
| merge の方式 | リポジトリの設定で merge commit と rebase merge を切り、squash だけにする。merge commit では、元の commit の件名に `(#N)` が無く、リリースが止まるため |
| auto-merge | リポジトリの設定で Allow auto-merge を有効にする |
| イメージ | `devcontainer-image.yml` を手で 1 回起動し、GHCR のパッケージを public にする |
| ruleset | `gh api -X POST repos/pecotcraft/pecot/rulesets --input .github/rulesets/main.json` で適用する。bypass の App の id は適用の前に JSON に入れる |

ruleset は最後に入れる。先に入れると、ruleset を入れる PR 自身が必須チェックを待って止まる。

## 1. PR の検証（US1）

| 確かめ方 | 期待 |
|---|---|
| pecot-tools の `cli/src` だけを変えた PR を開く | `checks` の Summary に pecot-tools のレーンだけが並び、成功する |
| README だけを変えた PR を開く | Summary が「対象なし（成功）」になる |
| pecot-tools のテストを 1 件わざと落とした PR を開く | `ci-result` が失敗し、Summary に失敗したレーン名が出る |
| 同じ PR に続けて 2 回 push する | 1 回目の run が cancel になる |
| PR をマージした後と、リリースの後の `main` | `main` の push で `ci.yml` が動き、成功する |
| `.devcontainer/devcontainer.json` の版を変えた PR を開く | その PR の定義で作ったコンテナで検証が動く |

## 2. 手元のフック（US3）

```bash
time git push   # pre-push は秒単位で終わり、テストは動かない
pre-commit run --hook-stage manual nx-affected-tests --from-ref origin/main --to-ref HEAD   # 手で動かす
```

`.githooks/README.md` の役割の表と `.pre-commit-config.yaml` を照らし合わせ、表に無い hook が無いことを確かめる。
`.githooks/` の各ディレクトリの中身が、`.pre-commit-config.yaml` の stage と一致することも確かめる。
`grep -rn PECOT_BRAND_TERMS_FILE .` が specs の過去の記述にしか当たらないことも確かめる。

## 3. 自動マージ（US2）

| 確かめ方 | 期待 |
|---|---|
| dependabot の patch の PR が来るのを待つ（`@dependabot recreate` でも可） | 検証が通ると merge queue に入り、マージされる |
| dependabot の major の PR | 検証が通っても残る |
| 人の PR | 検証が通っても自動ではマージされない |

## 4. リリース（US4）

1. `pecot-tools` の実行時の依存を上げた dependabot の PR がマージされた状態で、`release.yml` を起動する
2. `plan` の Summary に、`<PR 番号>-dependabot-deps.md` の案と pecot-tools の patch の bump が出る
3. Environment の承認をすると `release` が動き、release commit・tag・Release・npm の publish がそろう
4. pecot-tools の CHANGELOG に「依存を更新した（…）。」の行がある
5. 手元から `git push origin HEAD:main` を試すと、ruleset に拒否される

## 5. 文書（US5）

CLAUDE.md の「テスト・lint の実行」「リリース」の節を読み、手元で全量を動かす指示と `base/pecot` でリリースする指示が残っていないことを確かめる。
