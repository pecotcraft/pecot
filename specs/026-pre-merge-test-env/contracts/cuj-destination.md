# Contract: 計画の「流す先」と、エージェントの手順

配布物の変更。対象は pecot-workflow の plan テンプレと、エージェント 2 つ。
GitHub Copilot CLI 向けの写し（`com.github.copilot/agents/`）も同じに直す。

## plan テンプレ（`cli/templates/comment/plan.md`）（FR-022）

CUJ の項目に「流す先」を足す。並びは、誰が・起点・流す先・テスト手順・合格基準。

```text
CUJ 1

- 誰が — <利用者 / エージェント。どの環境・セッションで>
- 起点 — <スキル / MCP ツール / hook を発火させる実ツール / CLI コマンド>
- 流す先 — <検証用のリポとボード / 手元>
- テスト手順
  1. …
- 合格基準 — <利用者が見る出力・状態>
```

「流す先」の書き方の決まりを、テンプレの CUJ の説明に足す。

| 場合 | 書く値 |
|---|---|
| 外へ書き込む CUJ で、プロジェクトの指示に検証用の場所がある | その検証用の場所 |
| 外へ書き込む CUJ で、プロジェクトの指示に検証用の場所が無い | 作業中のリポ |
| 外へ書き込まない CUJ | 手元 |

- 外へ書き込むとは、Issue・PR・ブランチ・ボード・リリースなど、リポの外から見えるものを作る・変えることを指す
- テンプレの例（`mytool export`）の 3 つの CUJ には、「流す先 — 手元」を足す

## CUJ の流し方（`skills/w-help/references/cuj-run.md`）（FR-023）

w-e2e-planner は消し、計画の CUJ は main が流す（research の R5）。

| 今 | 直した後 |
|---|---|
| w-e2e-planner が CUJ を流し、実投稿は main に委ねる | main が cuj-run.md に従って流す。w-e2e-planner は無い |
| 流す先の区別が無い | 流す先が検証用の CUJ は、検証用の clone を作業ディレクトリにして流す。プラグインの CUJ は、その clone で子の CLI を起こし、子の MCP ツールで書き込む |

- 今のセッションの MCP ツールに `repo` を渡して検証用を指す形は使わない（R11-7）
- Verified には、できたものの URL を載せる
- 確かめで作ったものの名前の形と、片付けは、プロジェクトの指示に従う。指示が無ければ、作ったものを Verified に並べる

## w-reviewer（`agents/w-reviewer.md`）（FR-024）

`[cuj]` の視点に、次の 2 つを足す。

| 見る点 | 指摘 |
|---|---|
| CUJ に「流す先」の項目が無い | 欠けとして、CUJ の番号を挙げる |
| プロジェクトの指示に検証用の場所があるのに、外へ書き込む CUJ の流す先が作業中のリポになっている | 作業中のリポで流す計画として、CUJ の番号を挙げる |

- プロジェクトの指示に検証用の場所が無いリポでは、2 つ目を挙げない（FR-025）

## テスト

| テスト | 足す期待 |
|---|---|
| `cli/tests/hooks/cuj-definition-single-source.test.ts` | CUJ の定義の文が 3 か所で同じ、の確かめに、「流す先」の決まりの文を含める |
| `cli/tests/skills/template-rules.test.ts` | plan テンプレの CUJ の例に「流す先」がある |
| `com.github.copilot/agents/` との同期のテスト | 既存の同期のテストが通る |

## プロジェクトの指示（このリポ）

`CLAUDE.md` に、次を書く。配布しない。

- 検証用の場所は `pecotcraft/pecot-sandbox` とボード `pecot sandbox`
- 外へ書き込む CUJ は、検証用を流す先にする。このリポを流す先にしない
- 手順は `plugins/pecot-workflow/CONTRIBUTING.md` の試験環境の節にある
