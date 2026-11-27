# 仕様駆動開発フロー

仕様を先に確定させてから実装に入るワークフロー。
Issue乱立を防ぎ、Phase単位で作業を管理する。

## 背景・問題意識

### 現状の課題

| 課題 | 説明 |
|------|------|
| Epic粒度の曖昧さ | 「大きな目標」の基準がなく、ばらつきが発生 |
| Issue肥大化 | Ready/Backlogに古いIssueが溜まる |
| コンフリクト | 同一ファイルを複数タスクで編集するとマージに時間がかかる |
| 形式主義 | テンプレート準拠が目的化するリスク |

### 解決アプローチ

- 仕様と実装を分離し、仕様検討は Epic の下の分解のタスク 1 つにまとめる
- Phase 単位で管理し、Epic を実装フェーズとして扱う
- 順序は前提の表に書き、並列可能/直列必須を明確にする

## フロー全体像

```text
┌──────────────────────────────────────────────────────────┐
│  仕様フェーズ（分解のタスク）                            │
│  ──────────────────────────────────────────────────────  │
│  w-breakdown が Epic の下に分解のタスクを起票し、        │
│  そのブランチで speckit を進める                         │
│  → タスクを閉じる PR で開発ブランチにマージ              │
│  （開発ブランチは config の develop_branch）             │
└──────────────────────────────────────────────────────────┘
                        ↓ 仕様確定
┌──────────────────────────────────────────────────────────┐
│  実装フェーズ（ボード管理）                              │
│  ──────────────────────────────────────────────────────  │
│  [Epic] Feature X  ← Backlog                             │
│    ├─ サブIssue: Phase 1                                 │
│    ├─ サブIssue: Phase 2（前提: Phase 1）                │
│    └─ サブIssue: Phase 3（前提: Phase 2）                │
│                                                          │
│  Issue 化の時:                                           │
│    → 全 Phase のサブIssue を一括で投稿                   │
│    → 前提が済んでいない Issue は Blocked、他は Ready     │
│    → Ready から1個ずつ Active にして作業                 │
│                                                          │
│  前提がそろう:                                           │
│    → スタック可の前提は PR が出たら、                    │
│      スタック不可の前提はマージされたら、Ready に移る    │
│    → pecot の操作と、w-pr の待ち受けの片付けが移す。     │
│      待ち受けるセッションの無い画面でのマージなどで      │
│      ずれたものはワークフローが直す                      │
│                                                          │
│  スタックして進める:                                     │
│    → 前提の PR の上にスタックして着手し、PR を出す       │
│    → 画面でマージし、各 PR の w-pr が片付ける            │
└──────────────────────────────────────────────────────────┘
```

## 詳細フロー

### 1. 仕様作成（分解のタスク）

仕様書をリポジトリ内で管理する。`/pecot-w:w-breakdown` が、Epic の下に分解のタスクを 1 つ起票し、そのタスクに紐づいたブランチで speckit を進める。

```text
specs/
├── feature-x/
│   ├── overview.md      # 概要・目的
│   ├── requirements.md  # 要件定義
│   └── design.md        # 設計
```

ポイントは次のとおり。

- 分解のタスクを閉じる PR で、レビュー・承認を経て開発ブランチにマージ。base は config の develop_branch で、pecot-workflow の MCP ツール `board_show` で確認する
- ボードに載るのは分解のタスク 1 つだけ。仕様の工程ごとの Issue は作らない
- マージの後に、`/pecot-w:w-issueize` で実装フェーズへ

### 2. Epic作成（Phase単位）

仕様確定後、実装をPhase単位に分割してEpicを作成。

```markdown
## [Epic] Feature X - Phase 1: 基盤実装

### 関連仕様
- [specs/feature-x/overview.md](../specs/feature-x/overview.md)
- [specs/feature-x/design.md](../specs/feature-x/design.md)

### 概要
Feature Xの基盤部分を実装する。

### 完了条件
- [ ] データモデル定義
- [ ] APIエンドポイント実装
- [ ] 基本テスト作成

### 前提Phase
（他の Epic への前提。無ければ「なし」。サブ Issue の前提は前提の表に書く）
```

### 3. サブIssue投入（一括）

全 Phase のサブIssueを一括で投稿する。
前提が済んでいない Issue は `Blocked`、そのほかは `Ready` に入る。ボードに `Blocked` が無ければ、`Ready` で作る（pecot-workflow の MCP ツール `project_init` で足せる）。
`Ready` には着手できる Issue だけが並ぶので、先の Phase を投稿しても肥大化しない。

前提の書き方は、次の「前提の表から Issue 化まで」で説明する。

### 4. 作業実行

1. `/pecot-w:w-active` で、`Ready` から 1 つ選ぶ。一覧の各 Issue には着手の判定が付く
2. w-active がブランチを作り、Issue を `Active` に移す。base は判定で決まる。利用者とエージェントは base を選ばない
3. 実装・テストの後、`/pecot-w:w-pr` で PR を出す。利用者が GitHub の画面でマージし、w-pr が待ち受けて片付ける
4. 次のサブIssue へ進む

着手の判定は 3 つある。

| 判定 | 意味 | 着手の base |
|---|---|---|
| 着手できる（`startable`） | 前提が無いか、すべて済んでいる | 開発ブランチ |
| スタックすれば着手できる（`stackable on #N`） | 残る前提が、PR の出ているスタック可の前提だけ | 前提 #N の PR のブランチ |
| ブロック中（`blocked by #N`） | 済んでいない前提がある | 着手できない。w-active は理由を示して止まる |

判定は、前提の Issue に紐づけたブランチと、Development 欄の PR を読んで決める。

### 5. 前提がそろう → 次Phase

前の Phase の PR が出る（スタック可の前提）か、マージされる（スタック不可の前提）と、次の Phase の Issue が `Blocked` から `Ready` に移る。

- pecot の操作（一括投稿・PR の作成・前提の変更）と、w-pr の待ち受けがマージの後に行う片付けが、その場で影響を受ける Issue の列を動かす
- 待ち受けるセッションの無い画面でのマージ・blocked by の付け外し・カードの手での移動でずれた列は、ボードを自動で直すワークフローが直す。入れるかは任意で、置き方は [board-sync-workflow.md](./board-sync-workflow.md) にある

1. 前提がそろった Issue が `Ready` へ移る。マージの後は、w-pr の待ち受けの片付けが、着手できるようになった Issue を報告する
2. `Ready` から着手する
3. 全サブIssue の完了後に、Epic本文の完了条件をチェックする

## 前提の表から Issue 化まで

Phase の前後関係は、tasks.md の前提の表に書く。表が `blocked_by` になり、`Blocked` と `Ready` の振り分けを決める。

1. w-breakdown が、tasks の工程に、`### Phase Dependencies` の下の 4 列の表（Phase・前提・種類・理由）を書かせる
2. w-issueize が、表の行を Issue ファイルの `blocked_by` に写す
3. pecot-workflow の MCP ツール `issue_check` を使い、投稿される前提と tasks.md の表を並べて確かめる。食い違いは、投稿の前に直す
4. 投稿する。前提が済んでいない Issue は `Blocked`、そのほかは `Ready` に入る。ボードに `Blocked` が無ければ `Ready` で作る

表の例を挙げる。

```markdown
| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | スタック可 | Phase 2 が、Phase 1 の設定のキーを使う |
| 3 | 2 | スタック可 | スキルが、Phase 2 の CLI を呼ぶ |
| 4 | 2 | スタック不可 | action は、既定のブランチのプラグインを入れる |
```

- 1 行が、フェーズと前提の 1 組である。前提の無いフェーズは書かない
- `Phase` と `前提` は、フェーズの番号だけを書く。直接の前提だけを書く
- `理由` は、すべての行に書く

`種類` には、次の 2 つのどちらかを書く。

| 種類 | 意味 |
|---|---|
| スタック可 | 前提の変更を、手元のブランチか試験環境で動かして、実装と確認ができる。前提の PR の上にスタックして着手できる |
| スタック不可 | 前提の変更が開発ブランチに入っていないと、手元のブランチと試験環境のどちらでも、実装か確認ができない。前提のマージを待つ |

Issue の本文に、前後関係は書かない。スタック不可の前提の節は、CLI が本文の末尾に足す。
前提と種類の決まりは、[issue-flow-rules.md](./issue-flow-rules.md) の「前提（`blocked_by`）と種類」が定める。
前提を持つフェーズが 1 つも無いときは、見出しの行と区切りの行だけの表を書く。この表は「前提は無い」と読む。
この表の Phase は tasks.md のフェーズ（サブ Issue）を指し、Epic の前提は表せない。

### 投稿の後に前提を直す

計画が変わったら、pecot-workflow の MCP ツール `issue_block` と `issue_unblock` で前提を直す。GitHub の画面で直す必要は無い。

- `issue_block` は、前提を付ける。付いている前提には、種類（スタック可・スタック不可）と理由を付け直す
- `issue_unblock` は、前提を外す
- どちらも、本文の `## Waits for merge` の節と、ボードの列と札を、その場でそろえる。輪になる前提は止まる
- 着手済み（`Active`・`In Review`）の Issue では、列と札を動かさず、残る前提を警告で伝える。ブランチは前提の PR の上へ移らない
- 1 件ずつサブタスクを作る `/pecot-w:w-ready` も、先に終える Issue を `blocked_by` に書いて投稿する

## スタックして進める

スタック可の前提の PR がレビュー中の間も、その PR の上にスタックして次の Issue に着手できる。
前提の PR のブランチを base にした PR を、スタック PR と呼ぶ。このとき、前提の PR を親 PR、スタック PR を子 PR と呼ぶ。PR の並びを、スタックと呼ぶ。

### スタックして着手する

1. 前提の PR が出ると、待っていた Issue が `Ready` に移り、判定が `stackable on #N` になる
2. `/pecot-w:w-active` で着手する。ブランチは前提の PR のブランチから作られ、w-active はその旨を伝える
3. base を選ぶ操作は無い。`gh stack` は使わない（hook が止める）

### PR を出す

`/pecot-w:w-pr` で PR を出す。スタックしたブランチの PR は、base が親ブランチになり、差分には自分のブランチの変更だけが出る。
PR は、親 PR とスタックとして並ぶ。親 PR が無いときは止まる。

### 画面でマージする

マージは GitHub の画面で行う。スタックの PR も、画面で押す。

- GitHub の文書では、子 PR を押すと、その下の未マージの PR も一緒に、下から順にマージされる。GitHub の stacks の仕様である（[Merging stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests)）。
  > You cannot merge a mid-stack pull request in isolation, the pull requests below it will always merge with it.
- マージ箱は、下の PR がすべて承認され、チェックが通っていることを求める
- 承認を 0 件にした ruleset では、チェックが通っていれば、レビュー中の親 PR も一緒に入る
- 子 PR を押す前に、親 PR の w-pr が待ち受け（Step 6）に入っていることを確かめる。入る前に押すと、親 PR の w-pr がその後に push する直しは、開発ブランチに入らない
- merge queue のあるブランチでは、子 PR を押すと、親 PR と子 PR が下から順にキューに入る。ただし、マージされるのは親 PR だけである
  - 子 PR は、理由 `invalid_merge_commit` でキューから外れ、base が開発ブランチに変わる
  - 子 PR の w-pr の待ち受けは、外れたのを拾えれば `DEQUEUED` を受け、もう一度押すよう伝える。キューにいた時間が待ち受けの間隔（60 秒）より短いと拾えず、知らせずに待ち続ける
  - 親 PR がマージされた後も子 PR が開いたままなら、知らせを待たずに子 PR をもう一度押す。押すとマージされる
  - 2026-11-25 に GitHub の画面のボタンで確かめた結果である。文書の「一緒にマージされる」とは違う

親 PR をマージすると、次のことが起きる。

- GitHub が、子 PR の base を開発ブランチへ書き換え、子ブランチをスタックし直して force-push する
- 各 PR の w-pr の待ち受けが、片付けの後に、着手できるようになった Issue と、スタックし直しが要る子 PR を報告する

### 子ブランチをスタックし直す

子ブランチの作業ディレクトリで、次の作業の前に pecot-workflow の MCP ツール `pr_restack` を呼ぶ。`/pecot-w:w-pr` も、CI を待つ間もコンフリクトを待ち受け、起きたらスタックし直す。

- 親ブランチに直しを push したときも、子ブランチで `pr_restack` を呼ぶ。`check: true` で、スタックし直しが要るかだけを確かめられる
- 衝突で止まったら、衝突したファイルを直して `pr_restack` を `continue: true` で呼ぶ。取りやめるときは `abort: true` で、スタックし直しの前の位置に戻る

## ステータス運用

現状のステータス構成を維持する。

| ステータス | 用途 |
|-----------|------|
| **Backlog** | Epic（Phase単位）・Tracker置き場 |
| **Pending** | 人が後回しにしたEpicまたはタスク。Ready／Backlog から手動で移動。人だけが出し入れする |
| **Blocked** | 前提を待っているサブIssue。pecot が置き、pecot が出す。ボードに無ければ `project_init` で足す |
| **Ready** | 今、着手できるサブIssue（スタックすれば着手できるものを含む） |
| **Active** | 作業中（同時1-2個まで） |
| **In Review** | PR が出ている。スタック PR も同じ列に入る |
| **Archived** | 完了後退避 |

## 並列作業の制約と対策

### コンフリクト発生パターン

```text
✗ コンフリクト発生:
  [Task] A: src/feature.ts を変更
  [Task] B: src/feature.ts を変更
```

同一ファイルを複数タスクで編集すると、後からマージする方でコンフリクト解決が必要。

### 対策1: ファイル境界を意識したタスク分割

```text
✗ 悪い分割:
  [Task] 機能Aの実装（feature.ts, utils.ts）
  [Task] 機能Bの実装（feature.ts, helper.ts）  ← feature.ts が重複

✓ 良い分割:
  [Task] feature.ts の変更
  [Task] utils.ts の変更
  [Task] helper.ts の変更
```

### 対策2: 直列実行の前提明示

同一ファイルを触るタスクが避けられない場合、前提の表に行を足す。Epic 本文や Issue 本文に順序は書かない。

```markdown
| Phase | 前提 | 種類 | 理由 |
|---|---|---|---|
| 2 | 1 | スタック可 | Phase 2 が、Phase 1 の feature.ts を変える |
| 3 | 2 | スタック可 | Phase 3 が、Phase 2 の feature.ts を変える |
```

表は `blocked_by` になる。後ろの Phase の Issue は `Blocked` に入り、前提がそろうと `Ready` に移る。

### 対策3: 並列可能タスクの明示

前提の表に行が無いフェーズ同士は、互いを待たない。並列に着手できるフェーズには、前提の行を書かない。
前提の無い Issue は、一括で投稿したとき `Ready` に並ぶ。

## 運用ルール

### Epic本文の必須事項

| 項目 | 説明 |
|------|------|
| 関連仕様リンク | 仕様書へのリンク必須 |
| 完了条件 | チェックリスト形式 |
| 前提Phase | 依存するEpicがあれば明示。Epic どうしの前提で、サブ Issue の前提は前提の表に書く |

サブタスクの順序と並列は、Epic 本文に書かない。前提の表と `blocked_by` に書く。

### 仕様変更時の対応

| パターン | 対応 |
|---------|------|
| 軽微な変更 | 仕様書更新 + 既存Issueに追記 |
| 中規模変更 | 仕様書更新 + 追加タスクIssue作成 |
| 大規模変更 | 新規Phaseとして別Epic作成 |

### Issue 化のタイミング

- 全 Phase のサブIssueを、Issue 化のときに一括で投稿する
- 前提が済んでいない Issue は `Blocked` に入り、前提がそろうと `Ready` に移る（スタック可の前提は PR が出たとき、スタック不可の前提はマージされたとき）。移すものは「5. 前提がそろう → 次Phase」にある

## 関連ドキュメント

- [board-status.md](./board-status.md) - ステータス定義
