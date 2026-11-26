# Contract: プロジェクト指示に書く固有の値

pecot-coordinator のスキルは、プロジェクト固有の値をこの名前でプロジェクト指示から読む（FR-025・FR-026）。
スキルに値そのものを書かない。値が書かれていないときは、coordinator は推測せず、利用者に書くよう案内する。
一覧は Phase 1 の振り分け（US1）で確定する。下の行は、今のプロジェクト指示から見込んだ最小の形。

| 値の名前 | 中身 | このリポでの例 |
|---|---|---|
| リポ | pecot の流れで扱うリポ（`owner/repo`）。複数可 | `pecotcraft/pecot` |
| ボード | GitHub Projects のボード（持ち主と番号） | `pecotcraft` の 1 |
| RC の作業場所 | 利用者の端末の worktree の名前と、リポの中の場所 | `wt1`〜`wt12`（`/workspaces/wtN/pecot`） |
| リリース・計画の場所 | 作業場所に割り振らない、リリースと計画に使う場所 | `base`（`/workspaces/base/pecot`） |
| クラウドのスレッドの上限 | 同時に起動するクラウドのスレッドの数 | 未定（Phase 1 で決める） |
| 検証用のリポとボード | 外へ書き込む確かめを流す先 | `pecotcraft/pecot-sandbox`・ボード「pecot sandbox」 |
| 端末の事情 | 端末でしか答えられない権限の確認など、そのプロジェクトだけの事情 | 既定のデバイス以外ではスレッドの起動に承認が要る |

## 書き方の例

プロジェクト指示には、見出しと表で書く。スキルは見出しの名前で値を探す。

```markdown
## pecot の値

| 値の名前 | 値 |
|---|---|
| リポ | pecotcraft/pecot |
| ボード | pecotcraft の 1 |
| RC の作業場所 | wt1〜wt12（/workspaces/wtN/pecot） |
```
