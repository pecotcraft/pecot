---
paths:
  - "**/*.test.ts"
  - "plugins/pecot-workflow/cli/tests/**/*.py"
---

# テストの規約

テストを、振る舞いの資料として読める形にそろえます。題の形と、定義書の振る舞いの項目へのつなぎ方を決めます。

## 対象

| テスト | 題の形 | 項目へのつなぎ |
|---|---|---|
| コマンド・ツールの公開面を確かめる vitest | 規約に従う。lint が止める | 振る舞いの項目を確かめるテストは、ID を書く |
| ドメイン層などの単体の vitest | 規約に従う。lint が止める | 求めない |
| pecot-workflow の pytest | 直さない。lint の対象にしない | 振る舞いの項目を確かめるテストは、ID を書く |

新しく作る公開面のテストのファイルは、各 project の `tests/interface/` に置きます。
今の公開面のテストは、観点ごとのファイルで全ツールを回す作りのまま残し、この置き場に入れません。

`plugins/pecot-visual/assets/slidev/` のテストは `node:test` で書かれており、この規約の対象外です。

## 題の形（vitest）

| 決め | 例 |
|---|---|
| 新しく作る公開面のテストのファイルでは、いちばん外の `describe` の題を、コマンド・ツールの名前にする | `describe('aws_s3_ls', …)`、`describe('issue create', …)` |
| `it` の題は、「どのとき、どうするか」の日本語の 1 文にする。主語（コマンド・ツールの名前）は書かない。文の形は、振る舞いの項目と同じ EARS の型に寄せる | `it('バケット名に大文字があると、入力エラーを返す', …)` |
| `it` の題は句点で終えない。「正しく動く」「正常に処理する」のように、結果を言わない題にしない | — |
| 表を回すテストの題は、行ごとに読める文になる。行がオブジェクトなら `$name` のようにキーで、配列なら `%s` で値を埋める。空文字が入りうる値は `%j` で埋める | `it.for(rows)('$name を渡すと、$expected を返す', …)` |

`$name` の直後は、空白・`、`・括弧にします。vitest はひらがなや漢字、`・`、`ー` もキーの一部と読むので、`'$nameのとき'` はキーが `nameのとき` になり、題が `undefined` になります。`.` を直後に置くと、深い所を指す記法と読まれ、同じく `undefined` になります。lint とテストは、これを止めません。

配列の行は、`$0`・`$1` でも位置を指せます。`it.for` でオブジェクトの行に `%s` を使うと、オブジェクト全体が出ます。

`describe` の題は、ほかのファイルでは関数名のままでかまいません。

## lint が止めるもの

`@vitest/eslint-plugin` の `vitest/valid-title` に、`it` と `test` の題の形を渡しています。

| 止めるもの | 出る文言 |
|---|---|
| `it`・`test` の題に、ひらがな・カタカナ・漢字が無い | `題に日本語が無い` |
| `it`・`test` の題が全角の句点（`。`）で終わる | `題が句点で終わる` |

日本語が無く、しかも句点で終わる題では、句点の文言だけが出ます。

`it.each`・`it.for`・`it.skipIf(...)` のような修飾つきの呼び出しも止めます。
`${}` を含むテンプレートリテラルの題と、文字列の連結（`'a' + x`）の題は、値が決まらないので止めません。
変数や関数呼び出しの題は、規約の文言ではなく `Test title must be a string` で止まります。

設定は次の 5 つに、同じ形で書いています。変えるときは 5 つとも変えます。

- `plugins/pecot-tools/cli/eslint.config.js`
- `plugins/pecot-visual/cli/eslint.config.js`
- `plugins/pecot-workflow/cli-node/eslint.config.js`
- `libs/text-rules/eslint.config.js`
- `libs/interface-spec/eslint.config.js`

公開面のテストのいちばん外の `describe` の題が、定義書の `name` にあるかの確かめは、#279 で足します。

## 項目へのつなぎ

vitest は、テストの本体の最初で `verifies` を呼びます。ID は文字列のリテラルで書きます。`verifies` の関数は、各 project の `tests/_helpers/verifies.ts` にあります。project は pecot-tools・pecot-visual の `cli/` と、pecot-workflow の `cli-node/` です。

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

pytest は、デコレータで書きます。関数の名前は直しません。

```python
@add_test_properties(verifies=["PW-SESSION-STATUS-02"])
def test_unknown_branch(self, runner):
    ...
```

| 決め | 内容 |
|---|---|
| 1 件のテストから複数の項目へ | `verifies` を項目ごとに呼ぶ。pytest は配列に並べる |
| 1 つの項目に複数のテスト | よい。項目につながるテストは 1 件以上あればよい |
| ID の書き方 | 文字列のリテラルだけ。変数で組み立てない。つなぎの確認が、テストのファイルの文字列から ID を集めるためだ |
| 全ツールに共通の振る舞い | 共通の振る舞いの項目（`<接頭辞>-COMMON-NN`）につなぐ。ツールの数だけ項目を作らない |
| どの項目も確かめないテスト | つながなくてよい。振る舞いの一覧には出ない |

## 従う考え方

項目へのつなぎは、要件とテストの双方向の追跡と網羅の考え方に従います。

| 考え方 | このリポでの形 |
|---|---|
| 要件から確かめる手段へたどれる | テストが、振る舞いの項目の ID を名指しする |
| 確かめる手段の無い要件を残さない | テストの無い項目を、つなぎの確認が止める |
| 要件に無いものを指す手段を残さない | 定義書に無い ID を、つなぎの確認が止める |
| 結果から要件へたどれる | 表示が、項目ごとにつないだテストと合否を並べる |

つなぎの確認は ID の有無だけを見ます。テストが項目の中身を確かめていることは、レビューで見ます。
