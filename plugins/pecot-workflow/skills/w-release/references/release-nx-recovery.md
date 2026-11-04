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
