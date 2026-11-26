# Research: pecot-coordinator プラグイン

2026-11-25〜26 に読んだ文書とソースと、そこから決めたこと。文書とソースで分からないことだけを、検証のフェーズ（Phase 1〜3）で試す。

## 読んだ文書とソース

| 文書・ソース | URL・場所 | 版・日付 |
|---|---|---|
| claude.ai のプラグインの概要 | <https://claude.com/docs/plugins/overview> | 版の表示なし。2026-11-25 に読んだ |
| 部品ごとの対応表 | <https://claude.com/docs/plugins/platform-support> | 同上 |
| 組織の sync | <https://claude.com/docs/plugins/org-sync> | 同上 |
| アップロードの要件（Plugins API） | <https://platform.claude.com/docs/en/manage-claude/plugins-api> | API の版 `2026-10-21` |
| Claude Code のプラグインの読み込み | <https://code.claude.com/docs/en/plugins/loading> | 版の表示なし。2026-11-25 に読んだ |
| Claude Code のプラグインの部品 | <https://code.claude.com/docs/en/plugins/components> | 同上 |
| Agent Plugins の仕様 | <https://agent-plugins.org/specification> | Spec Version 1.0.0、Status: Published |
| GitHub MCP Server のソース | github/github-mcp-server（`pkg/github/__toolsnaps__/`・`docs/insiders-features.md`） | commit `7edc2dd123a8923db389de8772170663cb2d8e17`（2026-11-25） |
| GitHub Actions のワークフローの書き方 | <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax> | 版の表示なし。2026-11-26 に読んだ |
| JavaScript の action の作り方 | <https://docs.github.com/en/actions/sharing-automations/creating-actions/creating-a-javascript-action> | 同上 |
| action の版の管理 | <https://docs.github.com/en/actions/how-tos/create-and-publish-actions/manage-custom-actions> | 同上 |
| Dependabot で action を更新する | <https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot> | 同上 |
| Dependabot の github_actions のソース | dependabot/dependabot-core（`github_actions/lib/dependabot/github_actions/version.rb`・`file_parser.rb`・`update_checker.rb`） | commit `7d7e5f69786a3e56b213485d753e1b404c232b11`（2026-11-25） |
| `GITHUB_TOKEN` の権限 | <https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication> | 版の表示なし。2026-11-26 に読んだ |
| MCP のサーバの作り方 | <https://modelcontextprotocol.io/docs/develop/build-server> | 版の表示なし。2026-11-26 に読んだ |
| MCP Inspector | <https://modelcontextprotocol.io/docs/tools/inspector>・github.com/modelcontextprotocol/inspector の `docs/cli-smoke-testing.md` | v2 の系列。2026-11-26 に読んだ |
| MCP のデバッグ | <https://modelcontextprotocol.io/docs/tools/debugging> | 版の表示なし。2026-11-26 に読んだ |
| クラウドのスレッドでの確かめ | 利用者がスレッドに残した記録（2026-11-26 00:44〜01:34） | — |

## R1. claude.ai が既存のプラグインを拒む原因

- **Decision**: 原因は、3 つのプラグインの直下の `bin/` と判断する
- **Rationale**: 部品ごとの対応表は、直下の `bin/` を Chat と Cowork で「Can't be installed」とし、「makes that surface refuse the whole plugin」と書く。アップロードの要件も「No file may be under a top-level `bin/` directory.」と書く。
  3 つとも `bin/` を持つ
- **Alternatives considered**: マニフェストの位置と名前の形も要件にあるが、3 つとも合っている

## R2. `bin/` をなくし、MCP は npm の版を起動する

- **Decision**: 3 つの `bin/`（依存を入れて build し、実行用のミラーを作ってから MCP のサーバを起動する仕組み。約 2,100 行）を消す。
  プラグインの MCP は、npm に出している package を `"command": "npx"`・`"args": ["--prefix=${PLUGIN_DATA}", "-y", "@pecot/<名前>-mcp@<版>"]` で起動する。`--prefix` は外せない。
  プラグインの直下の `package.json` が `devEngines` で pnpm を求めるので、プラグインの直下で npx を打つと npm 11 が `EBADDEVENGINES` で止まる（2026-11-26 に手元で確かめた。
  `--prefix` に `package.json` の無いディレクトリを渡すと、`@pecot/workflow-mcp@9.0.0` が起動して initialize に答えた。今の playwright のサーバも `--prefix=${CLAUDE_PLUGIN_ROOT}/bin` を付けている）。版は、プラグインのリリースで同じ版に書き換える。
  同じ機能の CLI の入口（`cli/src/cli.ts`）も消し、機能は MCP のツールだけで公開する（R10）。直したツールを試すときは、作業ツリーで build し、MCP Inspector の CLI で作業ツリーのサーバを起動してツールを呼ぶ。リポの中で打つと同じく `EBADDEVENGINES` で止まるので、リポの外のディレクトリで打つ。
  2026-11-26 に、作業ツリーで build した pecot-workflow のサーバを `@modelcontextprotocol/inspector@2.5.0` の `--cli` で起動し、`tools/list` で 45 個のツールが返った。
  ツールを呼ぶ形は次のとおり（`npx -y @modelcontextprotocol/inspector@<固定の版> --cli node <作業ツリー>/plugins/<名前>/cli/dist/<サーバ>.js --method tools/call --tool-name <ツール> --tool-args-json '<JSON>' --format json`）。
  CONTRIBUTING の「3. 試験環境」の `bin/pecot <コマンド>` を、この形に書き換える
- **Rationale**: 3 つとも、同じサーバを npm に出している（2026-11-26 に registry で確かめた。`latest` は `@pecot/workflow-mcp` 9.0.0・`@pecot/visual-mcp` 3.0.2・`@pecot/tools-mcp` 3.0.2。どれも実行ファイルを持ち、引数なしで MCP のサーバが起動する。
  `scripts/release/tests/publish-mcp-dist.test.sh` の「引数なし起動」）。Agent Plugins 1.0（§7.2.1）は `command` を「a bare executable name or a plugin-relative path beginning with `./`」と定め、プラグインの中のファイルであることを求めていない。
  §9.2 の例も `"command": "npx"` を使う。今の CUJ は、子の CLI を立てずに、Bash で作業ツリーの `bin/pecot <コマンド>` を打っている（CONTRIBUTING の「3. 試験環境」）。直した版を、エージェントがその場で動かす経路は Bash から作業ツリーのものを起動する形で足りるので、プラグインの MCP が npm の版でも試験はできる。
  作り替えた後のツールは GitHub に触らないので、クラウドのスレッドでも、計算は Inspector から作業ツリーのツール、書き込みはスレッドの GitHub 公式の MCP で流せる
- **Alternatives considered**: 起動スクリプトを `bin/` から `scripts/` などへ移す案は、利用者の手元で build する仕組みが残り、npm に出した版を使わないので外した。作業ツリーの build があればそれを、無ければ npm の版を起動する小さな起動ファイルを置く案も、試験の経路が Bash からの起動で足りるので外した。
  環境変数で npm の版と作業ツリーを切り替える案は、Agent Plugins 1.0（§9.2）が置き換えを `${PLUGIN_ROOT}`・`${PLUGIN_DATA}` だけに限り、「Clients MUST NOT perform any other placeholder or environment-variable expansion」と書くので取れない。
  marketplace にあるのは直す 3 つだけなので、`bin/` を持つプラグインがほかを巻き込むかは確かめない

## R3. クラウドのスレッドへの配り方と、読まれる部品

- **Decision**: claude.ai にインストールしたプラグインを、クラウドのスレッドへ届ける経路の第一候補にする。pecot-coordinator はスキルとマニフェストだけを持つ。クラウドのスレッドは pecot-workflow のスキルを使う
- **Rationale**: Claude Code の読み込みの文書は、claude.ai から同期したプラグインについて「they download when you start a session or Claude starts a thread in your project」と書き、`<name>@synced` として読む。
  一方で「An Anthropic-hosted cloud session doesn't add the marketplaces a repository lists under `extraKnownMarketplaces`」と書く。対応表では、Chat で読まれるのはスキルとリモート MCP だけ。
  claude.ai のプロジェクトのスレッドで本当に読まれるかは文書に無いので、Phase 3 で試す。このリポは public なので組織の sync（private か internal のリポを求める）は使えず、個人の Add marketplace を試す
- **Alternatives considered**: スキルをリポの `.claude/skills/` に置く案は、このリポだけで動き、配布性を満たさないので外した

## R4. スレッドの GitHub の読み書きの経路

- **Decision**: スレッドの GitHub の読み書きは、GitHub 公式の MCP のツールで行う。手の対応は [contracts/github-io.md](contracts/github-io.md)
- **Rationale**: クラウドの VM のプロキシは、GraphQL を「GitHub GraphQL is not available from Claude Code sessions」で 403 にする。
  REST も組織のパスと Projects を「sessions are bound to their configured repositories」で 403 にし、ブランチの作成と削除を「Write access to this GitHub API path is not permitted through this proxy」で 403 にする。
  通る REST は本文の末尾に「Generated by Claude Code」を足す。
  リモート MCP は claude.ai のサーバーからつなぎ、Issue・コメント・sub-issue・ブランチの作成・commit・PR を本文を変えずに書けた。GitHub MCP Server のソースを pecot-workflow の呼び出しと突き合わせ、手のあるもの・Insiders だけのもの・無いものを分けた
- **Alternatives considered**: REST に寄せる案は、ボードに届かず本文も変わるので外した

## R5. Actions のプロジェクトの形と配り方

- **Decision**: `actions/` を 1 つの nx project にし、Actions の処理ごとに 1 つの JavaScript の action を置く（`actions/<処理>/action.yml`）。スクリプトは rollup で 1 つのファイルにまとめた `dist/` を commit する。
  利用者のリポは `uses: pecotcraft/pecot/actions/<処理>@pecot-actions/v<版>` で呼ぶ
- **Rationale**: ワークフローの書き方は `{owner}/{repo}/{path}@{ref}` を「A subdirectory in a public GitHub repository」の形として定める。
  JavaScript の action の文書は「You should not commit the `node_modules` directory」と書き、`rollup.js` か `@vercel/ncc` でまとめた `dist/` を commit する例を示す。
  版の管理の文書は「we recommend using tags for actions release management」と書く
- **Alternatives considered**: reusable workflow は呼ばれる側を `.github/workflows/` に置く決まりがあり、このリポの CI と混ざるので外した。npm で配る今の形は、clarify で利用者が退けた

## R6. タグの形と Dependabot

- **Decision**: タグは `pecot-actions/v<版>` にする。ほかの project の `pecot-workflow-v<版>` の形とは揃えない
- **Rationale**: Dependabot の github_actions の `Version.remove_leading_v` は `\A(?:.*/)?v?([0-9])` に合うものだけを版として読み、`path_based?` は `\A.+/v?([0-9])` を `<名前>/v<版>` の形のタグとして扱う。
  `pecot-actions-v1.2.3` はどちらにも合わず、版として読まれない。Dependabot の文書は、この形について何も書いていない
- **Alternatives considered**: `pecot-actions-v<版>` は Dependabot が上げられないので外した。別のリポに分けて `v<版>` を使う案は、monorepo の外にテストと版が出るので外した

## R7. Actions の token

- **Decision**: `GITHUB_TOKEN` で動く処理（`link-branch`・`stack-register`・`repo-settings`・`release-create`）は、それで動かす。
  組織のボードを触る処理（`project-fields`・`project-view`・`project-link`）と、secret と variable の名前を読む `workflow-doctor` は、GitHub App の token で動かす。
  処理ごとの権限は [contracts/actions-interface.md](contracts/actions-interface.md) の 2 節に書く。
  画面のマージを再現する `merge-async` は、Actions の token では merge queue に入れられないので置かない
- **Rationale**: `GITHUB_TOKEN` の権限の表に Projects の行が無い。文書は「If you need a token that requires permissions that aren't available in the `GITHUB_TOKEN`, create a GitHub App」と書く。
  2026-11-26 に sandbox で、`GITHUB_TOKEN`・ボードの同期の App・エージェントの App を同じ `workflow_dispatch` のワークフローの step に分けて試した（[verification/github-io.md](verification/github-io.md)）。
  `GITHUB_TOKEN` からは組織のボードが見えず、Secrets・Variables の権限も無い。merge queue のある `main` には、どの token の `merge-async` も「Enqueuer is not authorized to merge」で入らなかった
- **Alternatives considered**: すべての処理を App の token で動かす案は、`GITHUB_TOKEN` で通る処理にも App の秘密鍵を渡すことになるので外した

## R8. pecot-workflow と `actions/` が共有する部品

- **Decision**: Actions だけで使うコマンドと、スキルが使うコマンドが共有する部品（`cli/src/domain/`・`cli/src/infra/github/`・コマンドの共通の部品）を `libs/workflow-core` に切り出す。
  pecot-workflow と `actions/` は、pecot-visual が text-rules を取り込むのと同じ形で取り込む
- **Rationale**: `auto_*`・`review_finish`・`board_sync`・`tracker_sync` は、`domain/readiness`・`domain/config`・`domain/review-finish`・`infra/github`・`commands/issue-shared` などをスキル向けのコマンドと共有している。
  片方へ写すと、同じ決まりの正が 2 つになる
- **Alternatives considered**: `actions/` が pecot-workflow の CLI の package を取り込む案は、AI に向けた package に Actions が頼ることになり、FR-010 に反するので外した

## R9. スキルのテスト

- **Decision**: pecot-coordinator の nx project に `test-skills` のレーンを置き、スキルの形（frontmatter の `name`・`description`、参照の切れ、固有の値が入っていないこと）を vitest で確かめる。coordinator の振る舞いは、検証用のプロジェクトで quickstart の手順で確かめる
- **Rationale**: アップロードの要件は、`SKILL.md` の frontmatter に `name` と `description` があることと、XML のタグを含まないことを求める。pecot-workflow の `cli/tests/skills/` に同じ種類のテストがある
- **Alternatives considered**: 振る舞いを eval で測る案は、Epic #49 の範囲なので外した

## R10. CLI の入口をなくし、constitution の原則 II を直す

- **Decision**: 3 つのプラグインは、機能を MCP のツールだけで公開する。CLI の入口と、CLI のコマンドを 1 つずつツールとして出す今の作りをやめ、ツールをサーバに直に登録する。
  constitution の原則 II（CLI インタフェース）を「テキストのインタフェース」に直し、入口にコマンドライン・MCP のツール・GitHub Actions の action を含める（4.0.0 → 5.0.0。利用者が 2026-11-26 に許した）
- **Rationale**: MCP の build-server の文書（modelcontextprotocol.io/docs/develop/build-server、TypeScript）の例は、1 つのプロセスがツールを直に登録し、`node build/index.js` で起動する形で、別の CLI を持たない。
  CLI のサブコマンドをツールとして出す形は、読んだ公式の文書のどこにも無い。
  試し方は、Inspector の文書（modelcontextprotocol.io/docs/tools/inspector）が CLI を「A scriptable, machine-readable client for CI, shell pipelines, and coding agents」とする。
  debugging の文書が「Quick iteration: Use Inspector during development」と書く。
  CI で使うときは、版を固定し（例は `@2.5.0`）、`--format json` と終了コードで判定する（Inspector の docs/cli-smoke-testing.md）。Actions の処理は `actions/` の action が `libs/workflow-core` を直に呼ぶので、CLI は要らない
- **Alternatives considered**: CLI と MCP の 2 つの入口を残す案は、公式の例に無い形を残し、同じ機能の入口が 2 つになるので外した

## R11. pecot-visual のフックは MCP のツールを呼ぶ

- **Decision**: pecot-visual の PostToolUse のフック（eslint・text-lint・参照の検証・テーマの読み取り）の処理を、pecot-visual の MCP のツールにする。
  フックは `type: "mcp_tool"`・`server: "plugin:pecot-v:pecot-visual"` でそのツールを呼び、`input` に `"${tool_input.file_path}"` を渡す。フックのシェルと、実行用のミラーを読む仕組みは消す。Copilot CLI では、これらのフックは動かなくなる（Copilot の対応は後回しにする方針。
  利用者が 2026-11-26 に許した）
- **Rationale**: Claude Code のフックの文書（code.claude.com/docs/en/hooks、2026-11-26 に読んだ）は、種類の 1 つを「MCP tool hooks (`type: "mcp_tool"`): call a tool on a configured MCP server」とする。
  プラグインのサーバは「the scoped name `plugin:<plugin-name>:<server-name>`」で指すと書く。
  ツールが返した文は「the same way it reads command-hook stdout」で読まれる。起動したときの SessionStart と Setup では MCP がまだつながっていないので、`mcp_tool` は飛ばされる。
  Copilot CLI のフックの文書（docs.github.com の hooks-configuration）の種類は command・http・prompt だけ。Agent Plugins 1.0 は「does not define portable agents, hooks, commands, rules, or LSP servers」
- **Alternatives considered**: フックのシェルから CLI を呼ぶ今の形は、CLI の入口をなくす R10 と合わないので外した。
  PostToolUse で返した文がエージェントへの知らせ（additionalContext）として届くかは文書に書かれていないので、2026-11-26 に Claude Code 2.1.332 の子の `claude -p` で確かめた。
  `mcp_tool` のフックが `${tool_input.file_path}` を受けたツールを呼び、ツールが返した `hookSpecificOutput.additionalContext` の文を、エージェントがそのまま読めた

## 検証で確かめること

| 問い | フェーズ |
|---|---|
| 今のプロジェクト指示の文の振り分け | Phase 1 |
| [contracts/github-io.md](contracts/github-io.md) の「未確認」の行が、今と同じ形に書けるか | Phase 2 |
| リモート MCP の actions の toolset で `actions/` のワークフローを起動できるか | Phase 2 |
| `actions/` の処理ごとに要る token（ボード・Stacks API・merge-async・ボードの欄の作成） | Phase 2 |
| claude.ai にインストールしたプラグインが、coordinator とクラウドのスレッドで読まれるか。版の更新が届くか | Phase 3 |
| クラウドの VM で、`npx` による MCP の起動と、build の前の依存の install が npm に届くか | Phase 3 |
