---
paths:
  - "**/*.test.ts"
  - ".nx/nx-release/tests/*.test.mjs"
  - "**/*.test.sh"
  - "plugins/*/cli/tests/bootstrap/*.sh"
  - "**/test_*.py"
---

# テストの規約

テストを、振る舞いの資料として読める形にそろえます。題と説明の形と、定義書の振る舞いの項目へのつなぎ方を決めます。
題と説明は、テストレポート（Allure Report）でテストを開いた人が、何を確かめて成功としたかを読むためのものです。

## 対象

| テスト | 題の形 | 項目へのつなぎ |
|---|---|---|
| コマンド・ツールの公開面を確かめる vitest | 規約に従う。lint が止める | 振る舞いの項目を確かめるテストは、ID を書く |
| ドメイン層などの単体の vitest | 規約に従う。lint が止める | 求めない |
| `.githooks/tests`・`libs/interface-spec/docs/tests` の pytest | 規約に従う。hook が止める | 求めない |

新しく作る公開面のテストのファイルは、各 project の `tests/interface/` に置きます。
今の公開面のテストは、観点ごとのファイルで全ツールを回す作りのまま残し、この置き場に入れません。

ESLint の `RuleTester` のケースは、`name` が題になります。`name` も `it` の題と同じ形にします。lint は `name` を見ません。

## 題の形（vitest）

| 決め | 例 |
|---|---|
| 新しく作る公開面のテストのファイルでは、いちばん外の `describe` の題を、コマンド・ツールの名前にする | `describe('aws_s3_ls', …)`、`describe('issue create', …)` |
| `it` の題は、「どのとき、どうするか」の日本語の 1 文にする。主語（コマンド・ツールの名前）は書かない。文の形は、振る舞いの項目と同じ EARS の型に寄せる | `it('バケット名に大文字があると、入力エラーを返す', …)` |
| `it` の題は句点で終えない。「正しく動く」「正常に処理する」のように、結果を言わない題にしない | — |
| 題だけを読んで、対象・場面・結果が分かる文にする。コードの中の名前や略した言い方に頼らない | 「ボードに無い値を名前の順に並べる」でなく「ボードに存在しない選択肢を名前順に並べ、数に応じて it と them を使い分けた警告文を作成する」 |
| 表を回すテストの題は、行ごとに読める文になる。行がオブジェクトなら `$name` のようにキーで、配列なら `%s` で値を埋める。空文字が入りうる値は `%j` で埋める | `it.for(rows)('$name を渡すと、$expected を返す', …)` |

`$name` の直後は、空白・`、`・括弧にします。vitest はひらがなや漢字、`・`、`ー`、`$` もキーの一部と読みます。そのため `'$nameのとき'` はキーが `nameのとき` になり、題が `undefined` になります。
`.` を直後に置くと、深い所を指す記法と読まれ、同じく `undefined` になります。lint の `test-title/table-key` がこれを止めます。

行のキーは、ASCII の英数字と `_` の識別子にします。日本語のキーは、`$nameのとき` と見分けられないので使いません。

1 つのファイルの中で、同じ題のケースを作りません。題が重なるのは、行の値が同じときと、vitest が `$キー` の値を 40 字で切って同じになったときです。重なりは、テストの実行で止まります（「題の重なりを止める」の節）。

配列の行は、`$0`・`$1` でも位置を指せます。`it.for` でオブジェクトの行に `%s` を使うと、オブジェクト全体が出ます。

`describe` の題は、ほかのファイルでは関数名のままでかまいません。

## 説明の書き方

テストは、何を確認するかの説明を 1 つ持ちます。説明は、Allure Report のテストの Description の欄に表示されます。

説明は、何をするテストかを短く書きます。Allure の公式の例は `This test attempts to log into the website using a login and a password.` です。

| 決め | 内容 |
|---|---|
| 形 | 1〜2 文で書く。「〜のテストです。」で対象を示し、「〜の場合に、〜することを確認します。」で成功の条件を示す。1 文で足りれば 1 文にする |
| 中身 | assert を 1 つずつ文に写さない。入力と期待値は、すべてを列挙せず、読み手が成功の条件をつかめる分だけ書く |
| 言葉 | 日本語のテスト仕様書や公式ドキュメントで使う語にする（存在しない・不足している・表示する・送信する・確認する）。「確かめる」「比べる」「足す」「足りない」のような短い和語の動詞に偏らない |
| 略語 | 題やコードの中の略した言い方を、言い換えずに使わない。題を言い直すだけの文にしない |
| 長さ | 1 文は 100 字以内、読点は 3 つまでにする。`check-text` が、テストの文字列にも同じ規則をかける |
| 書式 | です・ます調の地の文にする。説明は Markdown として描かれるので、パス・コード・記号はバッククォートで囲み、1 段落で書く |
| ID | 振る舞いの項目の ID は書かない。つなぎの確認は、ファイルの中の ID をすべて数えるため、`verifies` しない項目もつないだことになる |

次は、`missingWarning` のテストの題と説明の例です。題は次のとおりです。

> ボードに存在しない選択肢を名前順に並べ、数に応じて it と them を使い分けた警告文を作成する

説明は次のとおりです。

> ボードに存在しない選択肢（`Blocked` や `Todo` など）へ Issue を移動しようとしたときに表示する、警告文のテストです。不足している選択肢が 1 つの場合と 2 つの場合で、名前が名前順に並び、`it` と `them` が正しく使い分けられることを確認します。

### vitest

テストの本体の先頭で、`explains` に説明を渡します。`verifies` を呼ぶテストは、その直後に呼びます。
各 project の `tests/_helpers/explains.ts`（text-rules は `tests/helpers/explains.ts`）から import します。本体は `libs/interface-spec/src/vitest/explains.ts` にあり、nx のレーンの中でだけ Allure の `description` を呼びます。

```ts
it('バケット名に大文字があると、awscli を呼ばずに入力エラーを返す', async (ctx) => {
  await verifies(ctx, 'PT-AWS-S3-LS-03')
  await explains('大文字を含むバケット名を渡した場合に、awscli を起動せずに入力エラーを返すことを確認します。')
  // ...
})
```

`it.for` で行ごとに違う説明が要るときは、テンプレートリテラルで行の値を埋めます。

テストの中で Allure の runtime（`setGlobalTestRuntime`）を差し替えるときは、`explains` を差し替えの前に呼びます。差し替えた後に呼ぶと、説明がレポートに届きません。

ESLint の `RuleTester` のケースも、vitest のテストとしてレポートに載ります。
`libs/interface-spec/src/vitest/rule-tester.ts` の `useExplainedRuleTester(RuleTester)` で登録します。slidev は `vitest.setup.ts` で登録しています。valid と invalid で決まった説明と、名前の付いた step が付きます。

### pytest

題は `@allure.title` で付け、説明は docstring に書きます。allure-pytest は docstring を説明に使います。

```python
@allure.title("-o でラベルを指定すると、すべての結果に project と lane のラベルが 1 つずつ付く")
def test_ini_labels_are_added_to_every_result(tmp_path: Path) -> None:
    """pytest を `--alluredir` と `-o` を指定して実行したときに、Allure の結果ファイルに付くラベルのテストです。2 件のテストのどちらの結果にも、指定した project と lane のラベルが 1 つずつだけ付いていることを確認します。"""
```

| 決め | 内容 |
|---|---|
| 題 | vitest の `it` の題と同じ形にする |
| parametrize の題 | `{引数名}` か `{param_id}` で行の値を埋め、行ごとに違う題にする |
| docstring | 1 行目から書き始め、空行を入れない 1 段落にする。githooks の pytest は Python 3.12 で動き、docstring の字下げが残る。空行の後や改行で始まる段落は、レポートでコードブロックになる |

## lint が止めるもの

`@vitest/eslint-plugin` の `vitest/valid-title` に、`it` と `test` の題の形を渡しています。

| 止めるもの | 出る文言 |
|---|---|
| `it`・`test` の題に、ひらがな・カタカナ・漢字が無い | `題に日本語が無い` |
| `it`・`test` の題が全角の句点（`。`）で終わる | `題が句点で終わる` |
| `tests/interface/**` のいちばん外の `describe` の題が、定義書の `name` に無い | `describe の題 '…' が定義書の name に無い` |
| `tests/interface/**` のいちばん外の `describe` の題が、文字列のリテラルでない | `describe の題が文字列のリテラルでない` |
| `.each`・`.for` の題の `$` の後ろが、キーとして読めない（ASCII の識別子か数字を `.` でつないだ形でない） | `題の $'…' がキーとして読めない` |
| `it`・`test` の本体の先頭の `verifies`・`explains` の並びに、`await explains(…)` が無い | `テストの本体の先頭で await explains('…') を呼んでいない` |
| `explains` を 2 回以上呼ぶ | `explains を 2 回以上呼んでいる` |
| `explains` に、空でない文字列かテンプレートリテラルを渡していない | `explains に、空でない文字列かテンプレートリテラルを渡していない` |
| `explains` を、先頭の並びの外で呼ぶ | `explains を、本体の先頭の verifies・explains の並びの外で呼んでいる` |
| pytest の `test_*` 関数に、文字列を渡す `@allure.title` が無い（hook `check-pytest-titles`） | `文字列を渡す @allure.title（題）が無い` |
| pytest の `test_*` 関数の docstring が無い、改行で始まる、空行を含む（同上） | `docstring（説明）が無い` など |

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

`explains` の行は、8 つの設定が `testDescriptionConfig` で読み込みます。規則は `libs/interface-spec/src/eslint/test-description.ts` にあります。
本体は、引数の中の最後の関数式とします。`test(題, options, 本体)` と `test(題, 本体, timeout)` の形があるためです。本体の関数式が無い呼び出しと、`.todo`・`.extend` は見ません。
pytest の行は、pre-commit の hook `check-pytest-titles`（`.githooks/pre-commit/check-pytest-titles.py`）が止めます。モジュールの直下と `Test*` クラスの `test_*` 関数を見ます。

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

## bash のテスト

`*.test.sh` と `cli/tests/bootstrap/` のテストは、確かめを `bt_*` の関数で書きます。関数は `.githooks/scripts/test_report/bash-test.sh` にあります。確かめ 1 つが、テストレポートの 1 件になります。

| 決め | 例 |
|---|---|
| 成功と失敗で同じ題にする。題は確かめたいこと（成功の形）を書き、失敗の中身は理由に書く | `bt_fail "SKILL.md に手順がある" "見つからない"` |
| 一時ディレクトリ・PID・時刻・ポートのような、実行ごとに変わる値を題に入れない。理由には入れてよい | — |
| 1 つのファイルの中で同じ題を使わない。重なると、2 回目が failed になる | — |
| ファイルの最後に `bt_finish` を置く。届かずに終わると、runner が「最後まで動く」を broken にし、stderr の末尾を添える | — |
| 前提が崩れて止めるときは、理由を stderr に出してから `exit 1` する。その文が broken の理由になる | `echo "ERROR: fixture を作れない" >&2; exit 1` |
| 自前の `pass`・`fail`・`check`・`assert_*` を作らない | — |

## 従う考え方

項目へのつなぎは、要件とテストの双方向の追跡と網羅の考え方に従います。

| 考え方 | このリポでの形 |
|---|---|
| 要件から確かめる手段へたどれる | テストが、振る舞いの項目の ID を名指しする |
| 確かめる手段の無い要件を残さない | テストの無い項目を、つなぎの確認が止める |
| 要件に無いものを指す手段を残さない | 定義書に無い ID を、つなぎの確認が止める |
| 結果から要件へたどれる | テストレポートが、項目の ID ごとにつないだテストと合否を並べる。定義書のサイトの機能要件の表から、その ID の絞り込みへつながる |

つなぎの確認は ID の有無だけを見ます。テストが項目の中身を確かめていることは、レビューで見ます。
