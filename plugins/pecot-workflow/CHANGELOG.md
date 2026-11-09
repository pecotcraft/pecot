## 3.1.0 (2026-11-09)

### 🚀 Features

- Playwright の MCP サーバが、pnpm を宣言したリポジトリで起動しない問題を直した。 ([#140](https://github.com/pecotcraft/pecot/pull/140), [#139](https://github.com/pecotcraft/pecot/issues/139))
  GitHub Copilot CLI では、どのリポジトリでも起動しなかった。
  pecot-workflow にも、同じ Playwright の MCP サーバ `pecot-workflow-playwright` を登録した。

- pecot security sync は、security alert を 1 件ずつ Issue にせず、Tracker 1 件の一覧を alert の今の状態で書き直す。 ([#108](https://github.com/pecotcraft/pecot/pull/108), [#105](https://github.com/pecotcraft/pecot/issues/105))
  Issue の種類に tracker を足し、月 1 回の見直しの Issue を作る security review-exceptions をやめる。

- 計画の自動投稿をやめ、w-active / w-quick が確認の前に Issue へ投稿する形にした。 ([#109](https://github.com/pecotcraft/pecot/pull/109), [#106](https://github.com/pecotcraft/pecot/issues/106))
  `pecot issue comment` は投稿したコメントの URL を書き戻し、次からはそのコメントを書き換える。
  プランモードの前後のリマインダーは、ExitPlanMode の後の案内だけにした。

- `.pecot/.gitignore` を利用リポで追跡する許可の一覧にし、hook が動く前でも生成物を管理外にする。 ([#127](https://github.com/pecotcraft/pecot/pull/127), [#122](https://github.com/pecotcraft/pecot/issues/122))
  session-start の案内の設定キーは `gitignore-track-notice` に変わる。

- pecot security sync が、main の security alert をボードの Issue にし、閉じた alert の Issue を閉じる。 ([#100](https://github.com/pecotcraft/pecot/pull/100), [#84](https://github.com/pecotcraft/pecot/issues/84))
  review-exceptions が例外の見直しの Issue を作り、preflight は 3 種の open の alert で止まる。


### 🩹 Fixes

- w-release の nx の手順で、**`versionPlans` をオブジェクトで書いたリポ**も同じ扱いになることを書く。 ([#149](https://github.com/pecotcraft/pecot/pull/149), [#143](https://github.com/pecotcraft/pecot/issues/143))
- `pecot issue comment <ファイル>` が、PR へのコメントも同じファイルで書き換えられるようにした。 ([#148](https://github.com/pecotcraft/pecot/pull/148), [#146](https://github.com/pecotcraft/pecot/issues/146))
  書き戻した `comment_url` が `/pull/<番号>#issuecomment-<id>` の形のときに、`comment_url の形が違います` で止まっていた。
  `comment_url` のホストが設定のホストと違えば、書き換えずに止まる。

- テストの target の説明文を、CI がテストを動かす前提に直した。動きは変わらない。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- security alert の Tracker の題を `[Tracker] security alert — <立てた日>` にする。 ([#114](https://github.com/pecotcraft/pecot/pull/114), [#111](https://github.com/pecotcraft/pecot/issues/111))
  本文は、判断の要る open の alert を種類ごとの見出しと表に分けた一覧だけにし、直った alert の行は消す。
  例外の見直しの条件は Tracker に出さず、`pecot release preflight` が表示する。

- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- hook のスクリプトの置き場を変えた参照を直した。 ([#107](https://github.com/pecotcraft/pecot/pull/107), [#64](https://github.com/pecotcraft/pecot/issues/64))
- hosts.json の無い checkout でも、github.com のトークンを環境変数 `PECOT_GITHUB_COM_TOKEN` から読むようにした ([#104](https://github.com/pecotcraft/pecot/pull/104), [#84](https://github.com/pecotcraft/pecot/issues/84))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))
- ホスト名や URL を部分一致で調べていたテストの assert を、期待する値全体の比較に改めた。利用者から見える振る舞いは変わらない。 ([#73](https://github.com/pecotcraft/pecot/pull/73), [#58](https://github.com/pecotcraft/pecot/issues/58))
- pecot pr merge が、既に消えた head ブランチを削除済みとして扱い、wip ブランチも消すようにした。 ([#76](https://github.com/pecotcraft/pecot/pull/76), [#72](https://github.com/pecotcraft/pecot/issues/72))
- pecot pr merge が、Closes の自動クローズと重なった Issue を既にクローズ済みとして扱う。ほかの失敗では、GitHub が返した理由を警告に添える。 ([#79](https://github.com/pecotcraft/pecot/pull/79), [#78](https://github.com/pecotcraft/pecot/issues/78))
- w-release の手順書の例のリポ名を pecot にした。 ([05e4403](https://github.com/pecotcraft/pecot/commit/05e4403))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 3.0.0 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
