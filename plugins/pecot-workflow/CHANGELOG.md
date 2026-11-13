# 5.0.0 (2026-11-13)

### 🚀 Features

- MCP サーバを npm の `@pecot/workflow-mcp` として単体で配る。 ([#393](https://github.com/pecotcraft/pecot/pull/393), [#352](https://github.com/pecotcraft/pecot/issues/352))
  プラグインを入れなくても、MCP クライアントに 1 エントリを登録すれば使える。

- `pecot project init` が、既にあるボードに `Blocked` と `Needs Attention` を足す。 ([#395](https://github.com/pecotcraft/pecot/pull/395), [#376](https://github.com/pecotcraft/pecot/issues/376))
  `Blocked` の無いボードでも、設定の読み込みは止まらない。
  旧版の CLI で設定ファイルを保存し直すと、`fields.status` は消える。


### 🩹 Fixes

- 外部投稿のフックが、`pecot issue create` などに `--help` を付けた呼び出しを実投稿として止めない。 ([#330](https://github.com/pecotcraft/pecot/pull/330), [#261](https://github.com/pecotcraft/pecot/issues/261))
- 公開面のテストのいちばん外の `describe` の題が定義書の `name` に無いと、lint が止める。 ([#331](https://github.com/pecotcraft/pecot/pull/331), [#279](https://github.com/pecotcraft/pecot/issues/279))
- `pecot worktree remove <名前>` は、機能ブランチに移った worktree も削除する。 ([#320](https://github.com/pecotcraft/pecot/pull/320), [#316](https://github.com/pecotcraft/pecot/issues/316))
  `worktree add` が記録した名前、`<project root>/<名前>/<repo>` の置き場所、ブランチ名の順で worktree を探す。
  `pecot worktree` のコマンドは、空白を含むパスの worktree を一覧から正しく読む。

- `pecot worktree add` は、origin の無いリポで、アクティブなプロジェクトに登録済みのリポを指す remote（無ければ最初の remote）を使う。 ([#319](https://github.com/pecotcraft/pecot/pull/319), [#317](https://github.com/pecotcraft/pecot/issues/317))
- Node への移植の準備で、配布物の振る舞いは変わらない。定義書の `environment` に、データ置き場と枠の幅を決める環境変数の説明を足す。 ([#354](https://github.com/pecotcraft/pecot/pull/354), [#340](https://github.com/pecotcraft/pecot/issues/340))
- Node への移植の準備で、配布物の振る舞いは変わらない。project の 10 個と `create-branch`・`delete-branch` を、Node の CLI に移す。 ([#356](https://github.com/pecotcraft/pecot/pull/356), [#341](https://github.com/pecotcraft/pecot/issues/341))
- Node への移植の途中で、配布物の振る舞いは変わらない。issue と session のコマンド 9 個が、Node でも同じ結果を返す。 ([#360](https://github.com/pecotcraft/pecot/pull/360), [#342](https://github.com/pecotcraft/pecot/issues/342))
- Node への移植の途中で、配布物の振る舞いは変わらない。pr の 4 コマンド（`create`・`read`・`preflight`・`cleanup`）を Node の CLI に足す。 ([#359](https://github.com/pecotcraft/pecot/pull/359), [#343](https://github.com/pecotcraft/pecot/issues/343))
- 配布物の振る舞いは変わらない。 ([#358](https://github.com/pecotcraft/pecot/pull/358), [#344](https://github.com/pecotcraft/pecot/issues/344))
  TypeScript への移行の途中で、`pecot worktree` の 4 個と `pecot release` の 3 個を、開発用の Node の CLI に移した。

- hooks に、MCP ツールの投稿の確認（ask）を足す。Bash の `pecot` の deny と移行後の案内文も用意するが、まだ呼ばないので、配布物の振る舞いは変わらない。 ([#357](https://github.com/pecotcraft/pecot/pull/357), [#345](https://github.com/pecotcraft/pecot/issues/345))
- hooks のテストを vitest からも流せるようにした。pytest は残す。配布物の振る舞いは変わらない。 ([#361](https://github.com/pecotcraft/pecot/pull/361), [#346](https://github.com/pecotcraft/pecot/issues/346))
- 配布物の振る舞いは変わらない。 ([#365](https://github.com/pecotcraft/pecot/pull/365), [#347](https://github.com/pecotcraft/pecot/issues/347))
  TypeScript への移行の途中で、同期の 2 個を開発用の Node の CLI に移した。
  対象は `pecot security sync` と `pecot dependabot sync` で、34 個のコマンドがそろった。

- 配布物の振る舞いは変わらない。 ([#369](https://github.com/pecotcraft/pecot/pull/369), [#348](https://github.com/pecotcraft/pecot/issues/348))
  開発用の `pecot mcp` が、34 個のコマンドを MCP のツールとして公開する（プラグインには登録しない）。
  利用者の runtime の依存として、MCP の SDK が増える。

- Python の CLI と pytest を消し、Node の CLI の置き場を `cli/` にした。配布物の振る舞いは変わらない。 ([#388](https://github.com/pecotcraft/pecot/pull/388), [#351](https://github.com/pecotcraft/pecot/issues/351))
- Node への移植の途中で、配布物の振る舞いは変わらない。Node の CLI の help が同じ書式になり、定義書の説明を出す。 ([#366](https://github.com/pecotcraft/pecot/pull/366), [#362](https://github.com/pecotcraft/pecot/issues/362))
- Node への移植の途中で、配布物の振る舞いは変わらない。Node の CLI で、`-D` の検証や終了の扱いなど、コマンドの間で重なっていた実装を 1 つにまとめた。 ([#368](https://github.com/pecotcraft/pecot/pull/368), [#363](https://github.com/pecotcraft/pecot/issues/363))
- w-merge のマージ待ちが、チェックが通ったあとにルールで止まった PR を待ち続けない。 ([#367](https://github.com/pecotcraft/pecot/pull/367), [#364](https://github.com/pecotcraft/pecot/issues/364))
  待つのは merge queue の中とチェックの実行中だけで、ほかは止まった理由を出して抜ける。

- 配布物の振る舞いは変わらない。 ([#372](https://github.com/pecotcraft/pecot/pull/372), [#371](https://github.com/pecotcraft/pecot/issues/371))
  開発用の `pecot mcp` が、GitHub Copilot CLI のプラグインから起動されたときも、セッションのリポを対象にする。
  対象のリポを決められないときは、別のリポを使わず、どのツールも理由を返して止まる。

- Issue の前提（blocked by）の読み書きと、着手の判定の関数を足す。コマンドからはまだ呼ばず、配布物の振る舞いは変わらない。 ([#394](https://github.com/pecotcraft/pecot/pull/394), [#375](https://github.com/pecotcraft/pecot/issues/375))
- MCP の単体配布の登録例が、pnpm の `devEngines` を持つリポを cwd にしても起動する。 ([#398](https://github.com/pecotcraft/pecot/pull/398), [#391](https://github.com/pecotcraft/pecot/issues/391))
  登録例はパッケージを位置引数で渡し、`npm_config_package` をサーバの子の npx に残さない。

- **pytest の JUnit** を `cli/test-results/junit.xml` に残し、テストが失敗した回の結果も残す。 ([#322](https://github.com/pecotcraft/pecot/pull/322), [#260](https://github.com/pecotcraft/pecot/issues/260))

### ⚠️  Breaking Changes

- `pecot` の CLI が Node（`^24.22.1` か `>=26.12.1`）で動き、スキルは MCP ツールを呼ぶ。Python と uv は要らない。 ([#386](https://github.com/pecotcraft/pecot/pull/386), [#350](https://github.com/pecotcraft/pecot/issues/350))
  エージェントの Bash の `pecot` は hooks が deny する（設定のキー `pecot-cli-deny`）。
  GitHub Copilot CLI は 1.0.106 以降が要る。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 4.1.0 (2026-11-11)

### 🚀 Features

- `pecot release`・`worktree`・`session`・`create-branch`・`delete-branch` の行を英語にし、 ([#265](https://github.com/pecotcraft/pecot/pull/265), [#213](https://github.com/pecotcraft/pecot/issues/213))
  データ以外の行を stderr に移す。`create-branch` は切り替えの案内を出さない。


### 🩹 Fixes

- pecot-tools の診断行の前置きを `error:` にそろえ、MCP ツールの文言と進捗通知を英語にした。 ([#276](https://github.com/pecotcraft/pecot/pull/276), [#215](https://github.com/pecotcraft/pecot/issues/215))
  3 プラグインの launcher（`bin/`・`setup.sh`）が出す文言も英語にした。

- `pecot worktree` が link の作成で出す警告の行に、`warning:`・`error:` の前置きを付ける。 ([#280](https://github.com/pecotcraft/pecot/pull/280), [#216](https://github.com/pecotcraft/pecot/issues/216))
  ほかのコマンドの警告と同じ形で読める。

- lock の作り直しで推移依存が変わった。 ([#270](https://github.com/pecotcraft/pecot/pull/270), [#247](https://github.com/pecotcraft/pecot/issues/247))
  `@babel/parser` を 7.29.9 から 7.29.13 に更新し、重複した `@typescript-eslint/*` と `parse5` を 1 つの版にまとめた。

- CLI のコマンドの定義を `interface/generated.json` に書き出す開発用のスクリプトを足した。 ([#283](https://github.com/pecotcraft/pecot/pull/283), [#248](https://github.com/pecotcraft/pecot/issues/248))
  CLI の振る舞いは変わらない。

- `project` の 10 コマンドの定義を `interface/authored.yaml` に書き起こした。 ([#291](https://github.com/pecotcraft/pecot/pull/291), [#251](https://github.com/pecotcraft/pecot/issues/251))
  CLI の振る舞いは変わらない。

- `pecot release merge` は、`--repo` が今の Git remote から外れていれば終了コード 1 で止まる。 ([#300](https://github.com/pecotcraft/pecot/pull/300), [#254](https://github.com/pecotcraft/pecot/issues/254))
  `--repo` を使わないコマンドに短い形 `N` を渡したときの error は、フル形式だけを案内する。

- w-help の `commands.md` を、定義書（`interface/generated.json`）から作る生成物にした。 ([#304](https://github.com/pecotcraft/pecot/pull/304), [#255](https://github.com/pecotcraft/pecot/issues/255))
  説明は CLI の help と同じ英語の文になる。
  一部のコマンドの help の 1 行目に、使い分けの補足を足した。

- テストが、確かめる振る舞いの項目の ID を JUnit に書き出す。定義書に無い ID を書いたテストは、CI が止める。 ([#314](https://github.com/pecotcraft/pecot/pull/314), [#256](https://github.com/pecotcraft/pecot/issues/256))
- 太字の中にインラインコードだけを置いた行や、水平線の記号のうしろに HTML コメントを置いた行を、 ([#272](https://github.com/pecotcraft/pecot/pull/272), [#267](https://github.com/pecotcraft/pecot/issues/267))
  本文の検証が水平線と見なして止めないようにする。

- w-merge のマージ待ちが、auto-merge の予約が残ったままのコンフリクトと、必須チェックの失敗で抜けるようにした。 ([#273](https://github.com/pecotcraft/pecot/pull/273), [#268](https://github.com/pecotcraft/pecot/issues/268))
  抜けた後は、取り込んで直す手順か、落ちたチェックを読む手順を示し、片付けをせずに止まる。

- Tracker が、minor・patch の playwright の PR を人の判断待ちとして載せなくなった。 ([#277](https://github.com/pecotcraft/pecot/pull/277), [#274](https://github.com/pecotcraft/pecot/issues/274))
  major の PR は、これまでどおり `major` の理由で載る。

- `pecot worktree add`・`pecot worktree link` で、link の作成と `setup_command` の失敗が ([#294](https://github.com/pecotcraft/pecot/pull/294), [#286](https://github.com/pecotcraft/pecot/issues/286))
  2 行で出ていた。これを `warning:` の 1 行にした。

- **w-merge** の片付けで worktree が汚れていたら、WIP commit か名前付きの stash で退避する手順にした。 ([#293](https://github.com/pecotcraft/pecot/pull/293), [#292](https://github.com/pecotcraft/pecot/issues/292))
  **w-quick** の Step 1 で、同じ禁止を 2 回書いていた段落を消した。

- worktree・release・security・dependabot・session の失敗のうち traceback を出していた場面が、`error:` の行と終了コード 1 で止まる。 ([#305](https://github.com/pecotcraft/pecot/pull/305), [#298](https://github.com/pecotcraft/pecot/issues/298))
  `session status` は、アクティブな設定ファイルが不正なら warning の行を出して表を続ける。

- `add-to-project`・`delete-branch`・`worktree remove`・`worktree init` が失敗を流さずに知らせる。 ([#303](https://github.com/pecotcraft/pecot/pull/303), [#299](https://github.com/pecotcraft/pecot/issues/299))
  release 系は origin が無ければ最初の remote を使い、`worktree add --base` の help は実際の既定を示す。

- `pecot worktree add --path` は、リンクも `--path` の worktree に作る。 ([#308](https://github.com/pecotcraft/pecot/pull/308), [#301](https://github.com/pecotcraft/pecot/issues/301))
  `pecot worktree link --dry-run` は、本番が飛ばすリンクを skip と予定する。
  短い形 `N` の help は、`--repo` が無いと git の remote で解決すると書く。

- `pecot worktree add` は、`--path` で作った worktree が使う wtN を避け、作った worktree に wtN を記録する。 ([#312](https://github.com/pecotcraft/pecot/pull/312), [#306](https://github.com/pecotcraft/pecot/issues/306))
  `pecot pr cleanup` は、記録した wtN に戻る。

- `pecot pr cleanup --delete-branch` は、`wip/<head>` があるのに削除できなかったとき、warning の行で知らせる。 ([#313](https://github.com/pecotcraft/pecot/pull/313), [#309](https://github.com/pecotcraft/pecot/issues/309))
  `pecot session` と `pecot pr` のコマンドは、origin の無いリポで最初の remote を使う。

- w-release の手順を、承認の待ちが無い形にする。dry-run で案を見てから、同じ commit を指定して本番を起動する。 ([#311](https://github.com/pecotcraft/pecot/pull/311), [#310](https://github.com/pecotcraft/pecot/issues/310))
- pecot-visual の MCP ツールの説明文・結果・エラー、slide_lint の規則の文言、CLI の行を英語にする。 ([#269](https://github.com/pecotcraft/pecot/pull/269), [#214](https://github.com/pecotcraft/pecot/issues/214))
  `slide sync` が書く talk-dir の設定のコメントも英語になり、PPTX の変換が 1 回やり直しになる。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 4.0.0 (2026-11-10)

### 🚀 Features

- `pecot pr create`・`read`・`preflight`・`cleanup` の行を英語の共通の形にし、1 事柄 1 行で stderr に出す。 ([#242](https://github.com/pecotcraft/pecot/pull/242), [#211](https://github.com/pecotcraft/pecot/issues/211))
  stdout に出るのは PR の URL・`--prepare` のパス・preflight の節・`pr read` の本文だけになる。

- `pecot project` のコマンドの行を英語にし、データ以外の行を stderr に移す。 ([#241](https://github.com/pecotcraft/pecot/pull/241), [#212](https://github.com/pecotcraft/pecot/issues/212))
  `project info` の見出しも英語になる。

- コマンドが `error:` の後ろに出す例外の文言と、テンプレ・フロントマター・参照の検証の文言を英語にする。 ([#266](https://github.com/pecotcraft/pecot/pull/266), [#239](https://github.com/pecotcraft/pecot/issues/239))
  トークンのフォールバックの警告は `warning:` の行で出す。

- `pecot dependabot sync` を足し、人の判断を待つ dependabot の PR を Tracker 1 件の一覧にそろえる。 ([#176](https://github.com/pecotcraft/pecot/pull/176), [#174](https://github.com/pecotcraft/pecot/issues/174))
- `pecot release preflight` は、open の Dependabot alert があっても止まらず、件数・severity・一覧を警告に出す。 ([#217](https://github.com/pecotcraft/pecot/pull/217), [#202](https://github.com/pecotcraft/pecot/issues/202))
  例外ファイル `.github/dependabot-exceptions.json` は読まなくなった。

- `pecot security sync`・`pecot dependabot sync` の行を英語にし、すべて stderr に出す。 ([#223](https://github.com/pecotcraft/pecot/pull/223), [#206](https://github.com/pecotcraft/pecot/issues/206))
  dry-run なら `dry-run: would ...`、そうでなければ `<past>: ...` の 1 事柄 1 行になる。

- `pecot issue` 系・`add-to-project`・`update-issue-status` の行を英語にする。 ([#243](https://github.com/pecotcraft/pecot/pull/243), [#210](https://github.com/pecotcraft/pecot/issues/210))
  data だけを stdout に出し、ほかは `error:`・`warning:`・`<past>:` の行で stderr に出す。


### 🩹 Fixes

- w-release の手順から、依存の更新の version plan を作る段を外した。 ([#224](https://github.com/pecotcraft/pecot/pull/224), [#220](https://github.com/pecotcraft/pecot/issues/220))
  plan は dependabot の PR で作られる。

- vite の catalog の範囲の確認を、@slidev/cli の宣言との一致ではなく、その範囲に入るかで見るようにした。入る vite の版と配布物の挙動は変わらない。 ([#240](https://github.com/pecotcraft/pecot/pull/240), [#236](https://github.com/pecotcraft/pecot/issues/236))
- w-issueize が Issue 化の後に tasks.md を削除する手順を外し、Issue 化済みのフェーズを対象から外す。 ([#194](https://github.com/pecotcraft/pecot/pull/194), [#62](https://github.com/pecotcraft/pecot/issues/62))
  w-active が、フェーズの Issue の計画に tasks.md のチェックの更新を入れる。

- w-release のリリースを workflow から起動する手順にした。 ([#161](https://github.com/pecotcraft/pecot/pull/161), [#67](https://github.com/pecotcraft/pecot/issues/67))
- nx が undici の修正版を宣言したので、`runtime-workspace.yaml` から **undici の override** を外した。 ([#169](https://github.com/pecotcraft/pecot/pull/169), [#168](https://github.com/pecotcraft/pecot/issues/168))
  lock の作り直しで、推移依存の patch 更新も入った。

- vite の版を、pnpm の catalog の 1 か所で決めるようにした。実行用の依存の lock は catalog の項目を持つ。入る vite の版は変わらない。 ([#196](https://github.com/pecotcraft/pecot/pull/196), [#170](https://github.com/pecotcraft/pecot/issues/170))
  単体配布の `setup` は、配布物の実行時依存の manifest に `catalog:` が残っていると、npm を起動せずに配布物の破損として止まる。

- `commander` を 15.0.0 から 15.1.0 に更新。(#172) ([#224](https://github.com/pecotcraft/pecot/pull/224), [#220](https://github.com/pecotcraft/pecot/issues/220))
- `pecot dependabot sync` の Tracker の表を、security alert の Tracker と同じ形にする。 ([#182](https://github.com/pecotcraft/pecot/pull/182), [#180](https://github.com/pecotcraft/pecot/issues/180))
  列は `title | PR | checks` で、3 列目は最後の commit の検証の結果を書く。0 件では `none` と書く。

- jsdom を 31 に上げた（テスト用の devDependency）。 ([#203](https://github.com/pecotcraft/pecot/pull/203), [#198](https://github.com/pecotcraft/pecot/issues/198))
  lock の作り直しで、推移依存も変わった。

- CLI の出力の行を作る共通の関数を、Python と Node に足した。 ([#219](https://github.com/pecotcraft/pecot/pull/219), [#205](https://github.com/pecotcraft/pecot/issues/205))
  コマンドの出力はまだ変わらない。

- `pecot` の全コマンドの `--help` の文言を英語にした。 ([#227](https://github.com/pecotcraft/pecot/pull/227), [#207](https://github.com/pecotcraft/pecot/issues/207))
  コマンドが出す行の文言は変わらない。

- hooks がエージェントへ返すメッセージを英語にした。行の頭は `error:`・`warning:`・`note:` のどれかになる。 ([#228](https://github.com/pecotcraft/pecot/pull/228), [#209](https://github.com/pecotcraft/pecot/issues/209))
  eslint・validator・textlint が出す文言と、参照の YAML の抜粋は変わらない。

- auto-push は、active な Issue のブランチだけを wip/ へ push する。 ([#152](https://github.com/pecotcraft/pecot/pull/152), [#147](https://github.com/pecotcraft/pecot/issues/147))
  push の後で wip/ の追跡 ref を消すので、最初の push でも pre-push の hook が動く。

- 依存パッケージを 2 件更新。(#150) ([#224](https://github.com/pecotcraft/pecot/pull/224), [#220](https://github.com/pecotcraft/pecot/issues/220))
  `pydantic` を 2.14.2 から 2.14.3 に更新。
  `typer` を 0.27.3 から 0.28.0 に更新。

### ⚠️  Breaking Changes

- `pecot pr create` が、Summary に画像も `screenshot` の理由も無い本文を止める。 ([#190](https://github.com/pecotcraft/pecot/pull/190), [#183](https://github.com/pecotcraft/pecot/issues/183))
  本文の検証の失敗の終了コードが、1 から 3 に変わる。

- `pecot pr merge` を廃止し、マージ後の片付けを `pecot pr cleanup` に分けた。 ([#163](https://github.com/pecotcraft/pecot/pull/163), [#162](https://github.com/pecotcraft/pecot/issues/162))
  マージは `gh pr merge` で行い、merge queue のあるリポでも w-merge が queue のマージを待ってから片付ける。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

## 3.1.0 (2026-11-09)

### 🚀 Features

- Playwright の MCP サーバが、pnpm を宣言したリポジトリで起動しない問題を直した。 ([#140](https://github.com/pecotcraft/pecot/pull/140), [#139](https://github.com/pecotcraft/pecot/issues/139))
  GitHub Copilot CLI では、どのリポジトリでも起動しなかった。
  pecot-workflow にも、同じ Playwright の MCP サーバ `pecot-workflow-playwright` を登録した。

- pecot security sync は、security alert を 1 件ずつ Issue にせず、Tracker 1 件の一覧を alert の今の状態で書き直す。 ([#108](https://github.com/pecotcraft/pecot/pull/108), [#105](https://github.com/pecotcraft/pecot/issues/105))
  Issue の種類に tracker を足し、月 1 回の見直しの Issue を作る security review-exceptions をやめる。

- 計画の自動投稿をやめ、w-active / w-quick が確認の前に Issue へ投稿する形にした。 ([#109](https://github.com/pecotcraft/pecot/pull/109), [#106](https://github.com/pecotcraft/pecot/issues/106))
  `pecot issue comment` は投稿したコメントの URL を書き戻し、次からはそのコメントを書き換える。
  プランモードの前後のリマインダーは、ExitPlanMode の後の案内だけにした。

- `.pecot/.gitignore` を利用リポで追跡する許可の一覧にし、hook が動く前でも生成物を管理外にする。 ([#127](https://github.com/pecotcraft/pecot/pull/127), [#122](https://github.com/pecotcraft/pecot/issues/122))
  session-start の案内の設定キーは `gitignore-track-notice` に変わる。

- pecot security sync が、main の security alert をボードの Issue にし、閉じた alert の Issue を閉じる。 ([#100](https://github.com/pecotcraft/pecot/pull/100), [#84](https://github.com/pecotcraft/pecot/issues/84))
  review-exceptions が例外の見直しの Issue を作り、preflight は 3 種の open の alert で止まる。


### 🩹 Fixes

- w-release の nx の手順で、**`versionPlans` をオブジェクトで書いたリポ**も同じ扱いになることを書く。 ([#149](https://github.com/pecotcraft/pecot/pull/149), [#143](https://github.com/pecotcraft/pecot/issues/143))
- `pecot issue comment <ファイル>` が、PR へのコメントも同じファイルで書き換えられるようにした。 ([#148](https://github.com/pecotcraft/pecot/pull/148), [#146](https://github.com/pecotcraft/pecot/issues/146))
  書き戻した `comment_url` が `/pull/<番号>#issuecomment-<id>` の形のときに、`comment_url の形が違います` で止まっていた。
  `comment_url` のホストが設定のホストと違えば、書き換えずに止まる。

- テストの target の説明文を、CI がテストを動かす前提に直した。動きは変わらない。 ([#144](https://github.com/pecotcraft/pecot/pull/144), [#66](https://github.com/pecotcraft/pecot/issues/66))
- security alert の Tracker の題を `[Tracker] security alert — <立てた日>` にする。 ([#114](https://github.com/pecotcraft/pecot/pull/114), [#111](https://github.com/pecotcraft/pecot/issues/111))
  本文は、判断の要る open の alert を種類ごとの見出しと表に分けた一覧だけにし、直った alert の行は消す。
  例外の見直しの条件は Tracker に出さず、`pecot release preflight` が表示する。

- リポジトリを root の 1 つの pnpm workspace にまとめ、lock を root の 1 つにした。libs/text-rules は workspace: で参照する。 ([#115](https://github.com/pecotcraft/pecot/pull/115), [#113](https://github.com/pecotcraft/pecot/issues/113))
- hook のスクリプトの置き場を変えた参照を直した。 ([#107](https://github.com/pecotcraft/pecot/pull/107), [#64](https://github.com/pecotcraft/pecot/issues/64))
- hosts.json の無い checkout でも、github.com のトークンを環境変数 `PECOT_GITHUB_COM_TOKEN` から読むようにした ([#104](https://github.com/pecotcraft/pecot/pull/104), [#84](https://github.com/pecotcraft/pecot/issues/84))
- 違うパッケージマネージャの install を、各 package.json の devEngines.packageManager で止めるようにした。 ([#81](https://github.com/pecotcraft/pecot/pull/81), [#52](https://github.com/pecotcraft/pecot/issues/52))
- ホスト名や URL を部分一致で調べていたテストの assert を、期待する値全体の比較に改めた。利用者から見える振る舞いは変わらない。 ([#73](https://github.com/pecotcraft/pecot/pull/73), [#58](https://github.com/pecotcraft/pecot/issues/58))
- pecot pr merge が、既に消えた head ブランチを削除済みとして扱い、wip ブランチも消すようにした。 ([#76](https://github.com/pecotcraft/pecot/pull/76), [#72](https://github.com/pecotcraft/pecot/issues/72))
- pecot pr merge が、Closes の自動クローズと重なった Issue を既にクローズ済みとして扱う。ほかの失敗では、GitHub が返した理由を警告に添える。 ([#79](https://github.com/pecotcraft/pecot/pull/79), [#78](https://github.com/pecotcraft/pecot/issues/78))
- w-release の手順書の例のリポ名を pecot にした。 ([05e4403](https://github.com/pecotcraft/pecot/commit/05e4403))

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 3.0.0 (2026-11-04)

pecotcraft/pecot で公開した最初の版。
