# Research: Issue の着手の可否の判定と stacked PRs

**Date**: 2026-11-12

調べ方は 3 つある。公式の文書、GraphQL のスキーマの読み取り、このリポの `cli-node/` のコードだ。
書き込まないと確かめられない点は R14 にまとめ、2026-11-12 に検証用のリポとボードで確かめた。
使ったのは、`pecotcraft/pecot-sandbox`・`pecotcraft/pecot-sandbox-b` と、`pecotcraft` の Project #3 だ。
結果は R14 の表に書き、分かったことを各 R の Rationale に足した。

## R1. 前提（blocked by）の読み書き

- Decision: 前提の読み書きは、すべて GraphQL で行う
  - 付けるのは `addBlockedBy`、外すのは `removeBlockedBy`、読むのは `Issue.blockedBy` だ
- Rationale:
  - `addBlockedBy(input: {issueId, blockingIssueId})` と `removeBlockedBy` が、スキーマにある。ID は node ID だ
  - `issueId` が待つ側、`blockingIssueId` が待たれる側だ。応答の payload は `issue` と `blockingIssue` だ
  - Epic #50 の試行で、GraphQL の解除は GitHub の側のエラーで 2 回失敗した
  - R14 の確かめでは、`removeBlockedBy` は同じリポの組と別のリポの組の両方で通った。Epic #50 の失敗は再現しなかった
  - 別のリポの Issue も node ID で指せる。待つ側の `blockedBy` と、待たれる側の `blocking` の両方に返る
  - 読み取りは `blockedBy(first: 50)` で足りる。GitHub の上限が、関係の種類ごとに 50 件だからだ
- Alternatives considered:
  - `gh issue edit --add-blocked-by` を子プロセスで呼ぶ案。CLI は `gh` を鍵の取得にしか使っておらず、HTTP の境界を増やすので採らない
  - 解除を REST の `DELETE /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by/{issue_id}` にする案。R14 では通った（200）
    - 採らない。パスの `issue_id` に数値の `id`（GraphQL の `databaseId`）が要り、node ID のほかに読む値が増えるからだ
    - GraphQL の解除が GitHub の側で失敗し続けるときの退路として残す

## R2. 輪の確認

- Decision: 前提を付ける前に、pecot の側で輪を確かめる
- Rationale:
  - 付ける先の Issue から `blockedBy` をたどり、付ける元の Issue に戻れば輪だ
  - R14 で確かめると、GitHub は 2 つの Issue の輪と、自分自身を指す組だけを拒んだ。3 つ以上の輪は通した
  - 拒むときの応答は HTTP 200 で、`errors[].type` が `VALIDATION` だ。文の末尾は次の 2 つだった
    - 輪: `would create a cycle where the target is already blocked by the source` を含む
    - 自分自身: `Target issue cannot be the same as the source issue`
  - GitHub に任せると 3 つ以上の輪が付くので、pecot の側の確認が要る
- Alternatives considered: GitHub の応答に任せる案。輪が付いた後では、判定がすべて「ブロック中」になるので採らない

## R3. 「済んだ前提」と「PR 中」の見分け方

- Decision: Issue の PR は、Issue にリンクしたブランチを head に持つ PR とする。閉じる参照（`closingIssuesReferences`）も合わせて読む
- Rationale:
  - pecot は、着手のたびに、Issue へリンクしたブランチを作る。ブランチ名は `<名前>/<Issue番号>` だ
  - 閉じる参照は、base が既定のブランチでない PR では作られないと文書にある。積んだ PR はこれに当たる
  - R14 で確かめると、上の段の PR の閉じる参照は、本文に `Closes #N` があっても空だった
    - 下の段のマージで base が既定のブランチに変わった後も、空のままだった
    - 下の段の PR（base が既定のブランチ）では作られた
  - `pr cleanup` は、head のブランチの番号からも Issue を見つけている。同じ決まりにそろう
  - 済んだ前提は、Issue が閉じていて、その PR がマージ済みのもの。PR 中は、Issue が開いていて、その PR が開いているもの
  - #375 で、Issue の PR を 3 つの読み口から集めることにした
    - リンクしたブランチの `ref.associatedPullRequests`
    - `closedByPullRequestsReferences(includeClosedPrs: true)`。引数を省くと open の PR しか返さない
    - `timelineItems` の `ConnectedEvent` の PR。後の `DisconnectedEvent` で外したものは除く
    - `timelineItems` の `CrossReferencedEvent` のうち、閉じる意図のある PR
    - `CrossReferencedEvent` は、本文やコメントで触れただけの PR も返す。`willCloseTarget` が真か、head のブランチ名が `/<Issue番号>` で終わるものだけ採る（#394 の F-02）
  - 積んだ上の段の PR は閉じる参照を持たず、マージの後はブランチが消える。リンクしたブランチだけでは、済んだ前提の PR を見失う
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

- Decision: `pecot pr merge` を足す。単独の PR もスタックの PR も、すべて非同期のマージ API でマージする
- Rationale:
  - 非同期の API は `PUT /repos/{owner}/{repo}/pulls/{n}/merge-async` で、結果は `GET .../merge-async/{uuid}` で読む
  - 同期の API は使わない。文書に "This endpoint does not support stacked pull requests or merging with a merge queue" とある
  - 本体の `main` には merge queue があるので、同期の API では単独の PR も通らない
  - 上の段の PR をマージすると、それより下の未マージの PR も一緒にマージされる。pecot は、最下段でない PR のマージを止める
  - base が merge queue を使うときは、マージを頼んだ PR と、その下の未マージの PR がキューに入る。上の段は入らない
    - T008 では、マージを頼んだ #11 だけがキューに入り、#12 は base が `main` に変わった
    - pecot は、キューに入ったことを伝えて終わる
  - R14 で確かめたこと
    - 同期の API（`PUT .../pulls/{n}/merge`）は、スタックの最下段でも 403 で拒んだ
      - 文は `Merging stacked PRs via this endpoint is not supported.` で、非同期の API を案内する
    - auto-merge の設定（`enablePullRequestAutoMerge`）は、下の段でも上の段でも `UNPROCESSABLE` で拒まれた
      - 文は `Auto-merge is not supported for stacked pull requests.`
      - GA の告知には「数週間かけて使えるようにする」とある。pecot は auto-merge を使わないので、影響しない
    - `merge-async` の応答は 202 と `{status: "pending", details: {uuid, ...}}` だった
      - 結果は `GET .../merge-async/{uuid}` を読み直して得る
      - `status` は `merged`・`enqueued`・`failed` のどれかで止まる。`failed` の理由は `details.message` にある
      - merge queue の無いブランチでは、5〜8 秒で `merged` になった
      - merge queue のあるブランチでは、3 秒で `enqueued` になり、58 秒後の確かめでマージ済みだった（要求 15:28:31Z、`mergedAt` 15:29:25Z）
      - `enqueued` の後のマージは、`GET .../pulls/{n}/merge` の 204 で分かる
  - 文書にある応答は、R14 では確かめていない
    - 200 は、既にマージ済みか、キューの中にあるときだ
    - 400 は、閉じている PR などのときだ
    - 409 は、同じ PR の要求が既にあるときで、既存の uuid が返る
    - uuid の結果は 24 時間で消える
  - 設計: マージの方法の渡し方は、merge queue の有無で変える
    - merge queue の無いブランチでは、`merge_method: "squash"` を渡す
      - 省くと `merge_method: "default"` になり、squash だけを許すリポでは `failed` になった
      - 文は `Merge is not an allowed merge method in this repository.`
    - merge queue のあるブランチでは、`merge_method`・`commit_title`・`commit_message`・`merge_action` を渡さない。方法はキューの設定に従う
      - 文書では、`merge_method`・`commit_title`・`commit_message` は direct merge だけに適用される。R14 で試したのは `merge_method` だけだ
      - `merge_method` を渡すと `failed` になった。文は `Custom merge params are not supported when merging via a merge queue`
      - `merge_action: "direct_merge"` は、キューを必須にした規則で `failed` になった
      - 文は `Repository rule violations found` と `Changes must be made through the merge queue`
  - 設計: merge queue の有無は、GraphQL の `PullRequest.isMergeQueueEnabled` で判定する
    - classic branch protection と ruleset の両方に適用される。`pr merge` が PR を読む問い合わせに、フィールドを 1 つ足すだけで済む
    - この記述は文書とスキーマからのもので、R14 で確かめた事実ではない
- Alternatives considered:
  - w-merge の `gh pr merge` を残す案。スタックの中の PR で必ず落ちるので採らない
  - `gh stack merge` を子プロセスで呼ぶ案。端末でないと確認なしでスタック全体をマージするので採らない
  - `GET /repos/{owner}/{repo}/rules/branches/{branch}` で判定する案。ruleset の規則しか返さず、classic branch protection で merge queue を必須にしたリポを「無い」と誤るので採らない
- Alternatives considered:
  - w-merge の `gh pr merge` を残す案。スタックの中の PR で必ず落ちるので採らない
  - `gh stack merge` を子プロセスで呼ぶ案。端末でないと確認なしでスタック全体をマージするので採らない

## R6. 下の段がマージされた後と、下の段を直した後

- Decision: `pecot pr restack` が、上の段の作業ディレクトリで git を実行する。記録した base の位置を使って載せ直す
  - `git fetch` の後、まず `git rebase --onto <新しい base> <記録した古い base の位置>` を打つ
  - 下の段のマージの後は、GitHub がリモートの上の段を先に載せ直していることがある
  - 結果が `git diff --quiet HEAD origin/<branch>` で同じ木なら、`origin/<branch>` に合わせ、push しない
  - 木が違えば、`--force-with-lease` で push する
  - 合わせた後に記録する base の位置は、`git merge-base origin/<branch> <開発ブランチ>` とする
  - 自分のブランチだけを書き換えるので、ほかの作業ディレクトリには触れない
- Rationale:
  - 下の段がマージされると、GitHub が残りのブランチを載せ直し、次の PR の base を開発ブランチに変える。手元のブランチは変わらない
  - R14 で確かめると、マージの完了の 3 秒後の読み取りで、上の段の PR の base は既に `main` だった
    - リモートの上の段のブランチは、新しいコミットへ書き換わった。親は squash のコミットで、force push と同じだ
    - 上の段の CI は、書き換わったコミットで動き直した
    - 下の段のブランチは、`delete_branch_on_merge` で消えた。スタックは、上の段が開いている間は `open: true` のままだった
  - merge queue を通ったマージでも、GitHub は上の段を載せ直した
    - PR #12 では `HeadRefForcePushedEvent` が 15:29:27Z にあり、f536d0f から 92fcdb7 に変わった
    - 新しい head の親は、#11 のマージのコミット 05c61ea だった
  - 書き換わったコミットは、`verification.verified` が false で、`reason` は `unsigned`、committer は利用者だった
    - 公式文書（stacked PRs の Rebasing の節）は "Rebasing the stack generates signed commits." と書く。実物は文書と食い違う
    - 署名を必須にした規則のあるリポでは、リモートに合わせる形が、署名の無いコミットをそのまま残す。規則に止められるかは未確認だ
  - 手元は、`git rebase --onto` で載せ直せる。squash の後でも、下の段のコミットが落ちる
    - R14 で確かめると、載せ直した後の差分は上の段の変更だけで、木はリモートの上の段と同じだった。SHA はコミットの日時で違った
    - 木が同じなのに push すると、GitHub が書き換えたコミットを、木の同じ別のコミットで置き換えることになる
    - 置き換えると CI が動き直すだけで害は無いが、リモートに合わせれば、その push が要らない
  - 未 push のコミットの有無は判定に使わない。`git fetch` の後は `origin/<branch>` が書き換わった SHA に動き、手元の HEAD と比べられないからだ
  - 古い base の位置は、作業ディレクトリごとの状態のファイルに記録する。着手のときと、載せ直しのたびに書く
- Alternatives considered:
  - `gh stack rebase` と `gh stack sync` を使う案。段ごとの作業ディレクトリにも対応しているが、採らない。対象の作業ディレクトリに未コミットの変更があると全体が止まり、無関係な重複のチェックアウトで失敗する報告もある
  - 記録を持たず、`--fork-point` に任せる案。reflog が無い作業ディレクトリで外れるので採らない
  - push していないコミットの有無で分ける案。reflog を頼りにして `--fork-point` と同じ弱さが出るので採らない
- Alternatives considered:
  - `gh stack rebase` と `gh stack sync` を使う案。段ごとの作業ディレクトリにも対応しているが、採らない。対象の作業ディレクトリに未コミットの変更があると全体が止まり、無関係な重複のチェックアウトで失敗する報告もある
  - 記録を持たず、`--fork-point` に任せる案。reflog が無い作業ディレクトリで外れるので採らない

## R7. 積んだ PR と Issue のクローズ

- Decision: Issue を閉じるのは、今までどおり `pecot pr cleanup` にする
- Rationale:
  - `pr cleanup` は、閉じる参照・本文のキーワード・head のブランチの番号から Issue を見つけ、API で閉じる
  - 閉じるキーワードが積んだ PR で働くかどうかは、公式の記述が無い。働いた実例はあるが、保証は無い
  - R14 の確かめでは、base が開発ブランチに変わった後のマージで、本文の `Closes #N` の Issue が閉じた（`ClosedEvent.closer` がその PR）。閉じる参照は空のままだった
  - pecot は GitHub の自動のクローズに頼らないので、どちらでも結果は同じだ
- Alternatives considered: GitHub の自動のクローズに任せる案。保証が無いので採らない

## R8. ボードの値の追加

- Decision: 既にあるフィールドへ値を足す処理を 1 つ作る。`pecot project init` がそれを使う
- Rationale:
  - `updateProjectV2Field` の `singleSelectOptions` は、選択肢の全体を置き換える。既存の選択肢を `id` 付きで並べ直し、新しい選択肢を `id` 無しで差し込む
  - `id` を落とすと、選択肢が作り直され、カードの値が消える
  - 選択肢の入力（`ProjectV2SingleSelectFieldOptionInput`）は、`name`・`color`・`description` が必須だ
    - 既存の選択肢は、`options { id name color description }` で読んだ値をそのまま送る
  - R14 で確かめると、既存の選択肢の `id` とカードの値は保たれた。選択肢は渡した順に並んだ
    - 既定の Status の Done の `id` も変わらず、既定の自動化（Item closed・Pull request merged）は札を Done に動かした
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

- Decision: 列は、pecot の操作と、`pecot board sync` の 2 つで動かす。`pecot board sync` は手元でも GitHub Actions のワークフローからも打てる。ワークフローは任意の打ち手の 1 つだ。一覧を出す操作は列を直さない。Projects の組み込みの Workflows は使わない
- Rationale:
  - Projects の組み込みの Workflows は、そのカード自身の出来事で、そのカード自身の既定の Status を書き換えるだけだ。ほかの Issue の状態と blocked by を条件にできない。進行の欄を動かすこともできない
  - GitHub Actions なら pecot の判定を動かせる。ただし、組織のボードへ書くには GitHub App か PAT の token が要る。Actions の標準のトークンは、組織のボードに書けない
  - private のリポでは Actions の実行に費用がかかる。直す処理をコマンドに置けば、Actions が無くても手元で直せる（2026-11-13 にユーザーが決定）
  - 依存の変更（`issue_dependencies`）とカードの移動（`projects_v2_item`）は webhook だけで、Actions の契機に無い（GitHub の公式文書で確認した）。この 2 つは、`schedule` を有効にするか、手元で `board_sync` を打って直す
  - 列がずれていても、着手の操作は判定を計算し直す。害は、ブラウザのボードが古く見えることだけだ
  - 一覧は判定を出すので、エージェントは列でなく判定で着手の対象を選べる
- Alternatives considered:
  - 一覧を出す操作が列を直す案。前提のある Issue が増えると、毎回の読み取りが点数を食うので採らない（2026-11-13 にユーザーが決定）
  - webhook を外で受けて中継する案。受け口の運用を利用者に求めるので採らない

## R11. 列を直す処理の置き場

- Decision: 列を直す判断は domain の純粋な関数 1 つに置く。列を動かす各コマンドと、`pecot board sync` がそれを呼ぶ
- Rationale:
  - 入力は、Issue の今の列・着手の判定・着手の跡の有無で、出力は動かす先の列だ。GitHub を呼ばないので、表で網羅してテストできる
  - 規則を 1 か所に置くと、操作のその場の移動と、`pecot board sync` の直しが食い違わない
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

実装の最初の段（#374）で、検証用のリポとボードを使って確かめた。外れた点は、設計を直した。

| 確かめること | 見込み | 外れたとき | 結果 | 確かめた日 |
|---|---|---|---|---|
| 既定の Status に、API で選択肢を足せる | 足せる。型は進行の欄と同じだ | `Needs Attention` の追加を、画面で足す手順の案内に変える | 見込みどおり。`updateProjectV2Field` が 200 を返し、既存の 3 つの `id` と札の値が保たれた | 2026-11-12 |
| 既定の Status に選択肢を足した後も、既定の自動化が動く | 動く。既存の `id` を保つからだ | 上と同じ | 見込みどおり。足した後に PR をマージすると、マージの 9 秒後に読むと、Issue と PR の札が Done になっていた | 2026-11-12 |
| 選択肢の並びが、渡した順になる | なる | `Blocked` が末尾に来る。列の並べ替えを手順に書く | API の `options` の順は渡した順で、`Blocked` が `Backlog` と `Ready` の間に並んだ（見込みどおり）。ボードの画面の列の順は未確認 | 2026-11-12 |
| 別のリポの Issue を、API で blocked by に指せる | 指せる。Epic #50 で画面から通っている | 別のリポの前提を、付けられない旨のエラーにする | 見込みどおり。`addBlockedBy` が 200 を返し、`blockedBy` と `blocking` の両方に返った。`removeBlockedBy` でも、REST の DELETE でも外せた（200） | 2026-11-12 |
| GitHub が輪を拒むか | 分からない | R2 のとおり pecot が先に確かめるので、影響しない | 見込みなし。一部だけ拒む。2 つの輪と自分自身は `VALIDATION` で拒み、3 つの輪は通した（R2） | 2026-11-12 |
| 積んだ PR で、閉じる参照が作られるか | 分からない | R3 のとおりリンクしたブランチで見分けるので、影響しない | 見込みなし。作られない。base が `main` に変わった後も空だった。閉じるキーワードはマージで働いた（R3・R7） | 2026-11-12 |
| 下の段のマージの後、手元の載せ直しが R6 の手順で通る | 通る | 記録する位置を、GitHub が載せ直した後の位置に変える | 見込みどおり。差分は上の段の変更だけで、木はリモートの上の段と同じだった。GitHub がリモートを先に載せ直すので、R6 に手元をリモートに合わせる形を足した（R6） | 2026-11-12 |
| 非同期のマージ API が、merge queue のあるブランチでキューに入れる | 入れる | キューに入れる操作を別に呼ぶ | 見込みどおり。ただし `merge_method` を渡さないときだけで、渡すと `failed` になる（R5） | 2026-11-12 |
| マージでブランチが消えた後も、Issue の PR を読める | 分からない | 閉じる参照とタイムラインからも PR を集める（R3） | 見込みなし。リンクしたブランチは一覧から消えた（#7 の `linkedBranches` が空）。PR #9（merged）は、閉じる参照とタイムラインの両方から読めた（#375） | 2026-11-12 |

検証用のリポの設定は、本体の `main` の ruleset を写した。違いは次のとおり。

- code scanning（CodeQL）の規則と、bypass の Integration は写していない
- merge queue の規則は、R14 の表の 1〜7 行目を確かめた後に足した。1〜7 行目は merge queue の無いブランチで確かめた
  - merge queue を通ったマージでも、上の段は載せ直された（R6）
- 必須チェックの `ci-result` と `version-plan` は、成功するだけの job で満たした

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
