---
issue_ref: ""
template: plan
---

<!--
読者: 承認者（プランモードの承認画面と Issue で、折りたたみの外を読んで判断する）と、次のセッションの実装者（折りたたみを開いて着手する）。末尾の「例:」の形で書く。

書き方:
- Files は、外に触る代表ファイルを並べ、`<details>` の中にファイルごとのどう触るかを詳しく書く
- Files の `<details>` の先頭に作業単位の表（実装者・モデル・担当）を書く。実装者は `w-implementer-1` から順に名付け、main が自分で直すなら `main` と書き、その行のモデルは `—` にする。モデルの基準は w-help スキルの参照「エージェントのモデル」（pecot-w の `skills/w-help/references/agent-models.md`）
- Claude Code の plan mode の標準 5 項目は、Context・Approach（推奨方針）・Files（主要ファイルと再利用する既存関数）・E2E（検証）に書く

CUJ = 利用者（人またはエージェント）が製品の起点から始め、利用者が観測する結果で終わる操作フロー。
起点はスキル起動・MCP ツール呼出・実ツール発火による hook・利用者が打つ CLI コマンドのいずれか。
同じコマンドでも、利用者が成果を得るために打つなら CUJ で、実装者が変更の健全性を確かめるために打つなら CUJ ではない。
起点のコマンドに付ける `--dry-run` / `--prepare` は副作用を消す手段なので、利用者が打つ形なら起点に含む。
CUJ ごとに「誰が・起点・観測結果」の 3 要素を必須とし、いずれかを書けない項目を CUJ と呼ばない。
テストランナー実行（run-tests.sh / pytest / vitest）・ベースライン計測・健全性確認のための dry-run は CUJ にしない。
スクリプトや hook の直叩き（`echo '{}' | bash hook.sh`）も同じく CUJ にしない。

例:

## Plan

`mytool export` に `--format csv` を足し、CSV のファイルを書き出せるようにする。

### Context

`mytool export` は JSON しか書き出せない。表計算ソフトで開くには、利用者が JSON を自分で CSV に変換している。

### Approach

書き出しの入口に形式の選択を足し、形式ごとの書き手に処理を渡す。CSV の書き手を新しく足す。

<details>
<summary align="right">詳細はこちら</summary>

- 書き手は形式ごとに 1 ファイルにする。JSON の書き手も同じ形に移し、入口は形式の名前で書き手を選ぶだけにする
- CSV は標準ライブラリの `csv` モジュールで書く。カンマ・改行・ダブルクォートのエスケープを自前で書かない
- 列の順は `mytool list` の表示と同じにする。設定で列の順を変える案は採らない（利用者が 2 つの順を覚えることになる）
- 入れ子の値は JSON の文字列にして 1 つのセルに入れる

</details>

### Files

- `src/export.py`
- `src/writers/csv.py`（新規）
- `src/writers/json.py`（新規）
- `tests/test_export.py`

<details>
<summary align="right">詳細はこちら</summary>

作業単位

| 実装者 | モデル | 担当 |
|---|---|---|
| w-implementer-1 | opus | `src/export.py`・`src/writers/csv.py`（形式の選択と CSV の書き手。エスケープと入れ子の値の扱いを決める） |
| w-implementer-2 | sonnet | `src/writers/json.py`・`tests/test_export.py`（既存の処理の移し替えと、決まった形のテストの追加） |

- `src/export.py`
  - `--format` の引数を足す。値は `json`（既定）と `csv`
  - それ以外の値は「csv か json を指定してください」で止める
  - 書き出しの処理を、選んだ形式の書き手に渡す
- `src/writers/csv.py`（新規）
  - `write_csv(rows, columns, out)` を足す。`columns` は `mytool list` と同じ `LIST_COLUMNS` を使う
- `src/writers/json.py`（新規）
  - `src/export.py` にある JSON の書き出しを、そのまま `write_json(rows, out)` に移す
- `tests/test_export.py`
  - CSV の書き出し、エスケープ、入れ子の値、不正な形式の名前のケースを足す

</details>

### Notes

Issue の Acceptance にある「表計算ソフトで開ける」は、CSV の中身を読んで確かめる。

<details>
<summary align="right">詳細はこちら</summary>

- 表計算ソフトは devcontainer に入っていない。表計算ソフトが読む形（RFC 4180）になっているかを、書き出したファイルを Python の `csv` モジュールで読み戻して確かめる

</details>

## PECOT-Workflow

`mytool export` を 3 通り打ち、CSV の書き出し・不正な形式の名前・既定の JSON を確かめる。

### E2E

CSV を書き出せること、不正な形式の名前で止まること、`--format` を省くと今までどおり JSON を書き出すことを、`mytool export` を打って確かめる。

<details>
<summary align="right">詳細はこちら</summary>

CUJ 1

- 誰が — 利用者（devcontainer の端末）
- 起点 — `mytool export --format csv > out.csv`
- テスト手順
  1. カンマと改行を含む値を持つ行を `mytool add` で足す
  2. `mytool export --format csv > out.csv` を打つ
  3. `out.csv` を Python の `csv` モジュールで読み戻す
- 合格基準 — 1 行目が `mytool list` と同じ列の見出しで、カンマと改行を含む値が 1 つのセルに戻る

CUJ 2

- 誰が — 利用者（同上）
- 起点 — `mytool export --format xml`
- テスト手順
  1. `mytool export --format xml` を打つ
- 合格基準 — 「csv か json を指定してください」と出て、終了コードが 1 で、ファイルを書かない

CUJ 3

- 誰が — 利用者（同上）
- 起点 — `mytool export > out.json`
- テスト手順
  1. `--format` を付けずに打つ
  2. 変更前のブランチで打った出力と比べる
- 合格基準 — 変更前と同じ JSON が書き出される

</details>
-->

## Plan

<タスクの要約>

### Context

<なぜこの変更が要るか。何が起きていて、何を目指すか>

### Approach

<採る方針の要約>

<details>
<summary align="right">詳細はこちら</summary>

<方針の詳細と理由。採らなかった案があれば、その理由>

</details>

### Files

<触る代表ファイル>

<details>
<summary align="right">詳細はこちら</summary>

作業単位

| 実装者 | モデル | 担当 |
|---|---|---|
| <w-implementer-1 / main> | <sonnet / opus / —> | <担当ファイルと、そのモデルを選んだ理由> |

<ファイルごとに、どう触るか。再利用する既存の関数があれば、その名前>

</details>

### Notes

<他の見出しに収まらないが読者に要ることの要約。無ければ「なし」>

<details>
<summary align="right">詳細はこちら</summary>

<Issue の記述と変える点、判断を仰ぐ点、前提にした事実と、その根拠>

</details>

## PECOT-Workflow

<検証方法の要約>

### E2E

<CUJ の要約>

<details>
<summary align="right">詳細はこちら</summary>

CUJ 1

- 誰が — <利用者 / エージェント。どの環境・セッションで>
- 起点 — <スキル / MCP ツール / hook を発火させる実ツール / CLI コマンド>
- テスト手順
  1. <手順1>
  2. <手順2>
- 合格基準 — <利用者が見る出力・状態>

</details>
