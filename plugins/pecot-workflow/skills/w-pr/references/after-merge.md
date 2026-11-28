# マージされた後の片付け

PR がマージされた後に、手元を片付ける手順。Epic と後続の Issue へのコメントは、セッションでは書かない。引き継ぎのワークフロー（`pecot-handoff.yml`）が書く。
GitHub 側の片付けも、セッションでは行わない。閉じる Issue を閉じて待つ Issue の列を動かすのは、マージで動く `pecot-board-sync.yml` だ。マージした PR の head ブランチは、リポの「head ブランチを自動で消す」の設定で GitHub が消す。

次の場面で使う。どのスキルも、同じ中身の写しを自分の `references/after-merge.md` に持つ。

- w-pr の Step 6 で、待ち受けが `MERGED` を受けたとき
- w-active・w-quick・w-breakdown で、`session_start` の結果に `leftovers` があったとき。前の PR の手元の片付けが残っている

## 片付け

1. pecot-workflow の MCP ツール `session_show` を呼び、結果の `baseBranch` と `worktree` を控える。この後の「ワークツリー環境での手作業」で使う
2. 公式の MCP で、片付けの判定に要るものを読む
   - マージした PR を `pull_request_read`（`get`）で読む
   - PR が閉じる Issue を求める。本文の閉じるキーワード（`Closes #N` など）の Issue と、head ブランチの名前の末尾の `/<番号>` の Issue だ
   - 閉じる Issue ごとに、それを待つ Issue を `issue_dependency_read`（`get_blocking`）で読む
   - 待つ Issue のうち開いたものごとに、`issue_read`（`get`）と `issue_dependency_read`（`get_blocked_by`）で、その Issue と前提を読む
   - head ブランチの上にスタックした PR を、`list_pull_requests`（`base` に head ブランチ、`state: open`）で読む
3. pecot-workflow の MCP ツール `session_finish` に、`pr_ref: "<owner>/<repo>/<番号>"` と、読んだ結果（`reads`）を渡して、手元を片付ける

警告が出たら、その文に従って手で対応する。ワークツリー環境の手順は、この後の [ワークツリー環境での手作業](#ワークツリー環境での手作業) にある。

結果に判定の変化（`readinessChanges`）があれば、着手できるようになった Issue を利用者に伝える。
子ブランチ（`restack`）があれば、そのブランチの作業ディレクトリでスタックし直しが要ることを利用者に伝える。ほかの作業ディレクトリには入らない。

## ワークツリー環境での手作業

手元の片付けは `session_finish` が行う。この節は、`session_finish` の手元の片付けが警告で止まったときのためのものだ。

### ワークツリー判定

ワークツリー環境かどうかを判定し、処理を分岐する。

```bash
# ワークツリーかどうか確認（git worktree listの結果を変数に格納して判定）
git worktree list
# 出力から現在のディレクトリがワークツリーかを判断

# wtX ブランチが存在するか確認
git branch
# wt1, wt2, wt3などのwtX形式のブランチがあるか確認
```

ワークツリー環境の条件は次の 2 つ。

1. `git worktree list`で現在のディレクトリがワークツリーとして表示される
2. `wt1`、`wt2`などの`wtX`形式のブランチが存在する

以下で「開発ブランチ」と書く箇所は、config から決まる。
2ブランチモードでは config の `develop_branch`（例: `develop`）、単一ブランチモード（`develop` == `release` / trunk-based）では `main`。
どちらのモードでも、片付けの手順 1 で控えた `session_show` の `baseBranch` から求められる。
先頭の remote の名前と `/` を除いたブランチ（`origin/main` なら `main`）が開発ブランチだ。

### 通常環境（ワークツリー未使用）

デフォルトブランチ（控えた `baseBranch` から、先頭の remote の名前と `/` を除いたブランチ。`origin/main` なら `main`）に切り替え:

```bash
# デフォルトブランチに切り替え（開発ブランチ または main）
git checkout <デフォルトブランチ>
git pull <remote> <デフォルトブランチ>  # remote は origin、無ければ最初の remote
git branch -D <マージしたブランチ>
```

### ワークツリー環境

ワークツリー環境では、現在のワークツリー内で処理を完結させる。
mainワークツリーへの移動や更新は**不要**。

ワークツリー専用ブランチに切り替えて、`git pull`で開発ブランチと同期:

```bash
# 1. ワークツリー専用ブランチに切り替え
#    控えた session_show の `worktree.directoryName` の値を使用
#    例: wt1, wt2, wt3
git checkout <worktree.directoryName の値>

# 2. git pullで開発ブランチをマージ
git pull <remote> <開発ブランチ>  # remote は origin、無ければ最初の remote

# 3. マージしたローカルブランチを削除
git branch -D <マージしたブランチ>
```

リモートのブランチは消さない。リポの「head ブランチを自動で消す」の設定が無ければ、GitHub の画面で消す。

**禁止事項**:

- `cd`コマンドでmainワークツリーや他のワークツリーに移動しない
- mainワークツリーのブランチを更新しない
- 各ワークツリーは独立して動作する

**理由**:

- ワークツリーでは開発ブランチ（単一ブランチモードなら`main`、2ブランチモードなら`develop_branch` の値）に切り替えると、他のワークツリーと競合する
- ワークツリー専用ブランチ（wt1, wt2等）をベースとして使い、`git pull`で最新を維持する
- mainワークツリーを更新したいときは、個別に更新すればよい

**注意事項**:

- mainブランチからPRを作成しようとしている場合は警告してブランチ作成を提案
- ワークツリー環境では`wtX`ブランチを削除しないこと（ベースブランチ）
