---
name: w-revise
description: |
  PRのレビュー指摘を分析し修正を適用します。
  Use after creating a PR to self-review and improve it before merge — reviewers (w-tech-advisor / w-e2e-planner / w-implementer) review via Agent single spawns by specialty, w-implementer applies fixes. Triggers: "review the PR", "address review comments".
  Only for your own team's PR — not for reviewing other teams' PRs.
when_to_use: "PR のレビュー指摘に対応したい、マージ前に PR を見直して直したい"
---

# レビュー対応

## pecot CLI ランチャー

pecot CLI は実行環境ごとにランチャーを変数化してから使う。

Claude Code:

```bash
PECOT=pecot
```

GitHub Copilot CLI では shell tool の PATH にプラグイン `bin/` が入らないため、最初からインストール済み wrapper を使う。

```bash
PECOT="$HOME/.copilot/installed-plugins/pecot/pecot-w/bin/pecot"
```

以降の pecot CLI コマンド例は必ず `$PECOT ...` として実行する。

自 PR に対し、各レビュアー（w-tech-advisor / w-e2e-planner / w-implementer）が専門視点でレビューする。行に紐づく指摘は PR の該当行へインラインコメントで投稿する。
行に紐づかない指摘は `review-findings` コメントで投稿する。
投稿後にユーザーへ対応可否を一括で確認し、採用分のみ修正・コミットする。最後に `review-resolution` コメントで対応報告を残す。指摘投稿と対応の間にユーザー確認のワンテンポを必ず入れる。

## 手順

### Step 1: PR 情報を取得

引数 `owner/repo/PR番号` を受け取り、PR 本文・diff・既存レビューコメントを取得する。省略された場合は、直前の会話から対象 PR が一意に特定できる（同じセッションで作成した PR が 1 件しかない等）ならそれを採用して進んでよい。曖昧な場合にのみユーザーに確認する。

```bash
$PECOT pr read <owner>/<repo>/<PR番号> --reviews
```

紐づいた Issue が表示された場合は、要件確認のため Issue も読む。

```bash
$PECOT issue read <owner>/<repo>/<Issue番号>
```

### Step 2: 各レビュアーに専門視点でレビューを依頼

Step 1 で取得した PR 情報（diff・外部レビューコメント・Issue 要件）を各レビュアーに渡し、
自分の専門視点で diff をレビューさせる。各レビュアーは `Agent` ツールの単発 spawn で起動する。
指摘は、終わったときに通知で main へ届く。agent teams が有効で `name` を付けた起動は teammate の idle の通知で、それ以外は完了の通知で届く。追質問・再依頼が必要な場合は spawn 済みレビュアーに `SendMessage` で送る。
3 体の並列 spawn を既定とする。直列にする場合のみ理由を `w-tech-advisor` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）。
ここでの Goal は spawn prompt の冒頭行を指す。
1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。

| エージェント種別 | レビュー視点 |
|---|---|
| w-tech-advisor | 技術的正確性（API使用法、アーキテクチャ、ライブラリ利用、非推奨パターン） |
| w-e2e-planner | CUJ観点・テスト品質（妥当性、網羅性、変更がCUJに与える影響、追加すべきCUJ、実CUJ実行による動作確認） |
| w-implementer | コード品質（バグ、エラーハンドリング、重複、可読性） |

Resolved 済みの既存スレッドは再対応の対象に含めない。

### Step 3: 指摘を採番し、インラインコメントと `review-findings` に振り分けて投稿

各レビュアーから返ってきた指摘と Step 1 で取得した外部レビューコメントを main が統合し、`F-01` から連番で ID を振る。外部レビュアーの指摘も同じ連番に含める。F-NN は後段の `review-resolution` コメントと対応づけるための一意 ID なので、Step 6 まで採番を保持する。

外部レビュアーの指摘は採番の対象には含めるが、インラインコメントとしては投稿し直さない。
既に他者のスレッドが立っている行に同趣旨のスレッドを重ねることになり、「注意」の規則で他者スレッドへの返信・resolve をしない以上、元スレッドが未解決のまま残るため。
外部指摘は Disposition の 1 行に元スレッドの URL を添えて並べ、採否判断の導線にするだけにする。

自分のレビュアーから返ってきた指摘は次の規則で投稿先を決める。

| 条件 | 投稿先 |
|---|---|
| PR diff のハンク内の行を指せる | インラインコメント（`path` + `line` + `side`） |
| ファイル単位でしか言えない | ファイルコメント（単発エンドポイントで `path` + `subject_type` に `file`） |
| いずれも不可（PR 本文への指摘・欠落の指摘・diff 外の既存行・横断的な設計指摘） | `review-findings` の General 節 |

インライン投稿が 422 で拒否された指摘は General 節へ回す。
一括 review はリクエスト単位で原子的に拒否され、`line must be part of the diff` 等のエラーは `comments[]` の何番目が原因かを示さない。
疑わしい 1 件を `comments[]` から外して再送する。あるいは単発エンドポイント（後述の `pulls/<PR番号>/comments`）で 1 件ずつ投稿して原因の F-NN を特定する。特定したら、その F-NN だけを General 節へ回す。

#### インラインコメント本文の書式

- 本文は `**F-NN**` で始める（2 巡目以降はラウンド識別子込みで `**R2/F-01**`）。この前置きが F-NN とスレッドの対応表になる。
- この方法は CLI の本文検証を通らないため、テンプレと同じ禁止事項を投稿前に自分で確認する。`<...>` プレースホルダを残さない。チェックボックス記法を使わない。型・比較・メタ表記はバッククォートで囲む。

#### 認証とホストの確認

`gh` の既定ホストは github.com なので、対象 PR のホストを `--hostname` で必ず明示する。
以下の導出は cwd の origin を対象 PR のリポジトリと見なす。
引数の `owner/repo` が cwd のリポジトリと異なる場合は導出結果が別ホストを指す。その場合は、
対象リポジトリのワークツリーで実行するか、導出を使わず `.pecot/config/hosts.json` に定義されたホストのうち対象のものを直接指定する。

```bash
GH_HOST=$(git remote get-url origin | sed -E 's#^[a-z0-9+.-]+://##; s#^[^@/]*@##; s#[:/].*$##')
[ -n "$GH_HOST" ] || { echo "origin からホストを導出できない" >&2; exit 1; }
gh auth status -h "$GH_HOST"
```

導出が空文字のまま進むと `gh auth status -h ""` が exit 0 を返し、認証確認が空のホストのまま通過する。そのため導出直後に空チェックを入れ、その場で失敗させる。

未認証なら投稿せず、`gh auth login -h <host>` の実行をユーザーに案内する。

シェルはツール呼び出しごとに作り直され変数は持続しないため、以降の `gh` コマンド例は変数を参照せず、
ここで得たホスト名を `--hostname <対象ホスト>` に直接埋めて実行する。

#### インラインコメントを一括投稿

インラインコメントは 1 つの review にまとめて投稿する（pending review を残さず、通知 1 通で原子的に確定する）。`commit_id` は PR の head sha。自分の PR には `APPROVE` / `REQUEST_CHANGES` が 422 になるため `event` は `COMMENT` で固定する。

インライン対象が 1 件も無い場合（全指摘が General へ回った場合）は review 投稿自体を行わない。`comments[]` が空の review 作成は 422 で拒否される。

head sha は API から取る。`$PECOT pr read` は `head_ref`（ブランチ名）までしか返さない。`git rev-parse HEAD` で代用すると、未 push コミットや別 worktree では API が 422 を返す。

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号> --jq .head.sha
```

得られた値を以下の `commit_id` に入れる。

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/reviews \
  --input - <<'JSON'
{
  "commit_id": "<head sha>",
  "event": "COMMENT",
  "comments": [
    {"path": "cli/core/sections.py", "line": 42, "side": "RIGHT", "body": "**F-01** 指摘内容"}
  ]
}
JSON
```

パラメータは必ず `--input -` に JSON を流す形で渡す。`-f line=42` は文字列として送られ 422 で落ちる。
heredoc が防ぐのはシェルによるクォート解釈だけで、JSON 文字列にリテラル改行を書けない制約は残る。
複数行の本文は改行を `\n` へエスケープして 1 行にする（`jq -n --arg body "$BODY" '{body: $body}'` で組み立てると、エスケープの失敗を避けられる）。

ファイルコメント（`subject_type`）は一括投稿の `comments[]` では受け付けられず 422 になるため、単発エンドポイントで投稿する。後から 1 件だけ足す場合と、既存スレッドへ返信する場合も同じ単発エンドポイントを使う。

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/comments \
  --input - <<'JSON'
{"commit_id": "<head sha>", "path": "cli/core/sections.py", "subject_type": "file", "body": "**F-02** 指摘内容"}
JSON
```

```bash
gh api --hostname <対象ホスト> \
  repos/<owner>/<repo>/pulls/<PR番号>/comments \
  --input - <<'JSON'
{"in_reply_to": 1234567, "body": "返信本文"}
JSON
```

`in_reply_to` には返信先スレッド先頭コメントの `databaseId` を数値で渡す。

#### F-NN とスレッド ID の対応表を作る

`$PECOT pr read --reviews` はスレッド ID を返さないため、Step 6 の resolve に使う ID は GraphQL で引く。各スレッド先頭コメント本文の `**F-NN**` を手掛かりに F-NN と `id` を対応づけ、Step 6 まで保持する。
同時に返る `url` が、Disposition に載せるインラインコメントの `html_url` にあたる。
`POST /pulls/<PR番号>/reviews` のレスポンスは review 単位の URL しか返さないため、コメント単位の URL はこのクエリでしか取れない。

```bash
gh api --hostname <対象ホスト> graphql \
  -f query='
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes { id isResolved isOutdated comments(first: 1) { nodes { databaseId body url } } }
          }
        }
      }
    }' \
  -f owner=<owner> -f repo=<repo> -F number=<PR番号>
```

`isOutdated` は、紐づく diff ハンクが最新コミットと一致しなくなったスレッドに立つ。Step 5 で修正した箇所のスレッドは `true` になり得るが、修正しなかった箇所のスレッドは `false` のまま残る。
どちらの状態も仕様として許容し、対応の追跡は resolve 状態が担う。

#### `review-findings` コメントを投稿

`review-findings` テンプレを `--prepare` で取得し、出力ファイル内の `<!-- -->` ガイドに従って本文を埋めて投稿する。
見出し書式・指摘 0 件時の文言・プレースホルダ禁止等の詳細はテンプレ側に集約してあるので prepare 出力をそのまま読む。
General にはインライン化できなかった指摘だけを書き、Disposition にはインライン分も含む
全 F-NN を要旨 1 行で並べる。
自分がインラインコメント・ファイルコメントとして投稿した F-NN には、そのコメントの `html_url` を添える。
外部レビュアーの F-NN には元スレッドの URL を添える。どちらでもない非インライン分は URL を省く。このコメントは「修正前」に投稿する。

```bash
$PECOT issue comment --prepare \
  --template review-findings \
  --issue <owner>/<repo>/<PR番号>
# 出力された .pecot/tmp/output/ 配下の md を編集後:
$PECOT issue comment <編集後ファイル>
```

下書きの文章規則は、Claude Code で pecot-visual を入れた環境なら、下書きを Write / Edit した直後に確かめられる。
違反があると `[text-lint] Writing-rule violations in` で始まる通知が返る。指摘の行の文を書き直す。
下書きは書き込みで止まらず、投稿の CLI も文面を確かめない。投稿前に直す。何も返らないことは、違反が無いことを意味しない。
`[text-lint] Not checked` は、確認していないという通知を表す。
違反が多いと先頭 100 行だけが返る。直して保存し直すと、残りが返る。
関門（pre-commit と commit-msg）を入れたリポでは、commit する文書とコミットメッセージが止まる。
出力の形はリポで異なる。例は `<path>:<line>:<col> <ruleId> <message>` と、ファイル名の行に続く `行:列 error メッセージ 規則名` の 2 形がある。
どちらも、指摘された行の文を直す。
規則・除外は変えない。無効化コメントと `--no-verify` にも触れない。

インライン review を `gh api` の heredoc で渡す本文はファイルを経ないので、hook は確かめない。投稿前に、上の規則に照らして自分で読み直す。

### Step 4: 対応可否をユーザーに一括確認

Step 3 で投稿したコメントの `html_url` をユーザーに提示し、AskUserQuestion で以下の固定 3 択 + Other を出して一括判断を仰ぐ。AI が指摘ごとに採否を聞き直すことはしない。

| label | description |
|---|---|
| すべて対応 | F-01 から F-NN まで全件を w-implementer に渡して修正 |
| 一部のみ対応 | Other 自由入力で採用する F-NN をカンマ区切り指定（例: `F-01, F-03`） |
| 対応なし | すべての指摘を「ユーザー判断で対応不要」として report に記録 |

指摘 0 件のときも Step 3 の `review-findings` は 0 件時の文言で投稿する。そのうえで AskUserQuestion をスキップし、Step 5 と resolve 操作を飛ばす。Step 6 の `review-resolution` も 0 件時の文言で投稿する（どちらの文言もテンプレのガイドに記載がある）。

### Step 5: 採用分を w-implementer に分けて並列で修正し、main がコミット

#### `review-resolution` の準備と対応不要分の返信（Step 4 の結果に関わらず実施）

Step 4 の選択が「すべて対応」「一部のみ対応」「対応なし」のいずれでも実施する。
w-implementer を spawn する場合は、実装者の tool result を待たず spawn 直後に次の 2 つを並行して進める。

1. `review-resolution` テンプレを `--prepare` で取得し、Step 4 の採否だけで書ける Decision 節と Declined 節を先に埋める。
   Applied 節は `review-findings` の General 節の採用分を下書きし、実装者の報告で確定させる。

   ```bash
   $PECOT issue comment --prepare \
     --template review-resolution \
     --issue <owner>/<repo>/<PR番号>
   ```

2. 対応不要とした F-NN のスレッドへ、その理由を `in_reply_to`（Step 3 の単発エンドポイント）で返信する。
   採否は Step 4 で確定しており実装結果に依存しないため、この時点で投稿する。Step 6 では返信しない。

「対応なし」が選ばれた場合は、以下の割り当て・spawn・コミットを行わない。この小節で prepare と全 F-NN への返信を済ませ、そのまま Step 6 へ進む。
指摘 0 件の場合は Step 4 のとおり Step 5 を丸ごと飛ばし、Step 6 の `review-resolution` を 0 件時の文言で投稿する。

#### 採用分の割り当て・spawn・コミット

Step 4 で「すべて対応」または「一部のみ対応」が選ばれた場合のみ実施。

複数 w-implementer の並列起動を既定とする。直列にする場合のみ理由を `w-implementer-1` の Goal 末尾に括弧書きで添える（例: `(直列の理由: ...)`）。

採用された F-NN を独立したファイル群で分け、ファイル群ごとに w-implementer を 1 体ずつ割り当てる。
同一ファイルを 2 体に渡さない。1 ファイルに複数 F-NN が集まる場合は、そのファイルごと 1 体に寄せる。
PR 本文の修正・欠落の指摘・横断的な設計指摘のようにファイルに紐づかない F-NN は main が担当し、割り当て表にも main の行として出す。

spawn 前に main が割り当て表（実装者名 / 担当 F-NN / 担当ファイル群）をチャットに書く。直列にする場合は該当行にも同じ括弧書きを出す。

複数体は 1 メッセージ内の複数 `Agent` 呼び出しで spawn する。別メッセージで順に spawn すると直列になる。

コミットは main の責務。全実装者の tool result が揃ってから 1 コミットにまとめる。
コミットメッセージには対応した F-NN を含めて Step 6 の対応報告と紐付けやすくする。対応不要とした F-NN は touch しない。

集約した指摘の修正は当該 PR 内ですべて完結させる。「軽微だから次 PR で」「粒度が小さいから別チケット化」といった先送りはしない。
採否は対応か対応不要の二値であり、判断を持ち越す「保留」という状態を作らない。対応不要とした F-NN はその時点で決着しており、
後続の宿題として持ち越さない。

### Step 6: CUJ 再実行・インラインスレッドの一括 resolve・`review-resolution` の投稿

#### CUJ 再実行

Step 2 で w-e2e-planner が CUJ を実行していた場合に限る。修正したファイルがその CUJ の起点または手順で読まれるファイル集合に含まれるなら再実行の対象になる。
対象のときは、コミット直後（修正完了と同時）に w-e2e-planner を `Agent` 単発 spawn して当該 CUJ を再実行させる。
spawn prompt には対象 CUJ の 3 要素（誰が・起点・合格基準）と修正内容の要約を貼る（単発 spawn は Step 2 の context を引き継がない）。
実投稿を含む CUJ は main が再実行する。

該当しない場合は再実行しない。要否の判断はチャット報告に 1 行残す（`review-resolution` 本文には書かない。テンプレの Applied 節の定義に当たらないため）。

w-e2e-planner の実行中、main は resolution 本文の確定を進める。resolve と `review-resolution` の投稿は再実行の結果を受けてから行う。
不合格なら Step 5 に戻る。戻るのは割り当て・spawn・コミットまでで、prepare と対応不要分の返信は初回限りとし再実行しない。再実行が無い場合はコミット直後に resolve へ進む。

#### インラインスレッドを一括 resolve

対象スレッドは Step 3 と同じ GraphQL クエリ（`reviewThreads(first: 100)`）を引き直して選ぶ。Step 3 の対応表は F-NN と alias 順の突合に使い、resolve 対象の選定は引き直したクエリで行う。
先頭コメント本文が `^\*\*(R\d+/)?F-\d+` に一致し、`isResolved` が false で、当ラウンドの Step 3 で作った対応表に載っている id のものだけを対象にする。
他者のスレッドは `**F-NN**` 前置きを持たないため自動的に除外され、前ラウンドで閉じ損ねたスレッドも対応表に無いため巻き込まない。

alias は `t1` から `tN` まで F-NN 順に振る。スレッド ID はリテラル埋め込みでよい（変数化は `mutation($t1: ID!, ...)` の宣言と `-f` を件数分並べるだけで利点が無い）。
クエリ文字列は件数が少なければリテラル手書きでよく、多ければ `jq` や python で組み立てる。

対応不要分の返信は Step 5 で投稿済み。採用分・対応不要分を同じ 1 リクエストで resolve する。conversation resolution を必須にしている配布先では、未 resolve のスレッドがあるとマージがブロックされるので、これを防ぐ。対応不要の判断そのものは `review-resolution` の Declined 節に残す。

```bash
gh api --hostname <対象ホスト> graphql -f query='
  mutation {
    t1: resolveReviewThread(input: {threadId: "<F-01 のスレッド id>"}) { thread { id isResolved } }
    t2: resolveReviewThread(input: {threadId: "<F-02 のスレッド id>"}) { thread { id isResolved } }
  }' \
  | jq -r 'if .data then (.data | to_entries[] | "\(.key) \(.value.thread.isResolved // "FAILED")")
           else "REQUEST FAILED: \(.errors // . | tostring)" end'
```

応答に `errors` があると `gh api` は `--jq` を適用せず生 JSON を出して exit 1 になるため、生 JSON をパイプで `jq` に渡す。
`data` ごと欠落する失敗は `REQUEST FAILED` の 1 行として理由込みで出る。`data` があれば alias ごとに独立して評価されるので、1 件の `NOT_FOUND` が他の resolve に波及しない。
`FAILED` と出た alias だけを再送する。出力行数が対象スレッド数と一致することを確認する。正常系は 1 リクエストで完了し、再送時のみ 2 回目が発生する。

#### `review-resolution` を投稿

Step 5 で下書きした本文を、出力ファイル内の `<!-- -->` ガイドに従って確定させて投稿する。指摘 0 件で Step 5 を飛ばした場合は、この時点で `--prepare` して 0 件時の文言で埋めた本文を使う。
各セクションの書式・指摘 0 件時の扱いはテンプレ側に集約してあるので prepare 出力をそのまま読む。
採用分の対応内容はコミットメッセージ内の F-NN が示すため、本文で再掲せず、コミット sha も併記しない。
対応・対応不要のどちらも resolve するため、resolve 状態は採否の判別子にならない。

```bash
$PECOT issue comment <編集後ファイル>
```

チャット側の最終報告は `review-resolution` コメント本文をそのまま再掲する（PR コメントとチャットで同じ内容を二重に読ませない）。マージが必要な場合は `/pecot-w:w-merge` を案内する。

## 注意

- レビュー指摘を盲目的に適用しない。Step 4 のユーザー一括確認をもって採否を決める。
- 返信と resolve は w-revise 自身が開いたスレッドに限る。他者が開いたスレッドへの返信・resolve はしない。Resolved 済みのスレッドは再対応しない。
- `review-findings` と `review-resolution` の F-NN は同一 PR で必ず一意に対応させる。
- 同一 PR で w-revise を 2 回目以降実行する場合、F-NN は実行ごとに `F-01` から振り直す（前回ラウンドの採番は引き継がない）。前後ラウンドの突き合わせはコメント投稿時刻と本文の `## Findings — <一行>` 見出しで識別する。
- 2 巡目以降、前ラウンドで自分が開いた未解決スレッドと同一趣旨の指摘は新規投稿せず、そのスレッドへの返信にする。新規に開くスレッドの本文前置きはラウンド識別子込み（`R2/F-01`）にする。
