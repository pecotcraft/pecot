# Feature Specification: AIST から名前を変えて公開し、MCP の単体配布を npm に移す

**Feature Branch**: `018-public-release-readiness`

**Created**: 2026-11-03

**Status**: Draft

**Input**: Epic aistcraft/aist-roadmap#18。Organization `aistcraft` の 4 リポは、どれも private で運用している。公開してよい中身かを確かめ、公開すると決めたリポを public にする。利用者が認証なしでプラグインと MCP サーバを入れられる状態にする。

## 背景

spec 017 は、社外の 4 リポを private のまま移し、public にする判断を後続の Epic に回した。本 spec がその後続にあたる。

社外の 4 リポの今の状態は次のとおり（2026-11-03 時点、各リポの `origin/main`）。

| リポ | 公開状態 | LICENSE | 役割 |
|---|---|---|---|
| aist-plugin | private | MIT（#32 で追加） | 3 つのプラグインのソースと、リリースの起点 |
| aist-visual-mcp | private | 無し | aist-visual の MCP サーバのビルド済みの配布物。リリースのたびに aist-plugin から commit される |
| aist-tools-mcp | private | 無し | aist-tools の MCP サーバの配布物。同上 |
| aist-roadmap | private | 無し | 開発の計画の置き場だった。spec と speckit の成果物（001〜017）、Issue、ボードの設定を持つ。廃止する（FR-006） |

名前の事情は次のとおり。

- `aist` は名前がかぶる。GitHub では既存のユーザー名で、検索では Google AI Studio と産総研（AIST）に埋もれる。Organization を `aistcraft` にしたのはこのためだった
- aist-plugin では、3,927 ファイルのうち 1,149 ファイルの中身に `aist` が出る。`plugins/aist-*` の配下にあるため、パスにも 3,801 ファイルが該当する
- 利用者に見える名前は次のとおり
  - Organization・リポ・marketplace・文書の製品名
  - プラグイン（`aist-w`・`aist-v`・`aist-t`）とスキル名
  - CLI（`aist`・`aistv`・`aist-tools`）と MCP サーバ
  - 設定のディレクトリ `.aist/`・`.aistv/` と環境変数 `AIST_*`・`AISTV_*`
  - データの置き場 `~/.local/share/aist/` と、ボードのフィールド名の接頭辞 `aist-workflow-`
  - 公開したリポの Releases に出るタグの接頭辞（`aist-visual-v*` など）

配布と中身の事情は次のとおり。

- 配布リポを分けた理由は 2 つあった（spec 011 の research R8）。配布元の GitHub で npm のパッケージが使えなかったこと。配布物を読める人をリポの権限者に絞りたかったこと
- 公開すると、2 つの理由はどちらも無くなる。npm の public registry から `npx` で取得でき、配布リポを経る必要が無い
- プラグインの MCP サーバは、配布リポを使わない。プラグイン自身の `bin/` から起動する
- 配布リポへの publish は、aist-plugin のリリースの手順（`plugins/*/scripts/release/publish-mcp-dist.sh`）が行う
- 社外の 4 リポの履歴は、移送の時点の main を 1 commit にしたものから始まる（aistcraft/aist-roadmap#17）。aist-plugin の最初の commit は、`dxc` を含む 367 ファイルと Zscaler Root CA を含む
- aist-plugin には PR が 17 件ある（close 済みを含む）。14 件は Dependabot が最初の commit から作った。GitHub は PR ごとの参照（`refs/pull/N/head`）を消さないため、main を作り直しても最初の commit は取得できる
- 移送の名残の除去は Epic aistcraft/aist-roadmap#14 が持つ。aistcraft/aist-plugin#28・#30 と aistcraft/aist-roadmap#15 が未完了で残る
- aist-plugin の `plugins/aist-visual/assets/certs/` は Zscaler Root CA を同梱する。aist-visual の CLI は、`NODE_EXTRA_CA_CERTS` が未設定のときにこれを渡す
- 第三者の素材は 2 つある
  - `plugins/aist-visual/assets/drawio-icons/` — Lucide のアイコン。ISC License で、LICENSE を同梱する
  - テストの書体 — Inter と Noto Sans JP。OFL の文面を同梱する
- aist-plugin の README はプラグインの導入に `gh auth login` を前提にする。MCP 配布 2 リポの README は配布元への git 認証を前提にする
- aist-plugin の `SECURITY.md` は、報告を公開 Issue で受け付ける。リポを読める人が限られることを理由にしている
- Organization は Free プランで、ボード `AIST-project` は private である

## Clarifications

### Session 2026-11-03

- Q: どのリポを公開するか → A: 配布リポを分ける意味が無い。公開すれば npm から配れるため、MCP の単体配布は npm に移し、配布 2 リポは畳む
- Q: ライセンスは → A: MIT
- Q: 公開の許可の前提を spec に書くか → A: 書かない。公開の前の経緯は spec に持ち込まない
- Q: MCP 配布 2 リポは、アーカイブと削除のどちらにするか → A: 削除する。読めるのは所有者だけで、ほかに使う人がいない。npm への最初の publish を確かめてから消す
- Q: aist-plugin を公開するとき、履歴を作り直すか → A: 公開の直前に、点検を終えた main を 1 commit に作り直す。各系列の最新のタグを付け直す
- Q: 1 commit にした中身だけを公開するには、PR の参照が残る今のリポは使えない。どうするか → A: 新しいリポで公開する。今のリポは改名して private で残す。続ける open の Issue だけを起票し直す
- Q: CHANGELOG の過去の項目をどう扱うか → A: 新しいリポへ入れるときに 1 回だけ、先頭の見出しと 1 文だけにする。公開後の最初のリリースから nx が書き始め、以後は手で編集しない
- Q: 新しいリポを作るのに合わせて、AIST から名前を変えるか → A: 変える。`aist` は名前がかぶりすぎている
- Q: どの範囲まで名前を変えるか → A: 利用者に見える範囲すべて。内部の名前（ソースのディレクトリ・nx の project 名・識別子）は後の Epic で直す
- Q: 新しい名前はどう決めるか → A: plan で候補を出し、その中から選ぶ
- Q: 改名を本 spec に含めるか → A: 含める。新しいリポと npm への最初の publish を、新しい名前で行う
- Q: タグの接頭辞も変えるか → A: 変える。公開したリポの Releases に出るため、利用者に見える名前として扱う。接頭辞は、新しいリポでタグを付け直すときから新しくする
- Q: GitHub Copilot CLI 向けの構成と表記も変えるか → A: 変えない。Epic aistcraft/aist-roadmap#10 で扱う
- Q: 名前の候補を選ぶ基準は → A: SNS で手軽に周知できること。一度聞けば綴れ、短く、ハッシュタグと検索で同じ領域の既存の製品に埋もれない

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 利用者が、認証なしでプラグインを入れられる (Priority: P1)

GitHub にログインしていない利用者が、公開したリポの README の手順だけで、Claude Code に 3 つのプラグインを入れる。

**Why this priority**: 公開の目的は、誰でも入れて使えることにある。

**Independent Test**: GitHub の認証情報が無い環境で、README の手順どおりに導入する。プラグインのスキルが動く。

**Acceptance Scenarios**:

1. **Given** GitHub の認証情報が無い Claude Code の環境、**When** README の手順で導入する、**Then** 3 つのプラグインが入り、スキルが動く
2. **Given** 公開したリポの既定ブランチ、**When** ルートを見る、**Then** MIT の LICENSE がある

---

### User Story 2 - 利用者が、MCP サーバを npm から入れられる (Priority: P1)

プラグインを使わない MCP クライアントの利用者が、`npx` で 2 つの MCP サーバ（今の aist-visual と aist-tools）を入れる。配布リポを経ず、GitHub の認証も要らない。

**Why this priority**: 配布リポは非公開のための回り道だった。公開と同時に npm へ移さないと、配布リポも公開して保守し続けることになる。

**Independent Test**: GitHub の認証情報が無い MCP クライアントに、npm のパッケージを指す設定を 1 件登録する。サーバが起動し、ツールの一覧が返る。

**Acceptance Scenarios**:

1. **Given** GitHub の認証情報が無い MCP クライアント、**When** README の設定を登録する、**Then** 2 つの MCP サーバが起動し、ツールの一覧が返る
2. **Given** リリース担当者、**When** リリースの手順を実行する、**Then** 2 つの MCP サーバの新しい版が npm に出る。追加の手作業は無い
3. **Given** 版を固定したい利用者、**When** README を読む、**Then** 版を指定して登録する方法がわかる
4. **Given** リリースの手順、**When** 中身を見る、**Then** 配布リポへの commit と push が無い

---

### User Story 3 - 利用者が、新しい名前で探して使える (Priority: P1)

利用者が新しい名前で検索し、公開したリポと npm のパッケージにたどり着く。導入した後に打つコマンド、置く設定、目にする名前は、どれも新しい名前に揃っている。

**Why this priority**: `aist` のままでは、検索で他の製品と研究機関に埋もれて見つからない。公開した後に名前を変えると、npm のパッケージと marketplace の名前が利用者の手元に古いまま残る。

**Independent Test**: 新しい名前で GitHub と npm を検索し、公開したリポとパッケージが見つかる。導入した環境で、利用者に見える名前から `aist` が消えていることを確かめる。

**Acceptance Scenarios**:

1. **Given** 決めた新しい名前、**When** GitHub の Organization と npm のスコープを確かめる、**Then** どちらも本 spec の所有者が持っている
2. **Given** 新しい名前で導入した環境、**When** プラグイン名・スキル名・CLI・MCP サーバ名・設定のディレクトリ・環境変数を見る、**Then** どれも新しい名前に揃い、`aist` が残っていない
3. **Given** 公開したリポの README と文書、**When** 製品名を探す、**Then** 新しい名前だけが出る

---

### User Story 4 - 公開する中身を、公開の前に点検し終えている (Priority: P1)

所有者が、公開するリポの追跡ファイルと、npm に出す配布物を点検する。公開に向かない記述と同梱物、秘密情報、第三者の素材を洗い出し、1 件ずつ「消す・残す」を決める。

**Why this priority**: public へ切り替えると、既定ブランチと履歴のすべてを誰でも読める。後から消しても、clone やキャッシュに残る。今の履歴の最初の commit は、移送の時点の中身をすべて含む。

**Independent Test**: 公開したリポの履歴が 1 commit から始まり、公開前の PR と Issue が無いことを確かめる。その中身と npm に出す配布物を、点検の語と秘密情報のスキャンにかける。一致は例外の一覧のものだけになる。

**Acceptance Scenarios**:

1. **Given** 公開するリポの既定ブランチ、**When** 点検の語を検索する、**Then** 一致は例外の一覧のファイルだけになる
2. **Given** 1 commit に作り直す前の main、**When** 秘密情報をスキャンする、**Then** 検出が 0 件か、各検出に「秘密ではない」理由がある
3. **Given** public にしたリポ、**When** 履歴と PR と Issue を見る、**Then** 履歴は 1 commit から始まり、公開前の PR と Issue は無い。各系列の最新のタグがその commit 以降を指す
4. **Given** npm に出す配布物、**When** 中身を見る、**Then** 特定の環境向けの同梱物（Zscaler Root CA など）とソースマップが入っていない
5. **Given** 通信を復号するプロキシの配下の利用者、**When** README を読む、**Then** 自分の CA を `NODE_EXTRA_CA_CERTS` で渡す手順がわかる

---

### User Story 5 - 公開したリポが、公開の直後から守られている (Priority: P2)

所有者が、公開したリポで秘密情報の検出、依存の脆弱性の通知、main の保護を有効化する。脆弱性を見つけた利用者は、`SECURITY.md` から非公開の報告先にたどり着ける。

**Why this priority**: 公開すると、第三者が読み、Issue と PR を送ってくる。

**Independent Test**: 公開したリポの設定画面と `SECURITY.md` を開いて確かめる。

**Acceptance Scenarios**:

1. **Given** public にしたリポ、**When** 設定を見る、**Then** FR-022 の 4 つの設定が有効である
2. **Given** 公開したリポの main、**When** force push か削除を試みる、**Then** ruleset が拒否する
3. **Given** 脆弱性を見つけた利用者、**When** `SECURITY.md` を読む、**Then** 非公開で報告する手段がわかる

---

### Edge Cases

- #14 が終わる前に公開を始めた場合。導入手順が移送前の URL を指したままで、User Story 1 が通らない。公開は #14 の完了を待つ
- 候補の名前の GitHub の Organization か npm のスコープが、他者に取られている場合。その候補は選ばない。名前を決めたら、公開の作業より先に両方を押さえる
- MCP サーバ名を変えると、Claude Code での MCP ツールの名前（`mcp__plugin_` で始まる）が変わる。ツールの名前を書いた hooks・許可の設定・スキルを、同じ変更で書き換える
- 設定のディレクトリと環境変数の名前を変えると、所有者の開発環境とボードの設定が読まれなくなる。古い名前を読む互換の仕組みは作らず、所有者の環境とボードの設定を移す手順で済ませる
- 配布リポを読めるのは所有者だけで、ほかに使う人はいない。そのため告知を出さずに消す。所有者の開発環境に配布リポを指す設定があれば、npm を指す設定に書き換える
- 秘密情報のスキャンで、テストの偽のトークンが検出される場合。秘密ではない理由を例外に書き、値は消さない
- Zscaler Root CA を外すと、そのプロキシの配下で `NODE_EXTRA_CA_CERTS` を設定していない利用者は、`setup` の取得に失敗する。README が設定の手順を示す
- 公開したリポの README と文書が、private のリポ（aist-roadmap）や公開前の Issue を指す場合。利用者には 404 に見える。導入と利用に要るリンクは残さない
- 新しいリポは今のリポと共通の祖先を持たない。切り替えの前に作業中のブランチを main に入れるか閉じ、切り替えの後に clone し直す
- 新しいリポに push すると、Dependabot が依存の更新の PR を作り直す。中身は点検を終えた main から分岐するため、公開してよい
- 公開の後で問題が見つかった場合。リポを private に戻し、直してから再び公開する。npm に出した版は取り下げても、すでに取得された分は戻らない

## Requirements *(mandatory)*

### Functional Requirements

名前:

| ID | 内容 |
|---|---|
| FR-001 | 新しい名前の候補を出し、所有者が 1 つ選ぶ。候補ごとに、SNS での言いやすさ、npm のスコープと GitHub の Organization の空き、検索とハッシュタグのかぶりを示す。Organization 名は名前の別形（`<name>-dev` など）でもよい |
| FR-002 | 選んだ名前で、GitHub の Organization と npm のスコープを押さえる。今の Organization `aistcraft` は、新しい名前に改名するか移す |
| FR-003 | 利用者に見える名前を、新しい名前に揃える。対象は背景の「利用者に見える名前」の一覧のすべて |
| FR-004 | 古い名前を読む互換の仕組み（別名・古いディレクトリや環境変数の読み込み）は作らない |
| FR-005 | 内部の名前（ソースのディレクトリ・nx の project 名・コードの識別子・内部だけで使う環境変数）も新しい名前にする。リポの外に実体がある名前は変えない |
| FR-005a | GitHub Copilot CLI 向けの構成（`.github/plugin/`、Agent Plugins 1.0 のマニフェスト）は本 spec では変えない。Epic aistcraft/aist-roadmap#10 で扱う。導入先のパスは名前から決まるので、新しい名前に従う |
| FR-006 | aist-roadmap を開発のリポとしては廃止し、開発に要るものを aist-plugin に移す。移すのは、この spec（`specs/018-public-release-readiness/`）、speckit（`.specify/`、`.claude/skills/speckit-*`）、`.devcontainer/`(tmux のスクリプトは `.devcontainer/tmux/`)、`CLAUDE.local.md` の実体の置き場である。ボードの設定（`.pecot/config/projects/*.json`・`.active`）は aist-plugin で git 管理にする。所有者の開発環境と設定は、新しい名前に移す。spec 001〜017 は aist-roadmap に残す |

配布:

| ID | 内容 |
|---|---|
| FR-007 | 2 つの MCP サーバを、新しい名前の npm のスコープの下で public registry に出す |
| FR-008 | リリースの手順は、配布リポへの commit の代わりに npm への publish を行う。リリース担当者の追加の手作業を増やさない。同じ版の再実行で二重に publish しない |
| FR-009 | npm への最初の publish で 2 つの MCP サーバが起動することを確かめてから、aist-visual-mcp と aist-tools-mcp を削除する。リリースの手順から、配布リポへの commit と push、配布リポ向けの記述を除く |
| FR-010 | README の MCP 単体配布の手順を、npm のパッケージを指す設定に書き換える。版を固定する方法を含める |
| FR-011 | プラグインの導入手順を、認証なしの取得に書き換える。`gh auth` の前提は、ワークフローのプラグインがボードを操作するのに要る範囲だけに残す |
| FR-012 | 各パッケージの `license` を、ルートの MIT の LICENSE（#32 で追加済み）に揃える。npm に出すパッケージも MIT にする |

中身の点検と新しいリポ:

| ID | 内容 |
|---|---|
| FR-013 | 公開の前に、点検する語を決める。少なくとも `github.dxc.com`・`dxc`・`khayakawa`・`Zscaler`・`社内` を含む |
| FR-014 | 公開するリポの既定ブランチと npm に出す配布物で、FR-013 の語を検索する。一致したファイルごとに「消す・残す」を決め、残すファイルは理由とともに例外の一覧に載せる |
| FR-015 | 1 commit に作り直す前の main を、秘密情報のスキャンにかける。検出ごとに「消す・秘密ではない」を決める。秘密を検出した場合は、その値を失効させる |
| FR-016 | Zscaler Root CA をリポと配布物から外し、`NODE_EXTRA_CA_CERTS` への自動の受け渡しをやめる。README に、利用者が自分の CA を渡す手順を書く |
| FR-017 | 第三者の素材を一覧にし、素材ごとにライセンスと表記の置き場所を書く。npm に出す配布物に含む素材は、配布物にも表記を入れる |
| FR-018 | 公開の直前に、今の aist-plugin を改名して private で残す。新しい名前の Organization に新しいリポを作り、点検と改名を終えた main を 1 commit にして push する。各系列の最新のタグをその commit に付ける |
| FR-019 | FR-018 で新しいリポに入れる前に、すべての CHANGELOG の過去の項目を消す。消すのはこの 1 回だけで、以後の項目は nx が生成する |
| FR-020 | 今の aist-plugin と aist-roadmap の open の Issue のうち、続けるものを新しいリポで起票し直し、ボードに載せる。続けない Issue はそれぞれのリポで閉じる。Issue は移さない |

公開と公開後:

| ID | 内容 |
|---|---|
| FR-021 | 新しいリポを public にする。aist-roadmap は Issue の置き場として private で残す |
| FR-022 | 公開したリポで、secret scanning、push protection、Dependabot alerts、Private vulnerability reporting を有効にする。main に、force push と削除を禁止する ruleset を入れる |
| FR-023 | ruleset は、ワークフローでのマージとリリース（main への commit とタグの push）を妨げない |
| FR-024 | `SECURITY.md` を、Private vulnerability reporting で非公開に報告する手順に書き換える |
| FR-025 | ボードは private で残す。改名して残すリポの Issue は、ボードから外す |
| FR-026 | 公開は Epic aistcraft/aist-roadmap#14 の完了後に行う。順番は、名前の決定と取得、改名、npm への最初の publish、配布リポの削除、新しいリポへの切り替え、公開とする |

### Key Entities

| 名前 | 内容 |
|---|---|
| 新しい名前 | AIST に代わる製品名。GitHub の Organization・npm のスコープ・プラグイン・CLI の名前の元になる |
| 名前の候補の一覧 | 候補ごとの、GitHub と npm の空き、検索でのかぶり |
| 利用者に見える名前の対応表 | 今の名前と新しい名前の 1 対 1 の対応 |
| npm のパッケージ | 2 つの MCP サーバ。版はプラグインの版と揃う |
| 公開するリポ | 新しい名前の Organization に作るリポ。点検と改名を終えた main の 1 commit から始まる |
| 改名して残すリポ | 今の aist-plugin。private のまま、公開前の履歴・PR・Issue を持つ |
| 点検の語 | 公開に向かない記述を見つけるために検索する語の一覧 |
| 例外の一覧 | 点検の語を含んだまま公開するファイルと、残す理由 |
| 秘密情報のスキャンの結果 | 検出と、検出ごとの「消す・秘密ではない」 |
| 第三者の素材の一覧 | 素材・ライセンス・表記の置き場所 |
| 公開後の設定 | secret scanning・push protection・Dependabot alerts・Private vulnerability reporting・ruleset の状態 |

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | 内容 |
|---|---|
| SC-001 | 新しい名前の GitHub の Organization と npm のスコープを、所有者が持っている |
| SC-002 | 新しい名前で導入した環境で、利用者に見える名前（FR-003 の対象）に `aist` が 0 件 |
| SC-003 | 公開したリポが public で、ルートに MIT の LICENSE を持つ |
| SC-004 | GitHub の認証情報が無い環境で、README の手順だけでプラグイン 3 つを入れ、スキルが 1 つ以上動く |
| SC-005 | GitHub の認証情報が無い MCP クライアントで、npm のパッケージを指す設定だけで 2 つの MCP サーバが起動し、ツールの一覧が返る |
| SC-006 | リリースを 1 回通し、2 つの MCP サーバの新しい版が npm に出る。リリース担当者の手作業は今より増えない |
| SC-007 | aist-visual-mcp と aist-tools-mcp が削除済みで、公開したリポの追跡ファイルに 2 リポを指す記述が無い |
| SC-008 | 公開したリポの既定ブランチと npm の配布物で点検の語を検索し、一致は例外の一覧のファイルだけになる |
| SC-009 | 作り直す前の main の秘密情報のスキャンで、理由の無い検出が 0 件。公開したリポの履歴は 1 commit から始まり、公開前の PR と Issue を持たない |
| SC-010 | 公開したリポで、FR-022 の 4 つの設定が有効で、main の force push と削除が拒否される |
| SC-011 | 公開の後、ワークフローで Issue の作成からリリースまでを 1 回通し、ruleset に止められない |
| SC-012 | この spec の成果物が aist-plugin の関門（text-lint を含む）を通る |

## Assumptions

- aist-roadmap は、廃止した後も GitHub のリポとして残る。置き場は既存の Issue と spec 001〜017 になる。利用者が読む必要は無いので、公開せず、リポ名も変えない
- 利用者向けの窓口は、公開したリポの Issue と Private vulnerability reporting にする。メールなどの別の窓口は作らない
- CHANGELOG は nx の version plan から生成し、手動で編集しない。FR-019 の 1 回だけを例外とする
- 新しい名前の npm の Organization は、まだ作っていない。作るのは本 spec の作業に含める
- MCP サーバの npm の版は、対応するプラグインの版と同じにする。プラグインの版の番号は改名の前から続ける
- 今のプラグインを使っているのは所有者だけである。改名で入れ直しが要るのは所有者の環境だけ
