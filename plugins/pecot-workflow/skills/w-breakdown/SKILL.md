---
name: w-breakdown
description: |
  Epicをspeckitフローでサブタスクに分解します。
  Use when the user has an Epic and wants to break it down via the speckit workflow (specify → clarify → plan → tasks). Runs the speckit workflow (specify → clarify → plan → tasks) directly.
  Do NOT use for simple subtask creation (use w-ready), batch conversion (use w-issueize), or new Epics (use w-backlog).
when_to_use: "Epic をサブタスクに分解したい、speckit で計画を立てたい"
---

# Epic分解：speckit 工程の逐次実行

Epic の内容を読み取り、main が speckit コマンド（specify → clarify → plan → tasks）を
逐次実行して分解する。speckit の成果物（ブランチ・`.specify/` 配下のファイル）は
**w-breakdown を実行したリポジトリ** に作成する。ただし `board_show` の結果の `stdout` に表示
される **ロードマップリポ** が設定されている場合、そのロードマップリポでのみ実行を許可
する。ロードマップリポ設定があるのに別リポで起動された場合は中止し、ロードマップリポでの
再実行を案内する。

各工程の間で main は AskUserQuestion でユーザー承認を取り、承認を得てから次工程へ進む。

## 手順

### Step 1: ボードを確認する

`board_show` を引数なしで呼ぶ。

### Step 2: 成果物作成先の決定（ロードマップリポチェック）

Step 1 の `board_show` の結果の `stdout` にある `Roadmap repo: ...` 行と CWD のリポを比べる。

CWD のリポを取得:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

`gh repo view` が失敗した場合（GitHub remote 未設定など）は、CWD のリポを自動判定できないとユーザーに伝え、現在地が想定リポか AskUserQuestion で確認する。

判定:

- **`Roadmap repo: none`** → CWD のリポで成果物を作る前提で進む
- **`Roadmap repo: <owner/repo>`** かつ **CWD == その値** → そのまま進む
- **`Roadmap repo: <owner/repo>`** かつ **CWD が異なる** → 中止し、次の文をユーザーに案内する

  > このプロジェクトではロードマップリポ `<owner/repo>` が設定されている。
  > w-breakdown はロードマップリポでのみ実行できる。`<owner/repo>` のワークツリーで再実行すること。

### Step 3: 対象Epicを特定

ユーザーの指示から対象Epicを特定する。Epic番号・タイトル指定なら直接使用、不明な場合は AskUserQuestion で Backlog 内の Epic を選択させる。`issue_show` を `issue_ref: "owner/repo/XXX"` で呼ぶ。

`owner/repo` は Epic Issue が置かれているリポ。speckit 成果物の作成先は Step 2 で確定済。

### Step 4: speckit 工程の準備

Epic の番号・タイトル・本文・背景を読み取り、specify への入力として main 自身が整理する。
工程ごとの責任者（spec / plan / tasks）は担当工程の概念として存在するが、本 single フローでは
main がそれぞれの責任者役を担って各コマンドを実行する。

整理する情報:

- Epic 番号（`#NNN`）
- 目的・スコープ
- 要件（Issue 本文から抽出）
- 背景情報（親 Epic や関連 Issue の内容）

### Step 5: specify 実行

main が `/speckit.specify` を実行する。Epic の内容から目的・スコープ・要件・背景情報・
Epic 番号を抽出し、`/speckit.specify` の引数として渡す。

実行後、AskUserQuestion でユーザー承認を取る（「次に進む」「修正を指示する」「やり直す」）。

### Step 6: clarify → plan を逐次実行

main が各工程を順に実行する。各工程完了後に AskUserQuestion で以下の承認 3 択を提示し、
承認を得たら次工程へ進む。前工程の承認を得るまでは、次工程へ進まない。

| 選択 | 意味 |
|------|------|
| 次に進む | 次工程へ |
| 修正を指示する | main が修正内容を指定して再実行 |
| やり直す | 工程を最初からやり直す |

工程の順序: `/speckit.clarify` → `/speckit.plan`

plan の承認を得たら、Step 7 へ進む。

### Step 7: tasks 実行

main が `/speckit.tasks` を実行する。引数には、次のコードブロックの中身をそのまま貼る。言い換えない。要約もしない。
spec-kit のテンプレートは変えない。前提の表の形は、この引数で渡す。

```text
tasks.md の `## Dependencies & Execution Order` の下にある `### Phase Dependencies` に、フェーズの前提を次の 4 列の表で書く。

| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | 積める | Phase 2 の処理が、Phase 1 で足す設定のキーを読む |
| 3 | 2 | マージを待つ | Phase 3 の確認に、既定のブランチから配られる action を使う |

上の 2 行は書き方の例だ。tasks.md には写さず、この機能のフェーズの前提を書く。

書き方の決まり:
- 1 行が、フェーズと前提の 1 組だ。前提が 2 つあるフェーズは 2 行になる
- 前提の無いフェーズは、表に書かない
- `Phase` と `前提` には、フェーズの番号だけを書く
- `種類` には「積める」か「マージを待つ」のどちらかを書く
- `理由` は、すべての行に書く。「マージを待つ」の行には、開発ブランチに入っていないと進められない訳を書く
- 前提にするのは、フェーズ全体の着手を止める依存だけだ。一部のタスクだけが待つ依存は、タスクの行に注記で書く
- 直接の前提だけを書く。Phase 3 が 2 を待ち、2 が 1 を待つとき、Phase 3 の行に 1 は書かない

種類は、次の 2 つの問いで決める。開発ブランチは、フェーズの PR のマージ先のブランチだ:
- 前提の変更が手元のブランチの下にあれば、このフェーズの実装と確認ができる。このときは「積める」
- 前提の変更が開発ブランチに入っていないと、このフェーズの実装か確認ができない。このときは「マージを待つ」

「マージを待つ」になる例:
- 既定のブランチから配られるものを使う（プラグイン・action・公開したパッケージ）
- リリースの後の実物で確かめる
- 開発ブランチの CI やリリースのワークフローが、前提の変更を使う

ほかの決まり:
- テンプレートにある `### Phase Dependencies` の箇条書きは残さない。この表に置き換える
- `### Phase Dependencies` の見出しが無ければ、`## Dependencies & Execution Order` の下に作る
- 最後のフェーズにも番号を振る。「Final Phase」や `Phase N` のままにしない
- 前提を持つフェーズが 1 つも無いときは、見出しの行と区切りの行だけの表を書く
```

### Step 8: 前提の表を確かめる

main が、できた tasks.md の `### Phase Dependencies` を読み、次の 4 つを確かめる。

1. `| Phase | 前提 | 種類 | 理由 |` の 4 列の表がある
2. `Phase` と `前提` が数字だけで、どれも tasks.md のフェーズの見出し（`## Phase <番号>:`）にある
3. `種類` の値が、どの行も「積める」か「マージを待つ」
4. すべての行に `理由` がある

見出しの行と区切りの行だけの表は、前提を持つフェーズが無い表として通す。

通らないときの扱いは、確かめで分かれる。tasks の工程をやり直すものと、ユーザーに確かめるものがある。

1〜3 が通らないときと、積める行の理由が空のときは、tasks の工程（Step 7）をやり直す。やり直すときは、Step 7 のコードブロックをもう一度そのまま貼り、その後ろに、通らなかった確かめと箇所を 1 行足して `/speckit.tasks` を実行する。やり直しは 1 回まで。やり直しても通らないときは、外れた箇所をユーザーに示して判断を仰ぐ。

「マージを待つ」の行の理由が空のときは、開発ブランチに入っていないと進められない訳をユーザーに確かめる。エージェントが理由を作らない。ユーザーが答えた文を、main がその行の `理由` のセルにそのまま書く。tasks の工程はやり直さない。やり直しの回数に数えない。tasks の工程をやり直したときは、やり直した後の表でこの確かめをする。

確かめが通ったら、AskUserQuestion で Step 6 と同じ承認 3 択（次に進む・修正を指示する・やり直す）を提示する。
「修正を指示する」「やり直す」で tasks の工程をもう一度実行するときも、Step 7 のコードブロックをもう一度そのまま貼る。「修正を指示する」なら、その後ろに直す点を足す。実行した後は、この Step の確かめからやり直す。

analyze（`/speckit.analyze`）は読み取り専用工程のため任意。成果物の確認・検証が要るときに実行する。

tasks.md 完成後は `/pecot-w:w-issueize` で各フェーズを Issue として一括登録できる。
