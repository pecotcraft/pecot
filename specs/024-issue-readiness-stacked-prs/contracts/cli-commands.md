# Contract: CLI のコマンド

**Date**: 2026-11-12

出力の行の形は、既存の決まり（`specs/021-cli-output-functions/contracts/output-lines.md`）に従う。
結果は stdout に、経過の行（`created:`・`moved:`・`warning:`・`error:` など）は stderr に出す。
終了コードは、0 が成功、1 が実行の失敗、2 が使い方の誤りと着手の停止、3 が内容の検証の失敗だ。

判定の表示に使う言葉は、次の 3 つに固定する。

| 区分 | 表示 |
|---|---|
| `startable` | `startable` |
| `stackable` | `stackable on #N` |
| `blocked` | `blocked by #N, #M` と、理由の文 |

## 新しいコマンド

### `pecot issue block <issue_ref> --by <issue_ref> [--wait merge --reason <text>]`

Issue に前提を付ける。付いている前提の種類と理由を変えるのにも使う。

| 引数 | 内容 |
|---|---|
| `issue_ref` | 待つ側の Issue。`owner/repo/N` |
| `--by` | 待たれる側の Issue。`owner/repo/N`。別のリポでもよい |
| `--wait` | `stack`（既定）か `merge` |
| `--reason` | `--wait merge` のときに必須 |
| `--dry-run` | 付けずに、付ける内容を出す |

| 場面 | 出力 | 終了コード |
|---|---|---|
| 付けた | `added: blocked-by #B to #A` | 0 |
| 既に付いていて、種類も同じ | `unchanged: blocked-by #B on #A` | 0 |
| 種類か理由を変えた | `updated: blocked-by #B on #A (wait: merge)` | 0 |
| 付けた後に判定が変わった | 続けて `moved: #A Ready -> Blocked (blocked by #B)` | 0 |
| 付けると輪になる | `error: blocked-by would form a cycle: #A -> #B -> #A` | 2 |
| `--wait merge` で `--reason` が無い | `error: --reason is required with --wait merge` | 2 |
| 前提が 50 件を超える | `error: #A already has 50 blocked-by issues` | 1 |

- 種類が `merge` のとき、待つ側の Issue の本文の節に、前提と理由を足す。`stack` に変えると、節から外す
- 節のほかの部分と、本文のほかの節は書き換えない
- 付けた後、待つ側の Issue の判定を計算し直し、列と札を動かす。待つ側の Issue に着手の跡があるときは動かさず、`warning:` で食い違いを出す
- hook の確認にはかけない

### `pecot issue unblock <issue_ref> --by <issue_ref>`

Issue から前提を外す。

| 場面 | 出力 | 終了コード |
|---|---|---|
| 外した | `removed: blocked-by #B from #A` | 0 |
| 付いていなかった | `unchanged: #A is not blocked by #B` | 0 |
| 外した後に判定が変わった | 続けて `moved: #A Blocked -> Ready` | 0 |
| 札が `Needs Attention` で、見直しの要る前提が無くなった | 続けて `set: Status of #A to Todo` | 0 |

- 本文の節にその前提があれば、一緒に外す。節が空になれば、節ごと消す

### `pecot pr merge <pr_ref>`

PR をマージする。スタックの中の PR と、単独の PR の両方を扱う。

| 引数 | 内容 |
|---|---|
| `pr_ref` | `owner/repo/N` |
| `--dry-run` | マージせずに、行う内容を出す |

| 場面 | 出力 | 終了コード |
|---|---|---|
| 単独の PR をマージした | `merged: PR #N into <base>` | 0 |
| スタックの最下段をマージした | `merged: PR #N into <base> (stack #S, 1 of K)` | 0 |
| merge queue に入った | `added: PR #N to merge queue of <base>` | 0 |
| スタックの最下段でない | `error: PR #N is not the bottom of stack #S. Merge PR #M first` | 2 |
| ドラフト | `error: PR #N is a draft` | 2 |
| GitHub が規則で拒んだ | `error: merge was rejected: <GitHub の文>` | 1 |
| 非同期のマージが時間内に終わらない | `error: merge did not finish in <秒>s. Check PR #N` | 1 |

- マージの方法は squash に固定する。merge queue のあるブランチでは、キューの設定に従う
  - merge queue の無いブランチでは、非同期のマージ API に `merge_method: "squash"` を渡す。省くと merge commit になる
  - merge queue のあるブランチでは、`merge_method` を渡さない。渡すと GitHub が拒む（research.md の R5）
- マージの後の片付けは行わない。`pecot pr cleanup` を続けて打つ
- hook は、MCP のツール `pr_merge` を確認にかける。`gh pr merge` と同じ扱いだ

### `pecot pr restack [--check] [--continue] [--abort]`

今のブランチを、base にしたブランチの新しい位置へ載せ直す。

| 場面 | 出力 | 終了コード |
|---|---|---|
| `--check` で、載せ直しが要らない | stdout に `up to date: <branch> on <base>` | 0 |
| `--check` で、載せ直しが要る | stdout に `needs restack: <branch> on <base> (base moved)` | 0 |
| `--check` で、base の PR がマージ済み | stdout に `needs restack: <branch> onto <develop> (base #N merged)` | 0 |
| 載せ直して push した | `updated: <branch> restacked on <base>` | 0 |
| 載せ直しが要らなかった | `unchanged: <branch> is up to date` | 0 |
| 衝突した | `error: conflict in <files>`、続けて `--continue` と `--abort` の案内 | 3 |
| 未コミットの変更がある | `error: working tree has uncommitted changes` | 2 |
| base のブランチが消えていて、マージもされていない | `error: base branch <base> is gone and PR #N was not merged` | 1 |

- 書き換えるのは、今の作業ディレクトリのブランチだけだ
- base の PR がマージ済みなら、開発ブランチへ載せ直し、記録の base を開発ブランチに変える
  - GitHub は、リモートの今のブランチを先に載せ直している。手元に push していないコミットが無ければ、手元をリモートに合わせ、push しない
  - push していないコミットがあれば、記録した古い base の位置で `rebase --onto` する（research.md の R6）
- push は `--force-with-lease` を使う
- 載せ直しの後、base の位置の記録を書き直す

## 振る舞いを変えるコマンド

### `pecot issue create`

| 変更 | 内容 |
|---|---|
| `blocked_by` | frontmatter の前提を、作った Issue に blocked by として付ける |
| マージを待つ前提 | 本文の末尾に節を足す。形は [prerequisite-table.md](prerequisite-table.md) |
| `--plan` | 投稿せずに、進め方の表と積める並びを stdout に出す |
| 列 | `status` を省いた Issue は、判定で `Ready` か `Blocked` に置く |
| 番号 | `order` を省いた Issue に、次の通し番号を振る。`parallel` は受け付けない |

`--plan` は、次の形で出す。

```text
| File | Number | Blocked by | Approach |
|---|---|---|---|
| phase3 | 19 | - | alone |
| phase4 | 20 | phase3 | stack on phase3 |
| phase5 | 21 | phase4 (merge) | wait for merge of phase4 |
| phase6 | 22 | phase4, phase5 | join (wait for phase4, phase5) |

Stackable chains:
- phase3 -> phase4
```

次の場面では、投稿の前の確認で止まる。投稿は 1 件も行わず、終了コードは 1 だ。

| 場面 | 出力 |
|---|---|
| 前提のキーが、どのファイルにも無い | `error: blocked_by in <file> refers to unknown key <key>` |
| 前提が、後ろのファイルを指す | `error: blocked_by in <file> refers to <key>, which comes later` |
| 前提が輪になる | `error: blocked_by forms a cycle: <key> -> <key>` |
| `wait: merge` に `reason` が無い | `error: blocked_by in <file> needs reason for wait: merge` |
| `parallel` が書かれている | `error: parallel is no longer supported in <file>. Remove it` |

投稿の後は、次のように出す。

| 場面 | 出力 | 終了コード |
|---|---|---|
| 前提を付けた | Issue ごとに `added: blocked-by #B to #A` | 0 |
| 前提を付けられなかった組がある | `warning: could not add blocked-by #B to #A: <理由>`。最後に、付け直すコマンドの一覧 | 1 |
| 全部終わった | `Stackable chains:` と、Issue の番号での並び | 0 |

- Issue の作成が途中で失敗したときは、作られた Issue どうしの前提だけを付ける

### `pecot issue read`

Markdown の出力に 2 行を足す。前提が無い Issue では出さない。

```text
**Blocked by:** #348 registry から MCP ツールを公開する (OPEN, in review), #349 ツール名を確かめる (OPEN, wait: merge — action は既定のブランチのプラグインを入れる)
**Readiness:** blocked by #349 (waits for merge)
```

- JSON の出力に `blockedBy`（番号・リポ・状態・種類・理由）と `readiness`（区分・積む先・理由）を足す
- 本文の節と blocked by が食い違うときは、`warning:` を出す

### `pecot create-branch`

| 判定 | 動き | 出力 | 終了コード |
|---|---|---|---|
| `startable` | 開発ブランチから作る | `created: branch <b> in <repo> from <develop>` | 0 |
| `stackable` | 積む先のブランチから作る | `created: branch <b> in <repo> from <base> (stacked on #N)` | 0 |
| `blocked` | 作らない | `error: #A is blocked by #B (<理由>)`、続けて直し方の案内 | 2 |
| 判定の読み取りに失敗 | 作らない | `error: could not read blocked-by of #A` | 1 |

- `--base` を指定したときは、判定で選んだ base と比べる。違えば止まる（終了コード 2）
- ブロックを無視する指定は置かない
- base のブランチと位置を、状態のファイルに記録する
- 直し方の案内は、`pecot issue unblock` と `pecot issue block --wait` の 2 行だ

### `pecot pr create`

| 場面 | 動き | 出力 |
|---|---|---|
| 記録の base が開発ブランチ | 今までどおり | 変わらない |
| 記録の base が下の段のブランチで、その PR が開いている | base を下の段のブランチにして作り、スタックに登録する | `created: PR #N <head> -> <base>`、`added: PR #N to stack #S` |
| 下の段の PR がマージ済み | base を開発ブランチにして作る | `created: PR #N <head> -> <develop>` |
| 下の段の PR が無く、マージもされていない | 作らない | `error: base branch <base> has no open PR`（終了コード 2） |
| スタックの機能が無いリポ | PR は作る | `warning: could not register stack: <理由>` |

- `--prepare` は、記録の base をテンプレートの `base` に入れる
- 内容の検証は、base が開発ブランチか、記録の base と同じなら通す
- PR を作った後、この Issue を前提にしている Issue の判定を計算し直し、列を動かす。着手の跡がある Issue は動かさない
- 本文に、スタックの中の位置や上下の PR を書かせない

### `pecot pr cleanup`

片付けの後に、次を足す。

- この PR の Issue を前提にしている Issue の判定を計算し直し、列と札を動かす。着手の跡がある Issue は動かさない
- 判定が変わった Issue を stdout に出す

```text
Readiness changed:
- #349 blocked -> startable
- #350 blocked -> stackable on #349
```

- 上に積んだ段があるとき、その作業ディレクトリで `pecot pr restack` を打つよう案内する
- base の記録のファイルを、`.pecot-active` と一緒に消す
- 上の段のブランチは消さない

### `pecot project init`

- 進行の欄に `Blocked` が無ければ足す。既定の Status に `Needs Attention` が無ければ足す
- 既存の選択肢は `id` 付きで送り、カードの値を保つ
- 足したときは `added: option Blocked to field <name>` を出す。既にあれば `unchanged:` を出す
- 足した後、設定ファイルを同期する

### `pecot project info`

`Ready` と `Blocked` の表に、判定の列を足す。

```text
### Blocked (2)
| Ref | Title | Readiness |
|-----|-------|-----------|
| acme/app#350 | [Task] #42-21: ... | blocked by #348, #349 (not in review: #349) |

### Ready (2)
| Ref | Title | Readiness |
|-----|-------|-----------|
| acme/app#349 | [Task] #42-20: ... | stackable on #348 |
| acme/app#352 | [Task] #42-23: ... | startable |
```

- 表を出す前に、列と札を判定に合わせて直す。直した Issue は stderr に `moved: #N <元> -> <先> (<理由>)` で出す
- 同じ Epic の積める並びを、`## Stackable chains` の節に出す
- 判定の読み取りに失敗した Issue は、判定の列に `unknown (<理由>)` と出す。その Issue の列は動かさない
- 着手の跡が無い `Active`・`In Review` の Issue は、判定に合った列へ戻す
- 着手の跡がある Issue の列と札は変えない。判定が `blocked` のときは、`warning: #N is in <列> but blocked by #M` を出す
- 列を直すのは既定の動きだ。直さずに見るだけの指定は置かない。hook の確認にはかけない
- `Blocked` の値が無いボードでは、列を動かさずに `warning:` で足し方を出す
- JSON の出力の各 Issue に `readiness` を足す

### `pecot session status`

積んで着手した作業ディレクトリでは、次の節を足す。

```text
## Stack
- base: feat/registry/348 (#348, PR #361 OPEN)
- needs restack: no
- readiness: blocked by #348 (base PR was closed without merge)
```
