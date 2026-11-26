---
paths:
  - "**/*.test.ts"
  - ".nx/nx-release/tests/*.test.mjs"
---

# テストの規約

テストを、振る舞いの資料として読める形にそろえます。題の形と、定義書の振る舞いの項目へのつなぎ方を決めます。

## 対象

| テスト | 題の形 | 項目へのつなぎ |
|---|---|---|
| コマンド・ツールの公開面を確かめる vitest | 規約に従う。lint が止める | 振る舞いの項目を確かめるテストは、ID を書く |
| ドメイン層などの単体の vitest | 規約に従う。lint が止める | 求めない |

新しく作る公開面のテストのファイルは、各 project の `tests/interface/` に置きます。
今の公開面のテストは、観点ごとのファイルで全ツールを回す作りのまま残し、この置き場に入れません。

ESLint の `RuleTester` のケースは、`name` が題になります。`name` も `it` の題と同じ形にします。lint は `name` を見ません。

## 題の形（vitest）

| 決め | 例 |
|---|---|
| 新しく作る公開面のテストのファイルでは、いちばん外の `describe` の題を、コマンド・ツールの名前にする | `describe('aws_s3_ls', …)`、`describe('issue create', …)` |
| `it` の題は、「どのとき、どうするか」の日本語の 1 文にする。主語（コマンド・ツールの名前）は書かない。文の形は、振る舞いの項目と同じ EARS の型に寄せる | `it('バケット名に大文字があると、入力エラーを返す', …)` |
| `it` の題は句点で終えない。「正しく動く」「正常に処理する」のように、結果を言わない題にしない | — |
| 表を回すテストの題は、行ごとに読める文になる。行がオブジェクトなら `$name` のようにキーで、配列なら `%s` で値を埋める。空文字が入りうる値は `%j` で埋める | `it.for(rows)('$name を渡すと、$expected を返す', …)` |

`$name` の直後は、空白・`、`・括弧にします。vitest はひらがなや漢字、`・`、`ー`、`$` もキーの一部と読みます。そのため `'$nameのとき'` はキーが `nameのとき` になり、題が `undefined` になります。
`.` を直後に置くと、深い所を指す記法と読まれ、同じく `undefined` になります。lint の `test-title/table-key` がこれを止めます。

行のキーは、ASCII の英数字と `_` の識別子にします。日本語のキーは、`$nameのとき` と見分けられないので使いません。

1 つのファイルの中で、同じ題のケースを作りません。題が重なるのは、行の値が同じときと、vitest が `$キー` の値を 40 字で切って同じになったときです。重なりは、テストの実行で止まります（「題の重なりを止める」の節）。

配列の行は、`$0`・`$1` でも位置を指せます。`it.for` でオブジェクトの行に `%s` を使うと、オブジェクト全体が出ます。

`describe` の題は、ほかのファイルでは関数名のままでかまいません。

## lint が止めるもの

`@vitest/eslint-plugin` の `vitest/valid-title` に、`it` と `test` の題の形を渡しています。

| 止めるもの | 出る文言 |
|---|---|
| `it`・`test` の題に、ひらがな・カタカナ・漢字が無い | `題に日本語が無い` |
| `it`・`test` の題が全角の句点（`。`）で終わる | `題が句点で終わる` |
| `tests/interface/**` のいちばん外の `describe` の題が、定義書の `name` に無い | `describe の題 '…' が定義書の name に無い` |
| `tests/interface/**` のいちばん外の `describe` の題が、文字列のリテラルでない | `describe の題が文字列のリテラルでない` |
| `.each`・`.for` の題の `$` の後ろが、キーとして読めない（ASCII の識別子か数字を `.` でつないだ形でない） | `題の $'…' がキーとして読めない` |

日本語が無く、しかも句点で終わる題では、句点の文言だけが出ます。

`it.each`・`it.for`・`it.skipIf(...)` のような修飾つきの呼び出しも止めます。
`${}` を含むテンプレートリテラルの題と、文字列の連結（`'a' + x`）の題は、値が決まらないので止めません。
変数や関数呼び出しの題は、規約の文言ではなく `Test title must be a string` で止まります。

設定は次の 8 つに、同じ形で書いています。変えるときは 8 つとも変えます。

- `plugins/pecot-tools/cli/eslint.config.js`
- `plugins/pecot-visual/cli/eslint.config.js`
- `plugins/pecot-visual/assets/slidev/eslint.config.js`
- `plugins/pecot-workflow/cli/eslint.config.js`
- `libs/text-rules/eslint.config.js`
- `libs/workflow-core/eslint.config.js`
- `libs/interface-spec/eslint.config.js`
- `.nx/nx-release/eslint.config.mjs`

`describe` の題の 2 行は、`tests/interface/**` にだけ当てます。規則は `libs/interface-spec/src/eslint/describe-title.ts` にあります。
上の設定のうち、interface-spec を除く 7 つが、`describeTitleConfig` で読み込んでいます。
入れ子の `describe` と関数の中の `describe`、`describe` が無いファイルは止めません。`${}` の無いテンプレートリテラルは題として読みます。
`libs/text-rules`・`libs/workflow-core`・slidev・nx-release は定義書を持たず、`definitions` が空です。`tests/interface/` に `describe` を足すと、どの題も止まります。

`$` のキーの行は、8 つの設定が `tableKeyConfig` で読み込みます。規則は `libs/interface-spec/src/eslint/table-key.ts` にあります。
見るのは、根が `it`・`test`・`describe`・`suite` の `.each(…)(題)` と `.for(…)(題)` です。入れ子の `describe` と関数の中も見ます。題は、文字列のリテラルと `${}` の無いテンプレートリテラルだけ読みます。
行にキーが無いことは見ません。行が変数や関数の結果のことが多いためです。

## 題の重なりを止める

vitest の setupFiles の `libs/interface-spec/src/vitest/unique-titles.ts` が、ファイルごとにケースの名前を比べます。
名前は、`describe` から `it` までの題を ` > ` でつないだもので、JUnit の name と同じ形です。

| 起きること | 出る文言 |
|---|---|
| 同じ名前が 2 回以上ある。ファイルが失敗になり、そのファイルのケースは skip として並ぶ | `同じ題のテストが重なる` と、重なった名前 |

別の `describe` の中にある同じ題は、名前が違うので重なりとしません。
setupFiles は、7 つの `vitest.config.ts` と `.nx/nx-release/vitest.config.mjs` に書いています。pecot-workflow は、インラインの 3 つの project それぞれに書いています。
pecot-tools・pecot-visual の `vitest.e2e.config.ts` にも書いています。vitest の設定を足すときは、これも足します。

## 項目へのつなぎ

vitest は、テストの本体の最初で `verifies` を呼びます。ID は文字列のリテラルで書きます。テストは、各 project の `tests/_helpers/verifies.ts` から `verifies` を import します。project は pecot-tools・pecot-visual の `cli/` と、pecot-workflow の `cli/` です。
本体は `libs/interface-spec/src/vitest/verifies.ts` にあります。annotation を残し、nx のレーンの中では、Allure の `tms` のリンクと `tag` も残します。

```ts
it('バケット名に大文字があると、awscli を呼ばずに入力エラーを返す', async (ctx) => {
  await verifies(ctx, 'PT-AWS-S3-LS-03')
  // ...
})
```

表を回すテストは `it.for` を使い、行に ID を持たせます。`it.each` では `annotate` を使えません。

```ts
it.for([
  { name: 'region が数値', input: { region: 1 }, id: 'PT-COMMON-02' },
])('$name を拒否する', async (row, ctx) => {
  await verifies(ctx, row.id)
})
```

| 決め | 内容 |
|---|---|
| 1 件のテストから複数の項目へ | `verifies` を項目ごとに呼ぶ |
| 1 つの項目に複数のテスト | よい。項目につながるテストは 1 件以上あればよい |
| ID の書き方 | 文字列のリテラルだけ。変数で組み立てない。つなぎの確認が、テストのファイルの文字列から ID を集めるためだ |
| 全ツールに共通の振る舞い | 共通の振る舞いの項目（`<接頭辞>-COMMON-NN`）につなぐ。ツールの数だけ項目を作らない |
| どの項目も確かめないテスト | つながなくてよい。振る舞いの一覧には出ない |

## step

テストの本体を、名前の付いた Allure の step に分けます。テストレポートで、落ちたテストがどの操作で落ちたか、通ったテストがどの手順を通ったかを読むためです。

| テスト | 書き方 |
|---|---|
| vitest（本体が async） | `await step('CLI を動かす', async () => { … })` |
| vitest（本体が同期） | `stepSync('出力を比べる', () => { … })` |
| pytest | `with allure.step("出力を比べる"):` |

`step`・`stepSync` は `libs/interface-spec/src/vitest/step.ts` にあります。nx のレーンの外では Allure を呼ばず、本体を呼ぶだけです。

| 決め | 内容 |
|---|---|
| 名前 | 「何を・どうする」の日本語にする。例:「pre-commit の check-root-entries.sh を動かす」「標準出力を比べる」「git のリポを用意する」 |
| 分け方 | 操作（準備・動かす・呼ぶ）と確かめを、分けられるなら別の step にする。1 行のテストは 1 つの step でよい |
| 確かめ | `expect`・`assert` は確かめの step の中に置く。allure-vitest が `expect()` から作る自動の step は、その下に入る |
| 名前に入れないもの | 実行ごとに変わる値（一時のパス・時刻） |
| 共通の関数 | テストが共通で呼ぶ関数は、関数の中に step を持つ。`.githooks/tests/conftest.py` の `run_script`・`git`・`git_rev_parse`・`git_repo` が返す関数がそうなっている |

pytest の fixture の準備の中で呼んだ step は、レポートの「セットアップ」に出て、テストの step に数えません。テストの本体にも step を書きます。
Allure の runtime を差し替えて確かめるテストでは、差し替えの間の step が本物の reporter に届きません。step は差し替えの外で書きます。

### step の無いテストを止める

レーンの最後で、`.githooks/scripts/test_report/step-gate.sh` が Allure の quality gate（`step-gate.mjs`）をかけます。
passed のテストのうち、名前の付いた step を 1 つも持たないものがあれば、レーンが落ちます。

| 起きること | 出る文言 |
|---|---|
| 名前の付いた step を持たない passed のテストがある | `名前の付いた step を持たない passed のテストが N 件あります` と、テストの完全な名前（parametrize の行は値を添える） |

- 数えるのは、名前が `expect(` で始まらない step で、入れ子の中も数える。添付は数えない
- 落ちたテストと skip は見ない。最初の step の前で止まることがあり、欠けと見分けられないため
- gate を置いたレーンは、githooks の 4 本（`run.sh`）、`text-rules:test-unit`、`interface-spec:test-unit`・`test-site`。ほかのレーンは、テストに step を書き終えたら、コマンドの最後に gate を足す

## テストから bash を呼ぶ

`bash -c` に値を渡しません。スクリプトの文字列に埋め込むことも、`-c` の後ろの位置引数に並べることもしません。

- 手順はファイルに書き、`bash <ファイル> <引数…>` で起動する
- hooks のテストは `tests/hooks/_helpers/run.ts` の `runShell` を使う
- ライブラリの関数は、各 project の `call-bash-function.sh` で呼ぶ
- コマンドの場所は、bash の `command -v` でなく、Node で `PATH` を探して求める

CodeQL は、`-c` を持つ引数の配列の全要素を、シェルが解釈する文字列とみなします。位置引数に置いた安全な値でも、パスなら alert になり、`code_scanning` のルールでマージが止まります。

## 従う考え方

項目へのつなぎは、要件とテストの双方向の追跡と網羅の考え方に従います。

| 考え方 | このリポでの形 |
|---|---|
| 要件から確かめる手段へたどれる | テストが、振る舞いの項目の ID を名指しする |
| 確かめる手段の無い要件を残さない | テストの無い項目を、つなぎの確認が止める |
| 要件に無いものを指す手段を残さない | 定義書に無い ID を、つなぎの確認が止める |
| 結果から要件へたどれる | テストレポートが、項目の ID ごとにつないだテストと合否を並べる。定義書のサイトの機能要件の表から、その ID の絞り込みへつながる |

つなぎの確認は ID の有無だけを見ます。テストが項目の中身を確かめていることは、レビューで見ます。
