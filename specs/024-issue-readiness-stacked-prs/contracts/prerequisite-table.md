# Contract: 前提の表と、Issue の本文の節

**Date**: 2026-11-12

前提は 3 つの場所を通る。tasks.md の前提の表、Issue ファイルの frontmatter、Issue の本文の節だ。
ここでは、それぞれの形と、写し方を決める。

## 1. tasks.md の前提の表

w-breakdown が、tasks の工程に書かせる。置き場は、`## Dependencies & Execution Order` の下の `### Phase Dependencies` だ。

```markdown
### Phase Dependencies

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | `start` が、Phase 1 の設定のキーを使う |
| 3 | 2 | 積める | スキルが `pecot auto start` を呼ぶ |
| 4 | 2 | 積める | 雛形が `pecot auto gate` を呼ぶ |
| 5 | 3 | 積める | スキルに、CI を直す種類を足す |
| 5 | 4 | マージを待つ | action は、既定のブランチのプラグインを入れる |
```

次の決まりで書く。

- 1 行が、フェーズと前提の 1 組だ。前提が 2 つあるフェーズは 2 行になる
- 前提の無いフェーズは、表に書かない
- `Phase` と `前提` は、フェーズの番号だけを書く
- `種類` は「積める」か「マージを待つ」のどちらかだ
- `理由` は、すべての行に書く。「マージを待つ」の行では、main に入っていないと進められない訳を書く
- 前提にするのは、フェーズ全体の着手を止める依存だけだ。一部のタスクだけが待つ依存は、タスクの行に注記で書く
- 直接の前提だけを書く。Phase 3 が 2 を待ち、2 が 1 を待つとき、Phase 3 の行に 1 は書かない

種類は、次の問いで決める。

| 問い | 種類 |
|---|---|
| 前提の変更が手元のブランチの下にあれば、このフェーズの実装と確認ができる | 積める |
| 前提の変更が main に入っていないと、このフェーズの実装か確認ができない | マージを待つ |

「マージを待つ」になる例を挙げる。

- 既定のブランチから配られるものを使う（プラグイン・action・公開したパッケージ）
- リリースの後の実物で確かめる
- main の CI やリリースのワークフローが、前提の変更を使う

## 2. Issue ファイルの frontmatter

w-issueize が、前提の表の行を frontmatter に写す。

```yaml
---
title: "CI を直す手順を足す"
type: task
template: task-implement
repository: "acme/app"
parent_epic: "acme/app/315"
blocked_by:
  - issue: phase3
  - issue: phase4
    wait: merge
    reason: "action は、既定のブランチのプラグインを入れる"
---
```

次のとおりに写す。

| 前提の表 | frontmatter |
|---|---|
| `前提` のフェーズ | `issue`。そのフェーズのファイルのキー。Issue 化済みのフェーズは `owner/repo/N` |
| `種類` が「積める」 | `wait` を書かない |
| `種類` が「マージを待つ」 | `wait: merge` |
| `理由` | `wait: merge` のときだけ `reason` に写す |

- 「積める」の行の理由は、frontmatter に写さない。tasks.md に残る
- `order`・`parallel`・`status` は書かない。CLI が決める

## 3. Issue の本文の節

`pecot issue create` が、マージを待つ前提のある Issue の本文の末尾に足す。エージェントは手で書かない。

```markdown
## Waits for merge

- #362: action は、既定のブランチのプラグインを入れる
- acme/other#12: 公開したパッケージの版を使う
```

次の決まりで書き、読む。

- 見出しは `## Waits for merge` に固定する
- 1 行が 1 つの前提だ。形は `- <Issue の参照>: <理由>`
- Issue の参照は、同じリポなら `#N`、別のリポなら `owner/repo#N`
- 積める前提は書かない。マージを待つ前提が無い Issue には、節そのものを置かない
- 節は本文の末尾に置く。テンプレートの見出し（Goal・Tasks・Acceptance・Artifacts）の後ろだ
- 読むときは、見出しから次の `##` の見出しか本文の終わりまでを節とする
- 形に合わない行が 1 つでもあれば、節を読めないものとして扱う

書き換えるのは、次の 3 つのコマンドだけだ。

| コマンド | 書き換え |
|---|---|
| `pecot issue create` | 節を足す |
| `pecot issue block` | 行を足す・理由を変える・行を外す |
| `pecot issue unblock` | 行を外す。行が無くなれば節を消す |

## 4. 表が無い tasks.md

spec-kit をそのまま使った tasks.md には、4 列の表が無い。w-issueize は次のように扱う。

1. `Phase Dependencies`・`User Story Dependencies`・`Parallel Opportunities` の文から、フェーズの前提を読む
2. 種類はすべて「積める」とする
3. 読んだ結果を 4 列の表にして利用者に示し、表が無かった旨を伝える
4. 利用者が種類を変えるよう指示したら、その行を直す

## 5. 確かめること

`pecot issue create --plan` が、投稿の前に次を確かめる。

| 確かめること | 外れたとき |
|---|---|
| `blocked_by` の `issue` が、ファイルのキーか `owner/repo/N` である | 止まる |
| 前提のファイルが、指すファイルより前に並んでいる | 止まる |
| 前提が輪にならない | 止まる |
| `wait: merge` に `reason` がある | 止まる |
| `owner/repo/N` で指した Issue が読める | 止まる |

前提の表と frontmatter が合っているかは、CLI は確かめない。w-issueize が、`--plan` の出力を前提の表と並べて利用者に示す。
