# Data Model: CLI の出力の行

永続化するデータは無い。共通の関数が扱う値の型を決める。行の形は [contracts/output-lines.md](contracts/output-lines.md) にある。

## Verb（動詞）

| フィールド | 型 | 説明 |
|---|---|---|
| present | 文字列 | plan の行に使う現在形。例 `update` |
| past | 文字列 | result の行の前置きに使う過去分詞。例 `updated` |

- 列挙型で、契約の表にあるものだけを持つ
- Python と Node で同じ値の一覧を持つ。一致は `cases.json` のテストで確かめる

## Operation（操作）

| フィールド | 型 | 説明 |
|---|---|---|
| verb | Verb | 何をするか |
| target | 文字列 | 何に対してか。英語の固定部分と、GitHub から読んだ値を組み合わせる。例 `Tracker #179 body` |

- plan と result は、同じ Operation から行を作る

## Output（共通の関数を持つもの）

| フィールド | 型 | 説明 |
|---|---|---|
| dryRun | 真偽 | コマンドの起動時に決まる。途中で変えない |
| stdout | 書き込み先 | data だけが使う |
| stderr | 書き込み先 | data 以外の行が使う |

| 関数 | 入力 | 出す行 |
|---|---|---|
| planned | Operation | dryRun のときだけ plan の行 |
| done | Operation | dryRun でないときだけ result の行 |
| warning | message | warning の行 |
| error | message | error の行 |
| note | message | note の行（pecot-visual・pecot-tools だけ） |
| count | label・値（整数か未設定） | count の行 |
| data | 文字列 | stdout へ中身をそのまま |

- コマンドのコードは Output を受け取り、書き込み先に直接触れない
- テストは書き込み先を差し替え、出た行を期待の行と比べる

## 状態の移り変わり

Output は状態を持たない。dryRun は起動時に決まり、終了まで変わらない。
