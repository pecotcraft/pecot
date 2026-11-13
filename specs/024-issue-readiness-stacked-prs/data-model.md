# Data Model: Issue の着手の可否の判定と stacked PRs

**Date**: 2026-11-12

保存するものは少ない。前提は GitHub の blocked by が持ち、判定はその都度計算する。
ここでは、計算の入力と出力の形、保存する値、状態の動きを決める。

## 1. 前提

待つ側の Issue と、待たれる側の Issue の組。GitHub の blocked by が持つ。

| 項目 | 内容 |
|---|---|
| 待つ側 | Issue（`owner/repo#N`） |
| 待たれる側 | Issue（`owner/repo#N`）。別のリポでもよい |
| 種類 | `stack`（積める）か `merge`（マージを待つ）。既定は `stack` |
| 理由 | 種類が `merge` のときに必須。1 行の文 |

次の決まりで扱う。

- 前提の有無は blocked by を正とする
- 種類と理由は、待つ側の Issue の本文の節が持つ。節に無い前提の種類は `stack` だ
- 節にあって blocked by に無い組は、判定に使わない。食い違いとして表示する
- 節が読めないときは、その Issue の前提をすべて `merge` として扱う
- 待つ側から待たれる側をたどって、待つ側に戻る組は付けない（輪）
- 1 つの Issue に付けられる前提は 50 件まで（GitHub の上限）

本文の節の形は [contracts/prerequisite-table.md](contracts/prerequisite-table.md) に決める。

## 2. Issue の実態

判定の入力。GitHub から読んだ値を、domain が使う形にまとめたもの。

| 項目 | 内容 |
|---|---|
| ref | `owner/repo#N` |
| state | `open` か `closed` |
| 列 | 進行の欄の値。ボードに無ければ空 |
| 札 | 既定の Status の値。ボードに無ければ空 |
| 種別 | 着手の対象（タスク・バグ）か、対象でない（Epic・Tracker）か |
| ブランチ | Issue にリンクしたブランチの名前の一覧 |
| PR | Issue の PR の一覧。番号・状態（open・merged・closed）・head・base・ドラフトか・fork からか。集め方は下に書く |
| 前提 | 「1. 前提」の組の一覧 |

Issue の PR は、次の 3 つから集め、リポと番号の組で重ねずに合わせる（research.md の R3）。

| 読み口 | 採る PR |
|---|---|
| リンクしたブランチ | そのブランチを head に持つ PR。fork からの PR は採らない |
| 閉じる参照 | `closedByPullRequestsReferences(includeClosedPrs: true)` の PR |
| タイムライン | `ConnectedEvent` の PR（後で外したものを除く）と、`CrossReferencedEvent` のうち閉じる意図のある PR（`willCloseTarget` が真か、head のブランチ名が `/<Issue番号>` で終わる） |

積んだ上の段の PR は、マージの後はブランチが消え、閉じる参照も持たない。タイムラインだけが、その PR を読める（R14）。

次の決まりで扱う。

- どの読み口でも、件数の上限を超えて読み切れなかったときは、前提の読み取りに失敗したものとして扱う（判定の順 1）
- 前提の Issue が読めない（権限が無いなど）ときも、前提の読み取りに失敗したものとして扱う
- Issue の依存関係は GHES 3.19 以上が要る。それより前の GHES では、対応していない旨のエラーで止める

そこから、次の 3 つの値が決まる。

| 値 | 条件 |
|---|---|
| 済んだ | state が `closed` で、PR のどれかが merged |
| PR 中 | state が `open` で、open の PR がちょうど 1 本あり、fork からでない |
| 着手の跡がある | ブランチか PR が 1 つ以上ある |

## 3. 着手の判定

1 件の Issue に対する出力。保存しない。

| 項目 | 内容 |
|---|---|
| 区分 | `startable`（着手できる）・`stackable`（積めば着手できる）・`blocked`（ブロック中） |
| 積む先 | 区分が `stackable` のときの、base にするブランチと、その Issue |
| 理由 | 下の表のコードと、当てはまる前提の Issue のすべての一覧 |
| 見直しが要るか | 前提のどれかが、マージされずに閉じられているとき真。当たった順にかかわらず決める |
| 注記 | 済んでいない前提のうち、札が `Needs Attention` の Issue の一覧。どの区分にも付く |

判定は、次の表を上から当てはめ、最初に当たったものを採る。

| 順 | 条件 | 区分 | 理由のコード |
|---|---|---|---|
| 1 | 前提の読み取りに失敗した | `blocked` | `unreadable` |
| 2 | 前提が輪になっている | `blocked` | `cycle` |
| 3 | 前提のどれかが、閉じていて済んでいない | `blocked` | `closed-unmerged` |
| 4 | 済んでいない `merge` の前提がある | `blocked` | `waits-merge` |
| 5 | 済んでいない前提が無い | `startable` | — |
| 6 | 済んでいない前提のどれかが、別のリポにある。前提が同じリポでも、その PR が別のリポにあるときを含む | `blocked` | `other-repository` |
| 7 | 済んでいない前提のどれかが、PR 中でない | `blocked` | `not-in-review` |
| 8 | 済んでいない前提が、1 本の列に並ばない | `blocked` | `diverged` |
| 9 | 上のどれにも当たらない | `stackable` | — |

次の決まりで扱う。

- 順 3 に当たると、見直しが要るかが真になる。順 1・2 で止まったときも、閉じて済んでいない前提があれば真だ
- 順 7 の理由には、前提ごとの状態を添える。着手済みで PR が無い、未着手、PR が 2 本以上、fork からの PR、列が `Pending` の 5 つだ
  - 列が `Pending` の前提は、PR 中でも積む先にしない。人が後回しにしたものだからだ
  - ドラフトの PR も PR 中に数える
- 順 8 の「1 本の列に並ぶ」は、進め方（4）と同じく、1 つの前提からほかの全部へ届くことをいう
  - 済んでいない前提の PR のどれか 1 本から base をたどり、ほかの前提の PR の head にすべて届き、開発ブランチまで届けば 1 本の列だ
  - たどる途中に、直接の前提でない PR（間接の前提）が挟まってもよい。たどるのは、open で fork からでない PR だけだ
  - 積む先は、出発した PR の head のブランチと、その Issue だ
- 前提の Issue の札が `Needs Attention` のときは、理由とは別に注記に入れる。判定の順は変えない
- Epic と Tracker には判定を出さない

## 4. 進め方

Issue 化の前に、フェーズごとに出す見込み。Issue の状態を見ず、前提の形と種類だけで決める。

| 進め方 | 条件 |
|---|---|
| 単独 | 前提が無い |
| マージ待ち | `merge` の前提がある |
| 積める | 前提がすべて `stack` で、1 本の列に並ぶ |
| 合流 | 前提がすべて `stack` で、2 本以上の列に分かれる |

次の決まりで扱う。

- 上から当てはめる。`merge` の前提があれば、ほかの前提の形にかかわらず「マージ待ち」だ
- 「1 本の列に並ぶ」は、前提のどれか 1 つから、ほかの前提のすべてへ、前提をたどって届くことをいう。積む先は、その 1 つのフェーズだ
- 積める並びは、「積める」のフェーズを積む先へたどった並びだ。下の段から順に出す。枝分かれは、並びを分けて出す
- 今回 Issue 化しない前提（Issue 化済みのフェーズ）は、既存の Issue として前提に入れる
- 着手の判定と同じ列の定義を使う。Issue の状態を「すべて PR 中」と置いたときの判定が、進め方と一致する

## 5. ボードの値

### 進行の欄（`pecot-workflow-<suffix>`）

| 値 | 意味 | 動かす者 |
|---|---|---|
| Pending | 人が後回しにした | 人 |
| Backlog | まだ計画していない | 人と pecot（Epic と Tracker を置く） |
| Blocked（新設） | 進める予定だが、前提を待っている | pecot |
| Ready | 今、着手できる | pecot |
| Active | 着手済み | pecot |
| In Review | PR が出ている | pecot |
| Archived | 退避 | 人と GitHub の自動化 |

- 並びは上の順にする。`Blocked` は `Backlog` と `Ready` の間に差し込む
- `Blocked` の色は `Pending` と同じ GRAY、説明は英語で、前提を待つ Issue を pecot が置く列と書く
- `Pending` の説明から「or blocked」を外す

### 既定の Status

| 値 | 意味 | 書く者 |
|---|---|---|
| Todo | 作業が残っている | GitHub の既定の自動化、pecot（`Needs Attention` の解除だけ） |
| In Progress | 着手済みで PR がある | GitHub の既定の自動化 |
| Done | 完了 | GitHub の既定の自動化 |
| Needs Attention（新設） | 人の対応か判断を待っている | pecot。spec 023 の自動処理も同じ値を書く |

- `Needs Attention` の色は RED にする。末尾に足す
- この機能が `Needs Attention` を書くのは、見直しが要る Issue だけだ

### 設定ファイル

`.pecot/config/projects/*.json` の `project.fields` に足す。

| キー | 内容 |
|---|---|
| `workflow.options.blocked` | `Blocked` の選択肢の ID。ボードに無ければキーが無い |
| `status.id` | 既定の Status のフィールドの ID |
| `status.options.todo` | `Todo` の選択肢の ID |
| `status.options.needs_attention` | `Needs Attention` の選択肢の ID。ボードに無ければキーが無い |

- `workflow.options.blocked` が無いボードでは、列を動かさない。足し方を案内する
- `status` が無い、または `needs_attention` が無いボードでは、札を書かない。足し方を案内する

## 6. 列を直す判断

入力は、Issue の今の列・着手の判定・着手の跡の有無。出力は、動かす先の列（動かさないときは無し）。

| 今の列 | 着手の跡 | 判定 | 動かす先 |
|---|---|---|---|
| Ready | 無し | `blocked` | Blocked |
| Blocked | 無し | `startable`・`stackable` | Ready |
| Active・In Review | 無し | `blocked` | Blocked |
| Active・In Review | 無し | `startable`・`stackable` | Ready |
| Active・In Review | 有り | どれでも | 動かさない |
| Ready・Blocked | 有り | どれでも | 動かさない |
| Backlog・Pending・Archived | どちらでも | どれでも | 動かさない |
| ボードに無い | どちらでも | どれでも | 動かさない |

札は、次の表で決める。

| 着手の跡 | 見直しが要るか | 今の札 | 書く値 |
|---|---|---|---|
| 無し | 真 | `Needs Attention` 以外 | `Needs Attention` |
| 無し | 偽 | `Needs Attention` で、この機能が書いたもの | `Todo` |
| 無し | 偽 | `Needs Attention` で、自動処理が書いたもの | 書かない |
| 有り | どちらでも | どれでも | 書かない |

- `Todo` に戻すのは、前提を 1 つ以上持つ Issue だけだ。前提の無い Issue の `Needs Attention` は、人が付けたものとして残す

次の決まりで扱う。

- 対象は、open で、着手の対象になる Issue だけだ
- 着手の跡がある Issue は、進めているセッションのものだ。列を直す処理は、その列と札を変えない（FR-084）
- 着手の跡がある Issue の判定が `blocked` のときは、食い違いとして返す。呼んだコマンドが `warning:` で出す
- 札が自動処理（spec 023）のものかどうかは、Issue に結果のコメントがあるかで見分ける。spec 023 が入る前は、この機能が書いたものとして扱う
- 動かしたときは、Issue・元の列・新しい列・理由を出力に出す

## 7. 状態の動き

未着手の Issue の列は、次のように動く。

```text
            前提が付く・前提の PR が閉じる
   Ready <------------------------------------> Blocked
     |      前提が済む・積めるようになる           |
     |                                            | 前提がマージされずに閉じる
     | 着手（create-branch）                       v
     v                                      Blocked + Needs Attention
   Active                                         |
     | PR の作成                                   | 人が前提を外す・付け替える
     v                                            v
   In Review                               判定に合った列 + Todo
```

| きっかけ | 動かす操作 | 動く Issue |
|---|---|---|
| 一括投稿 | `pecot issue create` | 作った Issue。前提があれば Blocked、無ければ Ready |
| 前提の PR ができた | `pecot pr create` | その Issue を前提にしている Issue |
| 前提の PR がマージされた | `pecot pr cleanup` | 同上 |
| 前提と種類が変わった | `pecot issue block`・`unblock` | 待つ側の Issue |
| 上のどれも通らなかった | GitHub Actions のワークフロー | Ready と Blocked にある Issue と、着手の跡が無い Active・In Review の Issue |

## 8. 積んだブランチの記録

作業ディレクトリごとの状態のファイル。`.pecot/state/.pecot-base` に 1 行で置く。

| 項目 | 内容 |
|---|---|
| base のブランチ | 着手のときに base にしたブランチの名前 |
| base の位置 | そのブランチの、載せたときのコミットの SHA |
| 積んだ先の Issue | `owner/repo#N`。開発ブランチから着手したときは空 |

次の決まりで扱う。

- 書くのは `pecot create-branch` と `pecot pr restack` だ
- 手元を `origin/<branch>` に合わせたときは、base の位置を次の結果にする
  - `git merge-base origin/<branch> <開発ブランチ>`
- 消すのは `pecot pr cleanup` で、`.pecot-active` と一緒に消す
- 開発ブランチから着手したときも書く。base が開発ブランチだと分かるようにするためだ
- ファイルが無い作業ディレクトリは、開発ブランチから着手したものとして扱う。この機能の前に着手したブランチがこれに当たる

## 9. Issue ファイルの frontmatter

`task-implement` のテンプレートに足す欄と、外す欄。

| 欄 | 変更 | 内容 |
|---|---|---|
| `blocked_by` | 足す | 前提の一覧。空でよい |
| `blocked_by[].issue` | 足す | 同じ一括投稿のファイルのキーか、`owner/repo/N` |
| `blocked_by[].wait` | 足す | `stack` か `merge`。省くと `stack` |
| `blocked_by[].reason` | 足す | `wait` が `merge` のときに必須 |
| `order` | 変える | 省けるようにする。省くと CLI が次の通し番号を振る |
| `parallel` | 外す | 書くと、使えなくなった旨を出して止まる |
| `status` | 変える | 省けるようにする。省くと CLI が判定で `ready` か `blocked` に決める |

次の決まりで扱う。

- ファイルのキーは、今の Issue のキーのプレースホルダと同じ決まりで作る。ファイル名の幹と、`--suffix` の部分だ
- 一括投稿のファイルは、前提が先に来る順で並べる。後ろのファイルを前提として指すと、投稿の前に止まる
- `blocked_by` を書いたファイルに `status: ready` を書くと、判定と食い違うので止まる
