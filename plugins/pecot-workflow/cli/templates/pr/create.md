---
title: ""
repository: ""
base: ""
head: ""
draft: false
screenshot: ""
---

<!--
読者: この PR をマージしてよいかを判断する人と、後で履歴から PR を見返す人。どちらも作業の経緯を知らない。末尾の「例:」の形で書く。

書き方:
- Changes には振る舞いの変化を書く。利用者が打つ操作（コマンド・設定・画面の操作）と、そのとき見える結果が、変更の前後でどう変わるか。どのファイル・関数をどう直したかは書かない（Files changed が見せる）
- Changes は、変化ごとに番号付きの `###` の小見出しを立てる。小見出しは、何がどう変わるかを主語と述語のある文で書く（`### 1. <何が><どう変わる>`）。直下の太字の 1 文で、利用者の操作と結果を言い切る
- 次のどれかが変わる変更は、結果のスクリーンショットを撮って Summary に置く。画面、ツールが生成して利用者が GitHub で見る Markdown（Issue・PR の本文、コメント、Tracker の表）、利用者が読む CLI の出力の文である。CHANGELOG・README・SKILL.md の文の変更は含めない。載せ方・撮り方は w-pr スキルの手順にある
- Verified は、CUJ ごとに `###` の小見出し（`### CUJ 1 — <何が><どうなる>`）を立て、誰が・起点・合格基準・結果を書いて、打ったコマンドと出力をそのまま載せる
- 末尾の `Closes #` には sub-issue の番号だけを入れる（Epic の番号を入れると、マージで Epic が閉じる）。`pr create --prepare` が作業中の Issue の番号を入れる

フィールド:
- repository: 必須。PR 先の `owner/repo`（`git remote get-url origin`）
- screenshot: 画像を Summary に入れたら空のまま。入れないなら、入れない理由を `"..."` で囲んで書く
  - 例: `"CLI の内部の整理だけで、画面・生成する Markdown・出力の文は変わらない"`
- title: `type(scope): #ISSUE タイトル`。type は feat / fix / docs / chore / refactor / test / ci / build / perf / revert
- title の scope（nx を使うリポ = config の `release_type` が `nx`）: 変更した nx プロジェクトの scope
  - scope は、プロジェクトの `project.json` の `tags` にある `scope:<名前>` の値。tag が無ければプロジェクト名
  - 複数は空白なしの `,` 区切り。どのプロジェクトにも属さないファイルがあれば `repo` を加える（`.nx/version-plans/` は数えない）
  - `pr create --prepare` が算出した scope を表示し、`pecot pr create` が食い違いを止める
- title の scope（nx を使わないリポ）: 付けない（`type: #ISSUE タイトル`）

例:

## Summary

`mytool export` で、**CSV のファイルを書き出せる**ようにしました。これまでは JSON しか書き出せず、表計算ソフトで開くには利用者が自分で変換していました。

![mytool export --format csv で書き出したファイルを表計算ソフトで開いた画面](./export-csv.png)

## Changes

### 1. `mytool export` が CSV のファイルを書き出せるようになる

**`mytool export --format csv` で、CSV のファイルを書き出せるようになりました**。これまでは `--format` という引数が無く、打つと「unknown option」で止まっていました。

書き出したファイルは、表計算ソフトでそのまま開けます。列の順は `mytool list` の表示と同じなので、画面で見ていた並びのまま表になります。値にカンマや改行を含むときは、ダブルクォートで囲んで 1 つのセルに収めます。

### 2. 不正な形式の名前を渡すと、使える値を示して止まる

**`--format` に `csv` と `json` 以外を渡すと、使える値を示して止まるようになりました**。たとえば `--format xml` と打つと、「csv か json を指定してください」と出て、ファイルは書き出しません。

### 3. `--format` を省いたときの動きは変わらない

**`--format` を付けずに打ったときの動きは変わりません**。今までどおり JSON を書き出すので、`mytool export` を使っている既存のスクリプトはそのまま動きます。

### 打つコマンドごとに、結果が次のように変わる

| 打つコマンド | 変更前 | 変更後 |
|---|---|---|
| `mytool export` | JSON を書き出す | JSON を書き出す（変わらない） |
| `mytool export --format csv` | 「unknown option」で止まる | CSV を書き出す |
| `mytool export --format xml` | 「unknown option」で止まる | 「csv か json を指定してください」で止まる |

## Verified

### CUJ 1 — CSV で書き出したファイルが表計算ソフトで開ける

- 誰が — 利用者（自分の端末で、このブランチの mytool を打つ）
- 起点 — `mytool export --format csv > out.csv`（値にカンマを含む行を足してから）
- 合格基準 — 1 行目が `mytool list` と同じ列の見出しで、カンマを含む値が 1 つのセルに収まる
- 結果 — 合格。表計算ソフトで開いた画面は Summary の画像のとおり

```console
$ mytool export --format csv > out.csv
$ head -3 out.csv
name,date,note
alpha,2026-10-02,"a, b"
beta,2026-10-03,c
```

### CUJ 2 — 不正な形式の名前を渡すと、`mytool export` が止まる

- 誰が — 利用者（同上）
- 起点 — `mytool export --format xml`
- 合格基準 — 使える値を示して、終了コード 1 で止まる
- 結果 — 合格

```console
$ mytool export --format xml
csv か json を指定してください
(exit 1)
```

### 変更箇所の単体テストが通る

```bash
pytest tests/test_export.py
# 24 passed
```

## Risks

入れ子の値は、CSV では JSON の文字列として 1 つのセルに入ります。表計算ソフトでは、そのまま文字列として見えます。

Closes #123
-->

## Summary

<何が・なぜ変わったか>

## Changes

<振る舞いの変化。操作ごとの変更前と変更後>

## Verified

<確かめたことと結果>

## Risks

<マージ後に残る懸念とその影響。無ければ「なし」>

Closes #
