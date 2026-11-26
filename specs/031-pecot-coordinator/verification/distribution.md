# 検証: claude.ai への配り方と、読まれるか（Phase 3）

Issue #790（T021〜T027）の記録。書き込みは検証用のリポ `pecotcraft/pecot-sandbox` と、利用者の claude.ai の account だけに行った（FR-005）。

## 読んだ文書と条件

| 文書 | URL | 版・日付 |
|---|---|---|
| claude.ai のプラグイン | <https://claude.com/docs/plugins> | 版の表示なし。2026-11-26 に読んだ |
| 部品ごとの対応表 | <https://claude.com/docs/plugins/platform-support> | 同上 |
| 組織の sync | <https://claude.com/docs/plugins/org-sync> | 同上 |
| Claude Code のプラグインの読み込み | <https://code.claude.com/docs/en/plugins/loading> | 同上 |
| marketplace の形 | <https://code.claude.com/docs/en/plugins/marketplace-reference> | 同上 |
| クラウドの環境 | <https://code.claude.com/docs/en/cloud-environments> | 同上 |
| MCP の版の扱い（Versioning and Compatibility） | <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning> | 2026-07-28（`/specification/latest` と同じ中身）。2026-11-26 に読んだ |

文書から読んだこと。

- 入れる画面は **Customize > Plugins**（<https://claude.ai/customize/plugins>）。「On the **Plugins** page, you add a plugin from **Discover**, **Add > Add marketplace**, or **Add > Upload plugin**.」
- marketplace の指し方は「Enter a repository URL such as `https://github.com/your-org/your-plugins` or the `owner/repo` shorthand for GitHub.」。ブランチの指し方と、個人の marketplace が読むブランチは書いていない
- 更新は「To pull the latest from a marketplace you added, select **Check for updates**. For a marketplace you added yourself from github.com, you can also turn on **Sync automatically**.」
- 直下の `bin/` は、Chat と Cowork で「Can't be installed」。「a component marked 'Can't be installed' makes that surface refuse the whole plugin.」
- 組織の sync は「Organization sync reads the project's default branch.」。止まる文は「The error message starts with `Plugin contains a top-level bin/ directory`」。個人の marketplace で止まる文は書いていない
- 同期したプラグインは `<name>@synced` として読まれる。クラウドのセッションでは「they download when you start a session or Claude starts a thread in your project」

条件

- 確かめた日は 2026-11-26（UTC）。claude.ai は利用者の個人の account
- 利用者の claude.ai のプランと、marketplace の **Sync automatically** をオンにしたかは、利用者に尋ねたが答えを得られず、未確認
- クラウドのスレッドの環境の Network access は Default（limited）で、Allow package managers と MCP servers がオン。追加の許可ホストは無い
- Claude Code は、手元の検証もクラウドのスレッドも 2.1.332

## 試しのプラグイン（T021）

sandbox の既定のブランチに、[PR #645](https://github.com/pecotcraft/pecot-sandbox/pull/645)（merge commit `f27bff9437b3b48268bb6a83d163fc9c641bfc4b`、2026-11-26 07:38 UTC）で置いた。

| 置き場所 | 中身 |
|---|---|
| `.claude-plugin/marketplace.json` | `name: pecot-probe`。下の 2 つを `./cuj-790/` から指す |
| `cuj-790/pecot-probe/` | スキル `probe` だけ。版 0.1.0。本文の合言葉は `pecot-probe-v1-x8t0jrc9` |
| `cuj-790/pecot-probe-bin/` | スキル `probe-bin` と、直下の `bin/probe-bin`（mode 100755）。版 0.1.0。合言葉は `pecot-probe-bin-dnfdr3` |

ブランチを指す形の確かめのため、ブランチ `cuj/790-r65v` に、`name: pecot-probe-branch` の marketplace とプラグイン `pecot-probe-branch`（合言葉は `pecot-probe-branch-eyjuofoy`）を置いた。

Claude Code 2.1.332 の `claude plugin validate --strict` は、3 つとも通った。`bin/` を持つ `pecot-probe-bin` も通り、`bin: probe-bin` を部品として挙げるだけだった。claude.ai が拒むかは、この検証では分からない。

## 入れる方法ごとの結果（T022・T023）

2026-11-26 07:52 UTC ごろ、利用者が **Customize > Plugins** の **Add > Add marketplace** に `pecotcraft/pecot-sandbox` を入れた。

| 方法 | 結果 | 出た文 |
|---|---|---|
| 個人の Add marketplace（既定のブランチ）の `pecot-probe` | 入った。claude.ai の記録の `updatedAt` は 07:52:19 UTC | なし |
| 同じ marketplace の `pecot-probe-bin`（直下に `bin/`） | marketplace の中に出てこず、**Add** する手段が無かった | なし。止まった文も出ない |
| 個人の Add marketplace でブランチを指す形（`pecotcraft/pecot-sandbox#cuj/790-r65v`） | 受け付けられなかった | 「マーケットプレイスのソース形式が無効です。GitHub の owner/repo または完全な Git URL を入力してください。」（入力欄の説明は「GitHub の owner/repo または Git リポジトリの URL。」） |
| 組織の sync | 試していない。このリポも sandbox も public で、文書は private か internal のリポを求める | — |

- `bin/` を持つプラグインは、止まる文を出さずに、marketplace の一覧から外される。利用者からは、プラグインが無いように見える
- 版を上げたときは、マージの後に利用者が **Check for updates** を押さないうちに、マージから 4 秒で claude.ai の記録が更新された。**Sync automatically** の状態は未確認
- claude.ai の Add marketplace は、Claude Code の `owner/repo#ref` の形を受け付けない。個人の marketplace は、既定のブランチにマージした版を配る

## coordinator で読まれたか（T024）

2026-11-26 07:53 UTC に、このプロジェクトの coordinator に、ファイルやリポを読まずにスキルの一覧を答えさせた。

- 一覧に `pecot-probe:probe`・`pecot-probe-bin:probe-bin` は無かった
- 答えた一覧: dataviz、keybindings-help、code-review、simplify、claude-api、run、plugin-authoring、anthropic-skills:*（docs、google-workspace、computer-use、chrome-browser、built-in-browser、deep-research、import-memory、morning、skill-creator、xlsx、pptx、pdf、docx）、init、security-review
- coordinator の会話は、入れる前（07:25 UTC より前）に始まっていた。途中で文脈の圧縮も挟んでいる

07:55 UTC ごろ、同じ会話の途中で `pecot-probe:probe` が一覧に加わった。`pecot-probe-bin:probe-bin` は加わらなかった。

- Skill ツールで `pecot-probe:probe` を起動すると、合言葉 `pecot-probe-v1-x8t0jrc9` を答えた
- スキルの置き場所は `/root/.claude/plugins/synced/70e7ed0a-…_b36d725b-…/pecot-probe/skills/probe`。coordinator も Claude Code の同期の仕組み（`synced/`）でプラグインを読んでいる
- 入れてから一覧に出るまで数分かかったが、会話を始め直さなくても読まれた

## クラウドのスレッドで読まれたか（T024）

2026-11-26 07:55 UTC ごろ、coordinator にクラウドのスレッドを 1 つ起動させ、書き込まずに確かめさせた。

- `CLAUDE_CODE_REMOTE=true`、セッションは `cse_01PA5PKeTwoATCmhP1NBFcuh`、Claude Code 2.1.332。クラウドの VM で動いた
- `~/.claude/plugins/synced/` の下に bucket が 1 つ（`70e7ed0a-966a-4ab7-b571-ea8a5773ff2f_b36d725b-c9be-429f-bebf-a67cdf8438b3`、07:53 作成）。coordinator と同じ bucket の名前
- `<bucket>/pecot-probe/.claude-plugin/plugin.json` の `version` は `0.1.0`
- bucket の `manifest.json` の項目は `pecot-probe` の 1 件だけ。`version: "0001"`、`updatedAt: 2026-11-26T07:52:19Z`、`marketplaceName: pecot-sandbox`、`installationPreference: available`、`marketplaceKind: account_marketplace`
  - manifest の `version` は claude.ai が付けた番号で、plugin.json の `0.1.0` ではない。loading の文書の「the version claude.ai records for the plugin is its version, and the manifest's `version` isn't read」と合う
  - `marketplaceName` は marketplace.json の `name`（`pecot-probe`）ではなく、リポの名前（`pecot-sandbox`）になっている
- `pecot-probe-bin` は `synced/` にも manifest にも無い。claude.ai で拒まれたものは、Claude Code が `bin/` を読めても届かない
- スキルの一覧に `pecot-probe:probe` があり、`pecot-probe-bin:probe-bin` は無い。Skill ツールで起動すると、合言葉 `pecot-probe-v1-x8t0jrc9` を答えた

## クラウドの VM で npm に届くか（T026）

同じスレッドで確かめた。

| 項目 | 結果 |
|---|---|
| 版 | node v22.23.5、npm 10.9.9、pnpm 10.28.0。`/opt` に `node22`・`node22-stock`・`node24` がある |
| Network access | Default（limited）。Allow package managers はオン、MCP servers もオン、追加の許可ホストは無し。`registry.npmjs.org`・`pypi.org` は 200、`example.com`・`www.wikipedia.org` は 403 |
| `npm view @pecot/workflow-mcp@9.0.0`（リポの外） | 届いた。`engines.node` は `^24.22.1 \|\| >=26.12.1` |
| `npx --prefix="$HOME/.pecot-probe-npx" -y @pecot/workflow-mcp@9.0.0` に initialize・tools/list | `EBADENGINE` の警告が出たが、止まらずに動いた。`protocolVersion: 2025-11-25`、`serverInfo: {pecot-workflow, 9.0.0}`、`capabilities: {tools: {listChanged: true}}`、ツールは 39 件、終了コード 0 |
| `pnpm install --frozen-lockfile`（pecot の checkout、HEAD `8b41c65`） | 終了コード 0。`packageManager` の指定で pnpm v12.15.0 に切り替わり、+1591 パッケージ、6.1 秒 |

## 版を上げたときに届くか（T025）

sandbox で `pecot-probe` を 0.2.0 にし、合言葉を `pecot-probe-v2-enna5iba` に変える [PR #647](https://github.com/pecotcraft/pecot-sandbox/pull/647) を、2026-11-26 07:59:06 UTC にマージした（merge commit `db8a93e573010c8a73bc24c0e56e3f5c9936113b`）。

### 続いている coordinator の会話

07:59:25 UTC に、v1 を読んだ後も続いている coordinator の会話で確かめた。

- `manifest.json` の `pecot-probe` は `version: "0002"`、`updatedAt: 2026-11-26T07:59:10.741409Z`、`generation: 2`。マージから 4 秒で、claude.ai の記録が新しい版になった
- `staleDirs` に `["pecot-probe"]` が入り、`pecot-probe/.claude-plugin/plugin.json` の `version` は `0.1.0` のままだった
- Skill ツールで `pecot-probe:probe` を起動すると、「this plugin entry changed after the session listed it, so it was not run; a new session lists it as it is」で止まった
- 会話の途中で版が上がると、その会話では古い版も新しい版も動かない

### マージの後に起動したクラウドのスレッド

coordinator に新しいクラウドのスレッドを起動させた（セッション `cse_01PA5PKcY2ZYDkypr1gsmyYa`、07:59:31 UTC 開始、07:59:45 UTC に実行）。

- `manifest.json` の `pecot-probe` は `version: "0002"`、`updatedAt: 2026-11-26T07:59:10.741409Z`。`staleDirs` は無い
- `plugin.json` の `version` は `0.2.0`
- Skill ツールで `pecot-probe:probe` を起動すると、合言葉 `pecot-probe-v2-enna5iba` を答えた

マージの後に起動したスレッドには、利用者が **Check for updates** を押さなくても新しい版が届いた。ただし **Sync automatically** をオンにしていたかは未確認で、オンだったから届いたのか、オフでも届くのかは分けられていない。

## R3 と食い違う点と、後続のフェーズの形を変える点（T027）

### R3 と食い違う点・R3 で分からなかった点

- R3 は、claude.ai のプロジェクトのスレッドで読まれるかを「文書に無いので、Phase 3 で試す」としていた。クラウドのスレッドで読まれることを確かめた。R3 の決め（claude.ai に入れたプラグインを、クラウドのスレッドへ届ける第一候補にする）はそのままでよい
- coordinator でも読まれる。coordinator も `/root/.claude/plugins/synced/` からプラグインを読み、会話の途中で入れたものも数分で一覧に加わった
- 同じ marketplace の中で `bin/` を持つプラグインだけが届かず、持たないプラグインは巻き添えにならなかった
- 版を上げると数秒で claude.ai の記録が更新され、次に起動したスレッドに届く。続いている会話では、そのプラグインのスキルが「this plugin entry changed after the session listed it」で止まる

### 後続のフェーズの形を変える点

- Phase 7〜9（`bin/` をなくす）: 形は変わらない。`bin/` を持つ限り、claude.ai もクラウドのスレッドも、そのプラグインを受け取らない
- Phase 7〜9（npx の起動）: クラウドの VM の既定の Node は 22 で、`@pecot/workflow-mcp@9.0.0` の `engines.node`（`^24.22.1 || >=26.12.1`）に合わない
  - 今は `EBADENGINE` の警告だけで動くが、24 の機能を使えば止まる。`/opt/node24` はあるが PATH に無い
  - `engines.node` に 22 を含めるか、24 で起動する手段を、Phase 7 の計画で決める
- Phase 7〜9（依存の install）: Network access が Default（limited）でも、npm の registry に届き、`devEngines` の pnpm v12.15.0 の取得と `pnpm install --frozen-lockfile` も通った。build の前の依存の install に、環境の追加の設定は要らない
- Phase 7（MCP の版）: サーバは 2025-11-25 の lifecycle（initialize）で答えた。移すかは Phase 7 の計画で判断する
  - 現行の MCP の仕様は 2026-07-28 で、Versioning and Compatibility の Terminology は次のように書く
    「**Legacy**: protocol versions that establish a session with an `initialize` handshake (`2025-11-25` and earlier).」
  - 同じページの Protocol Version Negotiation は「There is no negotiation handshake.」と書く
- Phase 13（pecot-coordinator）: `bin/` を持つプラグインが同じ marketplace にあっても、pecot-coordinator は巻き添えにならない。このリポの marketplace に置いてよい
- Phase 13・14（版の上げ方）: リリースの後、続いている coordinator の会話では pecot-coordinator のスキルが止まる。coordinator のスキルか手順に、リリースの後は新しい会話で始め直すことを書く必要がある
- Phase 13・14（Sync automatically）: 新しい版が自動で届くのに **Sync automatically** が要るかは未確認。Phase 13 で利用者の手順を書くときに、オフの状態で版を上げて確かめる
- Phase 14（SC-003 の数え方）: 個人の Add marketplace は、拒んだプラグインを、止まる文を出さずに一覧から外す。文書の `Plugin contains a top-level bin/ directory` も出ない
  - 拒まれたかは、止まる文ではなく、marketplace の一覧と、クラウドのスレッドの `~/.claude/plugins/synced/<bucket>/manifest.json` に全部のプラグインがあるかで数える
- Phase 14（既定のブランチ）: claude.ai は `owner/repo#ref` の形を受け付けず、既定のブランチにマージした版が届いた。tasks.md の「スタック不可」の前提（既定のブランチに無いと確かめられない）のとおりで、形は変わらない
- 版を上げた PR のマージの直後から、利用者の account の全部の新しいスレッドに届く。sandbox の marketplace のように、確かめの途中の版を既定のブランチに入れると、そのまま届く
