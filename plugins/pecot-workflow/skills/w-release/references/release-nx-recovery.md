# Nx Release 方式のリカバリ手順

[release-nx.md](release-nx.md) の手順を誤った場合の復旧手順。**Step 1-6 を正しく辿れば
発生しない**シナリオに対する保険資料で、平常時は参照不要。

## publish prompt が出てしまった場合 (`--skip-publish` 忘れ等)

publish prompt は Nx Release の最終段で出るため、prompt 到達時点では **通常 push 未完了**。
基本は手順 3 まで実行して local commit/tag を破棄してから再実行する。

1. `pkill -f "nx release"` で nx release プロセスを kill
2. push 済み判定 (remote 状態を最新化してから比較):

   ```bash
   git fetch origin <develop>
   git log origin/<develop>..HEAD                # commit が出力されれば未 push
   git tag --contains HEAD                       # local tag を列挙
   ```

3. 未 push commit/tag が残っていれば破棄して再実行する。
   tag pattern は `nx.json` の `releaseTag.pattern` = `{projectName}-v{version}` である:

   ```bash
   git reset --hard HEAD~1
   git tag -d pecot-visual-v0.23.1        # 例: 実際は破棄対象 tag 名を使う
   ```

   複数 project が同時 bump された場合、Nx Release は **1 commit + 複数 tag** を作る。
   `nx.json:projectsRelationship = "independent"` でも commit は集約される。`git tag
   --contains HEAD` で列挙された tag を **すべて** `git tag -d <tag>` で削除する。残すと
   次回 release で `tag already exists` エラーになる。

4. ごく稀に、push まで進んだ後で publish prompt の直前に kill した場合がある。
   この場合のみ、remote 側の commit/tag/GitHub Release はそのまま使える (追加対処不要)。

## `wt[N]` worktree から実行してしまった場合

1. local commit + tag を破棄 (`git reset --hard HEAD~1` + `git tag -d <tag>`)
2. base worktree (`base/<repo>`) に移動して `<develop>` ブランチを最新化し、release-nx.md
   の Step 1 からやり直す

## ランナーが失敗した場合（`release.yml` の手順）

[release-nx.md](release-nx.md) のランナーの手順で失敗したときの復旧手順。
手元の `nx release` には戻らない。

失敗の理由は、次のコマンドで確かめる。

```bash
gh run view <id> --log-failed -R <owner>/<repo>
```

- dry-run の run の失敗: 原因を直してから、`release.yml` を dry-run で起動し直す。
  原因の 1 つは preflight の失敗（code scanning・secret scanning の open の alert か、その一覧の取得の失敗）である。
  [release-nx.md](release-nx.md) の手元の手順の「3. open の security alert を確認（preflight）」の扱いに従う。
- 本番の run の、`nx release` の push の前の失敗: push の前なので、タグと commit は残らない。原因で分ける。
  - 直すのに PR のマージが要るとき: マージしてから、dry-run からやり直す。本番には、新しい run の `headSha` を使う
  - 基盤・ネットワークの一時的な失敗のとき: 同じ `sha` で本番を起動し直す
- publish だけの失敗: リリースは成立している。nx が失敗しても `release-land.sh` が `main` への取り込みを済ませるので、起動し直さない。
  Release が無ければ作り、publish だけをやり直す。

  ```bash
  gh workflow run publish-npm.yml -f tag=<tag> --ref <tag> -R <owner>/<repo>
  ```

- push の後の 401: App のトークンは 1 時間で切れる。
  push の後の Release の作成や publish の起動で 401 になっても、タグと release commit は残る。
  land のログに `landed:` の行があれば、`main` への取り込みも済んでいる。Release が無ければ作り、publish だけをやり直す（上の「publish だけの失敗」と同じ）。
  land も 401 で止まったときは、下の「land で止まった」に従う。
- land で止まった（ログに `error:` の行がある）: 衝突・上限の超過・ruleset や認証の拒否、App の `workflows` の権限での拒否が原因になる。
  nx が成功していれば、タグと GitHub Release はできていて、一時ブランチ `release/run-<run_id>-<run_attempt>` が残っている。
  nx も失敗したときは Release ができているとは限らないので、`gh release list -R <owner>/<repo>` で確かめる。
  `release.yml` を起動し直さない。Re-run もしない（同じ版のタグが重複して止まる）。
  `main` への取り込みはユーザーに頼む。エージェントは `main` へ push しない。
  取り込み方は、次のとおりである。
  - 1 番目の親を最新の `main` にして、一時ブランチを `--no-ff` で merge する
  - 件名は `chore(release): merge main into <release commit の件名から chore(release): を除いたもの>` にする
  - bypass を持つ人が push する
  - PR の squash・rebase はしない（タグの commit が `main` から届かなくなり、次のリリースが前回のタグを見失う）

  `error:` の行と一時ブランチの名前をユーザーに伝える。
- land のログが無く、一時ブランチ `release/run-...` が残っている: `ls-remote` の失敗などで land が動かなかった。
  `git ls-remote origin 'refs/heads/release/run-*'` で一時ブランチの有無を確かめる。
  あれば、上の「land で止まった」と同じ取り込みをユーザーに頼む。
