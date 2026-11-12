# Research: Issue の着手の可否の判定と stacked PRs

**Date**: 2026-11-12

調べ方は 3 つある。公式の文書、GraphQL のスキーマの読み取り、このリポの `cli-node/` のコードだ。
GitHub への書き込みは行っていない。書き込まないと確かめられない点は、R14 にまとめ、実装の最初の段で確かめる。

## R1. 前提（blocked by）の読み書き

- Decision: 付けるのは GraphQL の `addBlockedBy`、外すのは REST の DELETE、読むのは GraphQL の `Issue.blockedBy` にする
- Rationale:
  - `addBlockedBy(input: {issueId, blockingIssueId})` と `removeBlockedBy` が、スキーマにある。ID は node ID だ
  - Epic #50 の試行で、GraphQL の解除は GitHub の側のエラーで 2 回失敗した。REST の `DELETE /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by/{issue_id}` は通った
  - REST の `issue_id` は Issue の数値の `id`（GraphQL の `databaseId`）で、番号ではない
  - 読み取りは `blockedBy(first: 50)` で足りる。GitHub の上限が、関係の種類ごとに 50 件だからだ
- Alternatives considered:
  - `gh issue edit --add-blocked-by` を子プロセスで呼ぶ案。CLI は `gh` を鍵の取得にしか使っておらず、HTTP の境界を増やすので採らない
  - 解除も GraphQL にする案。失敗の記録があるので採らない。R14 で通ることを確かめられたら、後で揃えられる

## R2. 輪の確認

- Decision: 前提を付ける前に、pecot の側で輪を確かめる
- Rationale: GitHub が輪を拒むかどうかは、文書に無い。拒まれたときの応答も分からない。付ける先の Issue から `blockedBy` をたどり、付ける元の Issue に戻れば輪だ
- Alternatives considered: GitHub の応答に任せる案。輪が付いた後では、判定がすべて「ブロック中」になるので採らない

## R3. 「済んだ前提」と「PR 中」の見分け方

- Decision: Issue の PR は、Issue にリンクしたブランチを head に持つ PR とする。閉じる参照（`closingIssuesReferences`）も合わせて読む
- Rationale:
  - pecot は、着手のたびに、Issue へリンクしたブランチを作る。ブランチ名は `<名前>/<Issue番号>` だ
  - 閉じる参照は、base が既定のブランチでない PR では作られないと文書にある。積んだ PR はこれに当たる
  - `pr cleanup` は、head のブランチの番号からも Issue を見つけている。同じ決まりにそろう
  - 済んだ前提は、Issue が閉じていて、その PR がマージ済みのもの。PR 中は、Issue が開いていて、その PR が開いているもの
- Alternatives considered:
  - 閉じる参照だけで見分ける案。積んだ PR で空になるおそれがあるので採らない
  - Issue のタイムラインの `ClosedEvent.closer` を読む案。`pr cleanup` は API で Issue を閉じるので、closer が PR にならない

## R4. スタックの登録

- Decision: REST の Stacks API を CLI から直接呼ぶ。`gh stack` 拡張には依存しない
- Rationale:
  - `POST /repos/{owner}/{repo}/stacks` に PR 番号を下から順に渡すと、スタックができる。2 件から 100 件まで渡せる
  - `POST /repos/{owner}/{repo}/stacks/{n}/add` で、既にあるスタックの上に足せる
  - `GET /repos/{owner}/{repo}/stacks?pull_request=N` で、PR が入っているスタックを読める
  - 各 PR の base は、1 つ下の PR の head と同じでなければならない。pecot は PR を作るときに base をそろえる
  - CLI は GitHub を `fetch` で直接呼ぶ作りで、拡張の有無を確かめる処理が要らなくなる
- Alternatives considered:
  - `gh stack link` を子プロセスで呼ぶ案。拡張の導入を利用者に求め、版の違いも受けるので採らない
  - `gh stack submit` を使う案。手元の追跡のファイル（`.git/gh-stack`）を作り、`git rerere` の設定も変えるので採らない

spec の FR-041 と User Story 4 の受け入れシナリオ 6 は、拡張が無い環境で止まると書いていた。この決定で、拡張が無くても動く形に直す。

## R5. スタックのマージ

- Decision: `pecot pr merge` を足す。スタックの中の PR は非同期のマージ API で、単独の PR は今までの API でマージする
- Rationale:
  - スタックの中の PR は、今までのマージ API では拒まれる。`gh pr merge` は最下段でも通らない
  - 非同期の API は `PUT /repos/{owner}/{repo}/pulls/{n}/merge-async` で、結果は `GET .../merge-async/{uuid}` で読む
  - 上の段の PR をマージすると、それより下の未マージの PR も一緒にマージされる。pecot は、最下段でない PR のマージを止める
  - base が merge queue を使うときは、スタックはキューに入る。pecot は、キューに入ったことを伝えて終わる
  - スタックの中の PR には、auto-merge が使えない
- Alternatives considered:
  - w-merge の `gh pr merge` を残す案。スタックの中の PR で必ず落ちるので採らない
  - `gh stack merge` を子プロセスで呼ぶ案。端末でないと確認なしでスタック全体をマージするので採らない

## R6. 下の段がマージされた後と、下の段を直した後

- Decision: 積み直しは、上の段の作業ディレクトリで素の git を使う。`pecot pr restack` が、記録した base の位置を使って載せ直す
- Rationale:
  - 下の段がマージされると、GitHub が残りのブランチを載せ直し、次の PR の base を開発ブランチに変える。手元のブランチは変わらない
  - 手元は `git fetch` の後、`git rebase --onto <新しい base> <記録した古い base の位置>` で載せ直せる。squash の後でも、下の段のコミットが落ちる
  - 古い base の位置は、作業ディレクトリごとの状態のファイルに記録する。着手のときと、載せ直しのたびに書く
  - 自分のブランチだけを書き換えるので、ほかの作業ディレクトリには触れない
  - push は `--force-with-lease` を使う
- Alternatives considered:
  - `gh stack rebase` と `gh stack sync` を使う案。段ごとの作業ディレクトリにも対応しているが、採らない。対象の作業ディレクトリに未コミットの変更があると全体が止まり、無関係な重複のチェックアウトで失敗する報告もある
  - 記録を持たず、`--fork-point` に任せる案。reflog が無い作業ディレクトリで外れるので採らない

## R7. 積んだ PR と Issue のクローズ

- Decision: Issue を閉じるのは、今までどおり `pecot pr cleanup` にする
- Rationale:
  - `pr cleanup` は、閉じる参照・本文のキーワード・head のブランチの番号から Issue を見つけ、API で閉じる
  - 閉じるキーワードが積んだ PR で働くかどうかは、公式の記述が無い。働いた実例はあるが、保証は無い
  - pecot は GitHub の自動のクローズに頼らないので、どちらでも結果は同じだ
- Alternatives considered: GitHub の自動のクローズに任せる案。保証が無いので採らない

## R8. ボードの値の追加

- Decision: 既にあるフィールドへ値を足す処理を 1 つ作る。`pecot project init` がそれを使う
- Rationale:
  - `updateProjectV2Field` の `singleSelectOptions` は、選択肢の全体を置き換える。既存の選択肢を `id` 付きで並べ直し、新しい選択肢を `id` 無しで差し込む
  - `id` を落とすと、選択肢が作り直され、カードの値が消える
  - 今の `project init` は、名前の同じフィールドがあると何もしない。値を足せない
  - 進行の欄には `Blocked` を、`Backlog` と `Ready` の間に差し込む。既定の Status には `Needs Attention` を末尾に足す
  - spec 023 が計画している待ちの値の追加と同じ処理だ。どちらが先に入っても、後から入るほうが使う
- Alternatives considered: 利用者に画面で足してもらう案。値の名前の打ち間違いが起き、設定ファイルとの同期が手作業になるので採らない

## R9. 値が足りないボードの扱い

- Decision: 進行の欄に `Blocked` が無いボードでも、設定の読み込みを通す
- Rationale:
  - 今の `validateWorkflowField` は、決まった 6 つの値のどれかが無いと exit 1 で止まる。`Blocked` を決まった値に足すと、既存のボードがすべて止まる
  - `Blocked` と `Needs Attention` は「あれば使う値」として扱い、無いときは列を動かさずに足し方を案内する
- Alternatives considered: 無ければ止める案。版を上げただけで全コマンドが動かなくなるので採らない

## R10. 列を動かす仕組み

- Decision: 列は、pecot の操作と、一覧を出す操作の 2 つで動かす。GitHub Actions のワークフローと、Projects の組み込みの Workflows は使わない
- Rationale:
  - Projects の組み込みの Workflows は、そのカード自身の出来事で、そのカード自身の既定の Status を書き換えるだけだ。ほかの Issue の状態と blocked by を条件にできない。進行の欄を動かすこともできない
  - GitHub Actions なら pecot の判定を動かせる。ただし、組織のボードへ書くには GitHub App の鍵が要る。Actions の標準のトークンは、組織のボードに書けない
  - 依存の変更（`issue_dependencies`）とカードの移動（`projects_v2_item`）は webhook だけで、Actions の契機に無い。Actions を入れても、この 2 つは定期の実行でしか拾えない
  - 列がずれていても、着手の操作は判定を計算し直す。害は、ブラウザのボードが古く見えることだけだ
  - w-active は最初に一覧を出すので、エージェントが着手の対象を選ぶ時点では列が合っている
- Alternatives considered:
  - GitHub Actions のワークフローを配る案。鍵の用意に見合う利得が小さいので、今回は採らない（2026-11-12 にユーザーが決定）。必要になれば別の Epic で足す
  - webhook を外で受けて中継する案。受け口の運用を利用者に求めるので採らない

## R11. 列を直す処理の置き場

- Decision: 列を直す判断は domain の純粋な関数 1 つに置く。`pecot project info` と、列を動かす各コマンドがそれを呼ぶ
- Rationale:
  - 入力は、Issue の今の列・着手の判定・着手の跡の有無で、出力は動かす先の列だ。GitHub を呼ばないので、表で網羅してテストできる
  - 規則を 1 か所に置くと、操作のその場の移動と、一覧のときの直しが食い違わない
- Alternatives considered: 各コマンドが自分の移動を書く案。規則が 5 か所に散るので採らない

## R12. tasks.md の前提の表と、Issue の本文の形

- Decision: 前提の表は 4 列にする。Issue ファイルの前提は frontmatter に書き、マージを待つ前提の節は CLI が本文に足す
- Rationale:
  - 表の形は [contracts/prerequisite-table.md](contracts/prerequisite-table.md) に決める。列は `Phase`・`前提`・`種類`・`理由` で、1 行が 1 組だ
  - Issue のテンプレートは、テンプレートにある見出しをすべて必須として扱う。任意の節をテンプレートに置けない
  - テンプレートに無い見出しは、Issue の本文に足してよい
  - CLI が足す形なら、書式がそろい、後で読み戻せる。エージェントは節を手で書かない
  - 節の見出しは `## Waits for merge` とする。既存の見出し（Goal・Tasks・Acceptance・Artifacts）が英語だからだ
- Alternatives considered:
  - 節を必須の見出しにして、無いときは「なし」と書く案。前提の無い Issue にも節が出るので採らない
  - 種類をラベルで持つ案。前提ごとの理由を持てないので採らない

## R13. タイトルの通し番号

- Decision: frontmatter の `order` を省くと、CLI が次の番号を振る。`parallel` は受け付けない
- Rationale:
  - 既存のサブタスクのタイトルから `#<epic>-<番号><枝>:` を読み、番号の最大の次から、ファイルの順に振る。枝の文字は無視する
  - 今の重複の確認は、親のサブタスクを先頭の 20 件しか読まない。全件を読むように直す
  - `order` を書いたときは、その番号を使う。w-ready が 1 件だけ作るときの動きは変わらない
  - `parallel` を書いたファイルは、使えなくなった旨と直し方を出して止める
- Alternatives considered: `order` を必須のまま残す案。エージェントが続番を数える手順が残るので採らない

## R14. 書き込まないと確かめられない点

実装の最初の段で、検証用のリポとボードを使って確かめる。結果が下の「外れたとき」に当たれば、その段で設計を直す。

| 確かめること | 見込み | 外れたとき |
|---|---|---|
| 既定の Status に、API で選択肢を足せる | 足せる。型は進行の欄と同じだ | `Needs Attention` の追加を、画面で足す手順の案内に変える |
| 既定の Status に選択肢を足した後も、既定の自動化が動く | 動く。既存の `id` を保つからだ | 上と同じ |
| 選択肢の並びが、渡した順になる | なる | `Blocked` が末尾に来る。列の並べ替えを手順に書く |
| 別のリポの Issue を、API で blocked by に指せる | 指せる。Epic #50 で画面から通っている | 別のリポの前提を、付けられない旨のエラーにする |
| GitHub が輪を拒むか | 分からない | R2 のとおり pecot が先に確かめるので、影響しない |
| 積んだ PR で、閉じる参照が作られるか | 分からない | R3 のとおりリンクしたブランチで見分けるので、影響しない |
| 下の段のマージの後、手元の載せ直しが R6 の手順で通る | 通る | 記録する位置を、GitHub が載せ直した後の位置に変える |
| 非同期のマージ API が、merge queue のあるブランチでキューに入れる | 入れる | キューに入れる操作を別に呼ぶ |

## R15. ほかの Epic との順番

- Decision: 実装は Epic #42 の Python の削除（#351）の後に置く。パスは移動の後の `plugins/pecot-workflow/cli/` で書く
- Rationale:
  - 今は、Node のクエリが Python の定義と一致することを確かめるテストがある。新しいクエリを足すと落ちる
  - spec 020 の T080 が `cli-node/` を `cli/` に移す。テンプレートの置き場（`cli/templates/`）は変わらない
  - コマンドの数（34）を固定しているテストが 5 か所ある。#42 の切り替えの後なら、直す場所が Node だけになる
- Alternatives considered: 今の `cli-node/` に入れる案。Python にも同じ変更が要るので採らない

spec 023 との関係は次のとおり。

- spec 023 の計画は Python の CLI を前提に書かれている。実装のときに Node へ置き換えることになる
- 値を足す処理（R8）は、先に入るほうが作る
- 待ちの値の名前は `Needs Attention` にそろえる。spec 023 の文書の `Waiting` は、この機能の最後の段で直す
- spec 023 は「進行の欄に値を足すと、既存のボードの移行に広がる」として列の追加を避けていた。この機能は R8 と R9 で移行を扱う

## R16. hook

- Decision: エージェントが `gh stack` を直接打つことを、Bash 用の hook で止める。pecot の `pr merge` は、MCP 用の hook で確認にかける
- Rationale:
  - 今の hook は `gh pr create` を止め、`gh pr merge` を確認にかける。`gh stack submit` と `gh stack merge` は、どちらにも当たらずに通る
  - `gh stack` は手元の追跡のファイルを作り、pecot の記録と食い違う
  - Epic #42 の切り替えの後、pecot の投稿の確認は MCP 用の `pecot-post-ask.sh` に移る。Bash 用の `external-post-check.sh` からは、pecot の判定が外れる（spec 020 の T059）
  - `issue block`・`issue unblock`・`pr restack` は確認にかけない。利用者が前提の見直しを決めた後に打つコマンドだからだ
- Alternatives considered: 何も足さない案。PR の作成とマージが pecot を通らなくなり、列が動かないので採らない
