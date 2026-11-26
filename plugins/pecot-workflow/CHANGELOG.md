# 10.0.0 (2026-11-26)

### 🚀 Features

- 自動レビューは、Issue の計画と diff を照らして指摘します。 ([#667](https://github.com/pecotcraft/pecot/pull/667), [#657](https://github.com/pecotcraft/pecot/issues/657))
  雛形（review 5）は Context7・WebSearch・WebFetch で外の公式の文書を引き、
  変数 `PECOT_REVIEW_WEB_ACCESS` で止められます。

- 自動レビューの雛形（review 7）は、変数が無いと Opus・effort high で動きます。 ([#689](https://github.com/pecotcraft/pecot/pull/689), [#686](https://github.com/pecotcraft/pecot/issues/686))
  run の Summary に、使われたモデルと effort、呼んだツールと拒まれた呼び出しが出ます。

- `project_init`・`project_create` の `lanes` で、`pecot-lane` と `Lanes` のビューを作ります。 ([#740](https://github.com/pecotcraft/pecot/pull/740), [#703](https://github.com/pecotcraft/pecot/issues/703))
  `pecot-lane` が既にあれば足りない値だけを足し、ビューを作れなければ画面の手順を返します。

- `issue_create` の `lane`（ファイルでは frontmatter の `lane`）で、Issue を `pecot-lane` の値に分類できます。 ([#765](https://github.com/pecotcraft/pecot/pull/765), [#704](https://github.com/pecotcraft/pecot/issues/704))
  指定が無く親の Epic に値があれば、親と同じ値を入れます。
  `board_show` は、各 Item の `lane` と、値ごとの件数の `lanes` を返します。w-active の候補は値ごとに分かれます。

- 新しい MCP ツール `issue_attributes` で、Issue に付けられる機能の名前・種類・取りうる値を一覧にできます。 ([#725](https://github.com/pecotcraft/pecot/pull/725), [#705](https://github.com/pecotcraft/pecot/issues/705))
  `issue_show` の結果に、値の入っている機能をすべて並べた `attributes` と、扱えない種類の `unsupported` が加わります。

- `issue_create` の `attributes` と新しい `issue_edit` で、Issue の機能の値を名前で書き、変え、外せます。 ([#741](https://github.com/pecotcraft/pecot/pull/741), [#706](https://github.com/pecotcraft/pecot/issues/706))
  機能は、ボードのフィールド・Issue fields・担当者・マイルストーン・Issue type・ラベルです。
  書く前にすべての値を定義と照らし、1 つでも合わなければ何も書きません。

- 設定の同期が、既定の Status の In Progress の ID を `status.options.in_progress` に書きます。 ([#726](https://github.com/pecotcraft/pecot/pull/726), [#711](https://github.com/pecotcraft/pecot/issues/711))
  `board sync`・`issue block`・`issue unblock` は、自動処理が書いた `Needs Attention` を戻しません。

- ラベルを契機にした自動処理のコマンド `pecot auto gate`・`start`・`finish` を足しました。 ([#745](https://github.com/pecotcraft/pecot/pull/745), [#712](https://github.com/pecotcraft/pecot/issues/712))
  MCP ツール `auto_gate`・`auto_start`・`auto_finish` としても使えます。

- スキル `w-auto` を足しました。自動処理のワークフローが起こし、起動ラベルの付いた Issue を、計画の投稿から PR の作成と結果のコメントまで、人を待たずに進めます。 ([#764](https://github.com/pecotcraft/pecot/pull/764), [#713](https://github.com/pecotcraft/pecot/issues/713))
  直し方が決まらないときは、質問を結果のコメントに書いて止まり、答えを書いて起動し直すと続きから進めます。

- w-pr は、レビューの指摘の採否を自分で決めて対応し、終わってから報告します。 ([#724](https://github.com/pecotcraft/pecot/pull/724), [#720](https://github.com/pecotcraft/pecot/issues/720))
  直さない指摘には、根拠を添えた理由をスレッドに返信してから resolve します。

- w-pr は、PR を出した後も GitHub の画面でのマージを待ち受けます。 ([#735](https://github.com/pecotcraft/pecot/pull/735), [#730](https://github.com/pecotcraft/pecot/issues/730))
  マージされたら、その場で `session finish` の片付けまで済ませます。

- `session start` が前の PR の後片付けの取りこぼしを警告し、w-active などがそれを片付けます。 ([#743](https://github.com/pecotcraft/pecot/pull/743), [#731](https://github.com/pecotcraft/pecot/issues/731))
- マージ後の Epic・後続へのコメントは、新しい雛形 `pecot-handoff.yml` が Actions で書き、セッションは書きません。 ([#748](https://github.com/pecotcraft/pecot/pull/748), [#732](https://github.com/pecotcraft/pecot/issues/732))
  `pecot-board-sync.yml` は、マージで閉じた PR の Issue を閉じ、head ブランチを消してからボードを直します。

- Claude Code が作る worktree では、最初のセッション開始で `setup_command` を流します。 ([#759](https://github.com/pecotcraft/pecot/pull/759), [#751](https://github.com/pecotcraft/pecot/issues/751))
  `session finish` は、この worktree では `worktree-<name>` のブランチに戻ります。

- MCP のすべてのツールが、`tools/list` で表示名（`title`）を返します。 ([#674](https://github.com/pecotcraft/pecot/pull/674), [#643](https://github.com/pecotcraft/pecot/issues/643))

### 🩹 Fixes

- MCP のツールから、入力 `dry_run` と結果の `dryRun` を外しました。予行は CLI の `--dry-run` で行います。 ([#685](https://github.com/pecotcraft/pecot/pull/685), [#661](https://github.com/pecotcraft/pecot/issues/661))
  予行のときだけ欠けていた結果の項目は、成功のときにいつも入ります。

- MCP の `tools/list` の説明の文から、CLI のフラグ（`--repo` など）を外し、引数名で書きます。 ([#683](https://github.com/pecotcraft/pecot/pull/683), [#669](https://github.com/pecotcraft/pecot/issues/669))
  CLI の `--help` は、同じ文の引数名をフラグの形にして出します。各ツールの `repo` の入力に説明を付けます。

- MCP のツールの失敗の `detail` と `warnings` から、CLI の書式（`error:`・Usage の枠）を外します。 ([#676](https://github.com/pecotcraft/pecot/pull/676), [#671](https://github.com/pecotcraft/pecot/issues/671))
  案内は `call pr_restack` のようにツール名で書き、git の出力の全文は `log` に入れます。

- MCP のツール `review_finish` を `dry_run` で呼ぶと、書くはずのコメントの本文を結果の `body` に返します。 ([#678](https://github.com/pecotcraft/pecot/pull/678), [#672](https://github.com/pecotcraft/pecot/issues/672))
  `session_show` は、作業中の Issue の本文を結果の `activeIssue.body` に返します。

- MCP のツール `release_check` に `X.Y.Z` の形でない版を渡すと、alert を調べる前に止まり、`kind` が `invalid-input` の失敗を返します。 ([#692](https://github.com/pecotcraft/pecot/pull/692), [#673](https://github.com/pecotcraft/pecot/issues/673))
- 開いた時点でコンフリクトしていた PR にも、自動レビューが付きます。 ([#684](https://github.com/pecotcraft/pecot/pull/684), [#682](https://github.com/pecotcraft/pecot/issues/682))
  雛形（review 6）は push でも起動し、まだ自動レビューの付いていない PR だけをレビューします。
  レビュー中に書いた `@pecotbot review` は、後の push で取り消されなくなります。

- スキル・MCP ツールの説明・定義書で、スタック PR を表す語をそろえます。 ([#718](https://github.com/pecotcraft/pecot/pull/718), [#690](https://github.com/pecotcraft/pecot/issues/690))
  「積める」は「スタックできる」に、「下の段」「上の段」は「親 PR」「子 PR」に、「載せ直す」は「スタックし直す」に変えます。
  w-issueize は、前の版の w-breakdown が tasks.md に書いた「積める」も「スタックできる」と同じに扱います。

- 開発用の vitest の設定が、nx のレーンから動いたときに **Allure の結果** も残すようにした。プラグインの動作は変わらない。 ([#719](https://github.com/pecotcraft/pecot/pull/719), [#693](https://github.com/pecotcraft/pecot/issues/693))
- 開発用のテストの `verifies` が、振る舞いの項目の ID を **Allure のリンクと tag** でも残すようにした。プラグインの動作は変わらない。 ([#727](https://github.com/pecotcraft/pecot/pull/727), [#695](https://github.com/pecotcraft/pecot/issues/695))
- GitHub の Issue の機能の写しと担保の一覧を置き、扱いの決まっていない項目があると開発用のテストが落ちるようにした。プラグインの動作は変わらない。 ([#761](https://github.com/pecotcraft/pecot/pull/761), [#707](https://github.com/pecotcraft/pecot/issues/707))
- w-pr は、CI 待ちとマージの待ち受けが終わるたびに自分を呼び直し、待ちの後の操作で確認を出しません。 ([#760](https://github.com/pecotcraft/pecot/pull/760), [#738](https://github.com/pecotcraft/pecot/issues/738))
  既定の権限で出るのは、スキルを使うかの確認だけで、一度許せば同じリポでは出ません。

- 自動レビューの雛形（review 8）は、合言葉を書いた人の権限を `permission` の admin・write で比べます。 ([#768](https://github.com/pecotcraft/pecot/pull/768), [#746](https://github.com/pecotcraft/pecot/issues/746))
  書き込みを基にしたカスタムロールの人が `@pecotbot review` と書いても、レビューが起動します。

- 引き継ぎの雛形は、自前の App が無いと実行の `GITHUB_TOKEN` で動き、Claude の GitHub App を要しません。 ([#754](https://github.com/pecotcraft/pecot/pull/754), [#749](https://github.com/pecotcraft/pecot/issues/749))

### ⚠️  Breaking Changes

- テンプレートを MCP の resource（`pecot-template://`）で出し、`prepare` と `issue_create` の `dry_run` を外した。 ([#668](https://github.com/pecotcraft/pecot/pull/668), [#651](https://github.com/pecotcraft/pecot/issues/651))
  予行は新しい `issue_check` で行い、`project_activate` の一覧は `project_search` の `initialized`・`active` で見る。

- `/pecot-w:w-merge` を廃止しました。PR は GitHub の画面でマージし、w-pr が待ち受けて後片付けまで済ませます。 ([#753](https://github.com/pecotcraft/pecot/pull/753), [#733](https://github.com/pecotcraft/pecot/issues/733))
  `session finish` は、マージされていない PR に、GitHub の画面でのマージを案内します。

- `pecot-priority`・`pecot-size` を作らず、値も入れません。`issue_create` の `priority`・`size` を外しました。 ([#736](https://github.com/pecotcraft/pecot/pull/736), [#702](https://github.com/pecotcraft/pecot/issues/702))
  既存の 2 つは、承認の後に `project_init` へ `confirm_delete` を付けて消します。
  security の Tracker の列 Priority は Severity になりました。

- 進行の欄の名前を `pecot-status` にし、`project_create`・`project_init` の入力 `suffix` を外しました。 ([#728](https://github.com/pecotcraft/pecot/pull/728), [#701](https://github.com/pecotcraft/pecot/issues/701))
  既存のボードは、`project_init` が旧い名前の欄を改名し、設定ファイルを `<host>_<owner>_<番号>.json` に移します。
  移した設定は旧い版で読めないので、共有する人と Actions の版をそろえてください。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 9.0.0 (2026-11-18)

### 🚀 Features

- `worktree add` の `wt9` までの上限をなくす。`wt1` から `wt9` までのセットがすべて使われていても、`wt10` 以降のセットを作る。 ([#558](https://github.com/pecotcraft/pecot/pull/558), [#556](https://github.com/pecotcraft/pecot/issues/556))
- ワークフローの雛形をリポに置く `pecot workflow install` と、雛形と要る secret・変数がそろっているかを確かめる `pecot workflow doctor` を足す。 ([#615](https://github.com/pecotcraft/pecot/pull/615), [#569](https://github.com/pecotcraft/pecot/issues/569))
- コマンド `review finish`（MCP ツール `review_finish`）を足す。 ([#605](https://github.com/pecotcraft/pecot/pull/605), [#570](https://github.com/pecotcraft/pecot/issues/570))
  自動レビューが失敗・上限・設定の不足で止まったときだけ、止まったことを知らせるコメントを PR に 1 つ書く。

- w-onboarding が、カレントリポに自動レビューのワークフローを入れるかを聞き、入れるなら雛形を置いて設定の順を示し、最後に確かめる。導入と運用の説明を w-help に足す。 ([#620](https://github.com/pecotcraft/pecot/pull/620), [#573](https://github.com/pecotcraft/pecot/issues/573))
- 自動レビューの 2 巡目は、前の指摘が直ったかを先に書き、F-NN を PR の中の通し番号で振ります（`R2/F-01` の形をやめました）。 ([#642](https://github.com/pecotcraft/pecot/pull/642), [#574](https://github.com/pecotcraft/pecot/issues/574))
  `pr show --reviews` の行コメントに `url` が加わりました。雛形（review 3）は、合言葉より後に push されたコミットをレビューしません。

- `pr create` の head に **`owner:branch`** を渡すと、fork のブランチから PR を作れる。 ([#631](https://github.com/pecotcraft/pecot/pull/631), [#613](https://github.com/pecotcraft/pecot/issues/613))
  作る前の確かめは、その owner の fork を指す remote に push 済みかを見て、足りなければ remote とブランチ名を添えた直し方を出す。
  `--head` で今と別のブランチを指したときも、そのブランチの push を確かめる。

- 自動レビューの雛形を `review 4` に上げ、変数 `PECOT_REVIEW_PROJECT` でプロジェクトの設定を指定できるようにしました。 ([#660](https://github.com/pecotcraft/pecot/pull/660), [#640](https://github.com/pecotcraft/pecot/issues/640))
  リポが 2 つ以上の設定に入っているときに置くと、w-review がその設定で動きます。
  `pecot workflow install review --force` で入れ直してください。


### 🩹 Fixes

- `issue reopen` で開き直した Issue が、ボードの自動化（Auto-close issue）で**閉じ直されることがある**不具合を修正。 ([#550](https://github.com/pecotcraft/pecot/pull/550), [#536](https://github.com/pecotcraft/pecot/issues/536))
  ボードの組み込みの `Status` が `Done` なら、開き直す前に値を消す。消したかどうかを MCP の結果の `doneCleared` で返す。

- w-onboarding と w-pr が本文に埋め込んでいたスクリプトを、スキルの `scripts/` に移した。 ([#559](https://github.com/pecotcraft/pecot/pull/559), [#548](https://github.com/pecotcraft/pecot/issues/548))
  w-onboarding の兄弟リポの検出で、エージェントがスクリプトを動かして出力で決めるようになる。
  使われていない w-onboarding の `open_browser.sh` を消した。

- GitHub Copilot CLI で、エージェントが使えるツールを**定義のとおり絞る**ようにした。 ([#563](https://github.com/pecotcraft/pecot/pull/563), [#551](https://github.com/pecotcraft/pecot/issues/551))
  w-reviewer は編集のツールを使えず、`/agent` の警告も出ない。

- 前提の Issue が開いたまま PR がマージ済みのとき、着手の判定が `no PR` でなく **`PR merged, Issue open`** と出して止まる。 ([#560](https://github.com/pecotcraft/pecot/pull/560), [#553](https://github.com/pecotcraft/pecot/issues/553))
  止める文に、Issue を閉じるか閉じてから打ち直す手当てを添える。

- 検証用の設定の比べと片付けのスクリプトを、プラグインの `scripts/sandbox/` に移す。利用者の使い方は変わらない。 ([#578](https://github.com/pecotcraft/pecot/pull/578), [#562](https://github.com/pecotcraft/pecot/issues/562))
- 自動レビューのワークフローの雛形 `pecot-review.yml` を、`cli/templates/workflow/` に同梱する。 ([#602](https://github.com/pecotcraft/pecot/pull/602), [#568](https://github.com/pecotcraft/pecot/issues/568))
  雛形を置くコマンドはまだ無いので、利用者の動きは変わらない。

- 設定とトークンの無い clone で `pr create --prepare` が止まらず、`Closes` を空のままテンプレートを書く。 ([#584](https://github.com/pecotcraft/pecot/pull/584), [#583](https://github.com/pecotcraft/pecot/issues/583))
  `.pecot/config/` の無い clone では `.env` を作らず、`gh auth login` と起動前の環境変数で渡す案内を出す。

- `pr restack` の push が、pre-push のフックを含めて **10 分まで待つ**。フックが 60 秒を超えるリポでも、push と base の記録の書き直しまで終わる。 ([#599](https://github.com/pecotcraft/pecot/pull/599), [#585](https://github.com/pecotcraft/pecot/issues/585))
  時間切れで止まったときは、時間切れだと分かる文と、手で push してから打ち直す案内を出す。MCP から呼んだ push は、待つ間も要求の取り消しを受けて止まる。

- MCP のツールが git・gh・`setup_command` を待つ間も、ping へ答えるようにした。 ([#610](https://github.com/pecotcraft/pecot/pull/610), [#593](https://github.com/pecotcraft/pecot/issues/593))
  取り消すと、子プロセスへ SIGTERM を送り、残ればその子ごと止める。子は端末に入力を尋ねられなくなる。
  `release` の ls-remote と `session finish` の `git pull` は、時間切れで止まる。

- 積んだ PR の Issue が、下の段のマージの後も**ボードで In Progress にならず、閉じない**不具合を修正。 ([#604](https://github.com/pecotcraft/pecot/pull/604), [#603](https://github.com/pecotcraft/pecot/issues/603))
  `pr restack` は開発ブランチへ載せ直した後、PR の本文を変えずに保存し直す。GitHub が `Closes` をリンクにする。
  保存し直した PR の番号を、MCP の結果の `relinked` で返す。

- 表を回すテストの題の **`$キー` が読めない形**だと lint が止め、**同じファイルで題が重なる**とテストが止める。 ([#626](https://github.com/pecotcraft/pecot/pull/626), [#606](https://github.com/pecotcraft/pecot/issues/606))
- board sync・自動レビューの雛形の setup-node が、npm のキャッシュを戻さず保存もしなくなる。 ([#627](https://github.com/pecotcraft/pecot/pull/627), [#617](https://github.com/pecotcraft/pecot/issues/617))
  置いた `pecot-board-sync.yml` の setup-node にも `package-manager-cache: false` を足す。

- 自動レビューの雛形を `review 2` に上げ、w-review が `gh pr diff` で PR の diff を読むようにしました。 ([#635](https://github.com/pecotcraft/pecot/pull/635), [#633](https://github.com/pecotcraft/pecot/issues/633))
  `pecot workflow install review --force` で入れ直してください。

- 検証用の設定を比べるスクリプトが、自動レビューの workflow の写しも比べる。 ([#662](https://github.com/pecotcraft/pecot/pull/662), [#639](https://github.com/pecotcraft/pecot/issues/639))
  このリポだけの運用の ruleset は比べない。利用者の使い方は変わらない。

- w-quick と w-active は、計画を書く前に、Issue と依頼の曖昧な点を Spec Kit の clarify と同じ進め方で聞きます。 ([#653](https://github.com/pecotcraft/pecot/pull/653), [#649](https://github.com/pecotcraft/pecot/issues/649))
  plan テンプレの Notes から「判断を仰ぐ点」を外し、聞いて決めた点を書く欄にしました。

- フェーズの前提の種類を決める文に**試験環境**を足した。前提の変更を試験環境で動かして確かめられるなら「積める」になり、マージを待たずに着手できる。「マージを待つ」の例から、プラグインを外した。 ([#557](https://github.com/pecotcraft/pecot/pull/557), [#479](https://github.com/pecotcraft/pecot/issues/479))

### ⚠️  Breaking Changes

- w-e2e-planner を消し、計画の CUJ は main が w-help の「CUJ の流し方」に従って流すようにしました。w-e2e-planner を使う手順は、この形に替えてください。 ([#565](https://github.com/pecotcraft/pecot/pull/565), [#478](https://github.com/pecotcraft/pecot/issues/478))
  CUJ に「流す先」の項目が加わり、外へ書き込む CUJ はプロジェクトの指示にある検証用で流します。
  w-reviewer は、流す先の欠けと、検証用があるのに作業中のリポで流す計画を挙げます。

- Issue・PR などのツールが `.active` ではなく、対象のリポを含むプロジェクトの設定を使う。 ([#581](https://github.com/pecotcraft/pecot/pull/581), [#579](https://github.com/pecotcraft/pecot/issues/579))
  `.active` の無い checkout でも動き、候補が 2 つ以上で選べなければ `--project` を求める。
  対象のリポを含まない設定では動かず、`.active` の切り替えで動かしていた使い方は止まる。

- `w-revise` を `w-review` に改め、PR のレビューと指摘の投稿だけにした。指摘への対応は `w-pr` の Step 5 で行う。 ([#623](https://github.com/pecotcraft/pecot/pull/623), [#571](https://github.com/pecotcraft/pecot/issues/571))
  エージェント `w-reviewer` は `w-plan-reviewer` に改め、計画のレビューだけに使う。

- w-tech-advisor を除き、clone の置き場所を `.pecot/work/<番号>/reviewer/` に、設定キーを `reviewer-clone-allow` に改めた。 ([#564](https://github.com/pecotcraft/pecot/pull/564), [#552](https://github.com/pecotcraft/pecot/issues/552))
  古いキー `tech-advisor-clone-allow` は読まないので、`false` にしていたなら新しいキーで書き直す。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 8.0.0 (2026-11-17)

### 🚀 Features

- `git-no-verify-check` と `git-sync` を初期値で無効にしました。hooks-config.json の `true` で有効になります。 ([#511](https://github.com/pecotcraft/pecot/pull/511), [#464](https://github.com/pecotcraft/pecot/issues/464))
  compact の後も `.pecot/.gitignore` を補い、`develop-aist` への commit を止めなくなりました。
  w-pr・w-revise は、CI を待つ前にコンフリクトを確かめます。

- 計画の承認の後の案内を、w-active・w-quick を起動したセッションにだけ出すようにしました。 ([#510](https://github.com/pecotcraft/pecot/pull/510), [#466](https://github.com/pecotcraft/pecot/issues/466))
  GitHub Copilot CLI では、この案内を出しません。`.pecot/state/.pecot-quick-mode` は作らなくなり、古いものが残っていても読みません。

- w-breakdown が、分解の作業を Epic の下のタスクとして起票し、そのタスクのブランチで speckit を進めるようになりました。 ([#494](https://github.com/pecotcraft/pecot/pull/494), [#467](https://github.com/pecotcraft/pecot/issues/467))
  speckit の git 拡張に `NNN-<名前>` のブランチを作らせず、成果物はタスクを閉じる PR で開発ブランチに入ります。

- PR 作成・起票・マージで、フックが承認を求めなくなりました。 ([#481](https://github.com/pecotcraft/pecot/pull/481), [#462](https://github.com/pecotcraft/pecot/issues/462))
  Bash の `pecot` と GitHub MCP の PR 作成も止めません。承認を省くフラグと設定キーを除きました。

- フックのリマインダー・決まりの注入・開始時の案内・通知音・自動 push を撤廃しました。 ([#496](https://github.com/pecotcraft/pecot/pull/496), [#463](https://github.com/pecotcraft/pecot/issues/463))
  通知は組み込みの設定を使ってください。撤廃した設定キーは残っていても無視します。
  `wip/<branch>` は作らず消しもしないので、古いものは手で消してください。WebSearch の自動許可も外しました。


### 🩹 Fixes

- フックの README に、プラグインの自動更新と通知の推奨設定を足しました。 ([#535](https://github.com/pecotcraft/pecot/pull/535), [#468](https://github.com/pecotcraft/pecot/issues/468))
  最低対応版を、実機で確かめた Claude Code 2.1.325・GitHub Copilot CLI 1.0.112 に上げました。

- 設定ファイルを渡した `project activate` が、進行の欄が複数あるボードで**別の suffix の設定ファイルに切り替える**不具合を修正。 ([#485](https://github.com/pecotcraft/pecot/pull/485), [#469](https://github.com/pecotcraft/pecot/issues/469))
- `issue create` がボードの欄を書けなかったとき、**警告を出さずに列が空のまま成功で終わる**不具合を修正。 ([#485](https://github.com/pecotcraft/pecot/pull/485), [#469](https://github.com/pecotcraft/pecot/issues/469))
  書けなかった欄と値を `warning` で出し、`project activate` の案内を添える。

- MCP の `issue_block`・`issue_unblock` の結果に、**動かした列と札が `moves` で入る**ようにした。ボードを読み直さなくても、列が動いたかが分かる。 ([#486](https://github.com/pecotcraft/pecot/pull/486), [#470](https://github.com/pecotcraft/pecot/issues/470))
- `issue create` をファイルと `--dry-run` で打つと、ファイルごとの `dry-run` の行を出す。 ([#488](https://github.com/pecotcraft/pecot/pull/488), [#471](https://github.com/pecotcraft/pecot/issues/471))
  MCP の `issue_create` の要約の文は、表の見出しでなく、この行になる。

- `pr check` と `pr create` の事前確認が、remote とずれたブランチに `git push` を勧めなくなった。 ([#491](https://github.com/pecotcraft/pecot/pull/491), [#472](https://github.com/pecotcraft/pecot/issues/472))
  載せ直しが要る積んだブランチには `pr restack` を、それ以外には `git pull --rebase` などを案内する。

- `.pecot-base` の無い作業ディレクトリでも、積んだ先を作業中の Issue の判定と git から求める。 ([#534](https://github.com/pecotcraft/pecot/pull/534), [#473](https://github.com/pecotcraft/pecot/issues/473))
  別の worktree や clone で続けた積んだ作業で、PR の操作が下の段を base にする。

- `board add` が Status を書けないと、**追加に失敗したと読める error で止まる**不具合を修正。 ([#525](https://github.com/pecotcraft/pecot/pull/525), [#483](https://github.com/pecotcraft/pecot/issues/483))
  列を書く各コマンドは、ID が古いときだけ `project activate` を案内する（`issue create` も同じ条件に絞る）。
  `issue reopen` は列を書けなくても開き直しとコメントを続け、**終了コード 0** で終わる。

- board sync の雛形が **npm の最新の正式版（`@latest`）を取る**ようにし、major が上がっても直さずに動く。 ([#502](https://github.com/pecotcraft/pecot/pull/502), [#499](https://github.com/pecotcraft/pecot/issues/499))
  互換の無い変更を止めたいときは `@<版>` に替える。main の開発版は `@next` で取れる。

- `pr restack` が載せ直し済みのブランチを rebase し直さず、push と記録の書き直しだけを行うようになった。 ([#509](https://github.com/pecotcraft/pecot/pull/509), [#503](https://github.com/pecotcraft/pecot/issues/503))
  `branch delete` が、origin の URL が手元のパスのリポでも削除するようになった。

- origin の URL から `owner/repo` を読めないリポでも、**`--repo` を渡したコマンドが止まらない**ようにした。 ([#524](https://github.com/pecotcraft/pecot/pull/524), [#506](https://github.com/pecotcraft/pecot/issues/506))
  `warning` を出して `--repo` を使う。`--repo` を省くと、読めない理由を添えて止まる。

- remote の URL から `owner/repo` を、**GitHub のリポを指せる git の標準の形（スキーム付きと scp 形式）**で読むようにした。 ([#545](https://github.com/pecotcraft/pecot/pull/545), [#515](https://github.com/pecotcraft/pecot/issues/515))
  `user@host:`・ssh config の別名・`git://`・末尾に `/` の付いた `https://` などの remote でも、`--repo` を省いたコマンドが止まらない。

- w-active・w-quick で計画が承認された後、エージェントが止まらずに実装を始めるようにしました。 ([#519](https://github.com/pecotcraft/pecot/pull/519), [#518](https://github.com/pecotcraft/pecot/issues/518))
  承認の後の案内が届かないときや、GitHub Copilot CLI でも、スキルの本文に従って実装に進みます。

- `issue create` の `--freeform` は、題を `--message` の 1 行目だけから作る。 ([#547](https://github.com/pecotcraft/pecot/pull/547), [#520](https://github.com/pecotcraft/pecot/issues/520))
  1 行目が短くても、2 行目の頭が題に入らない。1 行目が 50 文字を超えるときは、今までどおり 50 文字で切る。

- `issue reopen` でコメントを投稿できないと、**開き直しに失敗したと読める error で止まる**不具合を修正。 ([#544](https://github.com/pecotcraft/pecot/pull/544), [#522](https://github.com/pecotcraft/pecot/issues/522))
  `could not comment on Issue …` で止まる。空白だけの `--comment` は、開き直す前に止める。

- `session finish` が、**すでに閉じた Issue を閉じ直さない**ようにした。not planned で閉じた Issue の理由が、completed に書き換わらない。 ([#546](https://github.com/pecotcraft/pecot/pull/546), [#533](https://github.com/pecotcraft/pecot/issues/533))
  既定ブランチ宛ての PR では、閉じる Issue を GitHub の closing issues にそろえ、本文のコードブロックの中の `Closes #N` を数えない。

### ⚠️  Breaking Changes

- 作業中の Issue を、`.pecot-active` ではなく git の remote とブランチ名から求める。 ([#482](https://github.com/pecotcraft/pecot/pull/482), [#465](https://github.com/pecotcraft/pecot/issues/465))
  `session_start` の `allow_cross_repo`・`force_overwrite_active` と、`session_restore` を消した。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 7.0.0 (2026-11-16)

### 🚀 Features

- w-ready が、先に終える Issue を前提に付けてサブタスクを作り、前提に応じて `Ready` か `Blocked` に置く。 ([#459](https://github.com/pecotcraft/pecot/pull/459), [#385](https://github.com/pecotcraft/pecot/issues/385))
  w-help に、前提の PR の上に積んで着手し、下の段からマージして載せ直す流れを足した。

- w-pr が PR を作った後に `gh pr checks --watch` で CI を待ち、落ちたら直すようになった。 ([#454](https://github.com/pecotcraft/pecot/pull/454), [#453](https://github.com/pecotcraft/pecot/issues/453))
  w-merge も同じ待ち方にそろえ、`merge-wait.sh` を削除した。

- `pecot pr merge`（`pr_merge`）で、**単独の PR とスタックの最下段の PR をマージできる**。 ([#450](https://github.com/pecotcraft/pecot/pull/450), [#383](https://github.com/pecotcraft/pecot/issues/383))
  `session finish` は、待っていた Issue の判定の変化と、上の段の載せ直しの案内を出す。
  hook は `gh stack` を止め、`pr_merge` を確認にかける。

- `pr restack`（MCP ツール `pr_restack`）を足した。積んだブランチを、base の新しい位置へ載せ直す。 ([#451](https://github.com/pecotcraft/pecot/pull/451), [#384](https://github.com/pecotcraft/pecot/issues/384))
  `session show` は、`needs restack` と `stacked above` の行を出す。
  w-revise は、レビューの前に載せ直しを確かめ、上の段の載せ直しを報告する。


### 🩹 Fixes

- w-reviewer・w-tech-advisor・w-implementer が、**標準や公式の仕様とのズレを不適合として扱う**。 ([#438](https://github.com/pecotcraft/pecot/pull/438), [#437](https://github.com/pecotcraft/pecot/issues/437))
  計画のレビューは仕様と項目ごとに比べ、標準と違う計画は実装せずに返す。

- `eslint` を 10.14.0 から 10.15.0 に更新。 ([#448](https://github.com/pecotcraft/pecot/pull/448), [#446](https://github.com/pecotcraft/pecot/issues/446))
- `XDG_DATA_HOME` が空か相対パスの環境で、**初回の起動が止まる**不具合を修正。 ([#455](https://github.com/pecotcraft/pecot/pull/455), [#452](https://github.com/pecotcraft/pecot/issues/452))
- 前提の Issue への言及が 20 件を超えると、**判定が `unknown` になり Blocked のまま動かない**不具合を修正。 ([#458](https://github.com/pecotcraft/pecot/pull/458), [#457](https://github.com/pecotcraft/pecot/issues/457))
- w-revise が**計画の CUJ を初めて実行する場所と読めた**のを直し、修正後の再実行だけを持つようにした。 ([#458](https://github.com/pecotcraft/pecot/pull/458), [#457](https://github.com/pecotcraft/pecot/issues/457))

### ⚠️  Breaking Changes

- 計画と PR のレビューを、エージェント `w-reviewer` の 1 体が 3 つの視点で行う。 ([#445](https://github.com/pecotcraft/pecot/pull/445), [#444](https://github.com/pecotcraft/pecot/issues/444))
  w-tech-advisor は実装中の技術の質問だけ、w-e2e-planner は CUJ の実行だけを担う。
  w-revise の小さな修正は main が直し、指摘には視点の印が付く。

- MCP ツールの結果を、MCP の仕様の形にした。`ok`・`exitCode`・`data`・`artifacts`・`message` が無くなった。 ([#441](https://github.com/pecotcraft/pecot/pull/441), [#436](https://github.com/pecotcraft/pecot/issues/436))
  ツールごとの項目は `structuredContent` の最上位、成否は `isError`、失敗は `kind` と `detail` で読む。

- MCP ツールの結果から `stdout` と `stderr` が無くなった。成功の中身は、ツールごとの項目で返す。 ([#435](https://github.com/pecotcraft/pecot/pull/435), [#433](https://github.com/pecotcraft/pecot/issues/433))
  作ったファイルの絶対パスは `file` などの項目、警告は `warnings`、失敗の文は `detail` に入る。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

# 6.0.0 (2026-11-15)

### 🚀 Features

- `pecot issue block` と `pecot issue unblock` を足し、既存の Issue の前提と種類を後から直せるようにする。 ([#423](https://github.com/pecotcraft/pecot/pull/423), [#379](https://github.com/pecotcraft/pecot/issues/379))
- `pecot session start` が着手の判定で base を選び、ブロック中の Issue では止まる。 ([#419](https://github.com/pecotcraft/pecot/pull/419), [#380](https://github.com/pecotcraft/pecot/issues/380))
- `pecot pr create` が、積んで着手したブランチの PR を下の段のブランチ向けに作ってスタックに登録し、その PR を待っていた Issue の列を動かす。 ([#430](https://github.com/pecotcraft/pecot/pull/430), [#381](https://github.com/pecotcraft/pecot/issues/381))
- w-breakdown が、tasks の工程でできる tasks.md に、4 列の前提の表（Phase・前提・種類・理由）を書かせる。 ([#427](https://github.com/pecotcraft/pecot/pull/427), [#382](https://github.com/pecotcraft/pecot/issues/382))
  できた表は、承認の前に確かめる。
  w-issueize が、見出しの行と区切りの行だけの表を「前提が無い」と読み、`reason` を表の理由のとおりに写す。

- 列と札を判定に合わせて直す `pecot board sync`（`board_sync`）を足した。 ([#410](https://github.com/pecotcraft/pecot/pull/410), [#404](https://github.com/pecotcraft/pecot/issues/404))
  GitHub Actions から打つワークフローの雛形も足した。置くかは利用者が選ぶ。

- レビューのエージェントが main のモデルを引き継がず opus で動き、実装者は計画の作業単位ごとに選んだモデルで起きる。 ([#411](https://github.com/pecotcraft/pecot/pull/411), [#408](https://github.com/pecotcraft/pecot/issues/408))
- `pecot board show` と `pecot issue show` が着手の判定を出す。 ([#402](https://github.com/pecotcraft/pecot/pull/402), [#377](https://github.com/pecotcraft/pecot/issues/377))
- `pecot issue create` が、Issue ファイルの `blocked_by` を blocked by として付ける。 ([#414](https://github.com/pecotcraft/pecot/pull/414), [#378](https://github.com/pecotcraft/pecot/issues/378))
  `--plan` で、投稿せずに進め方の表を出す。番号は通し番号になり、`parallel` は使えない。


### 🩹 Fixes

- python3 の無い端末でも、w-onboarding と w-pr の手順が通る。 ([#401](https://github.com/pecotcraft/pecot/pull/401), [#399](https://github.com/pecotcraft/pecot/issues/399))
- GitHub Copilot CLI でも、プランの承認の後に、計画の打ち直しと実装の引き継ぎの案内が出る。 ([#409](https://github.com/pecotcraft/pecot/pull/409), [#403](https://github.com/pecotcraft/pecot/issues/403))
- w-help の Issue 起票の規則が、消えた Python のファイルと関数を示さない。 ([#407](https://github.com/pecotcraft/pecot/pull/407), [#406](https://github.com/pecotcraft/pecot/issues/406))
- board sync のワークフローの案内に、1 回の実行の GraphQL の点数の式と、merge queue のリポでの動き、fine-grained PAT を使えない場面を足した。 ([#432](https://github.com/pecotcraft/pecot/pull/432), [#413](https://github.com/pecotcraft/pecot/issues/413))
- コマンドの `--help` が、定義書の **`help` の欄**（英語の文）から Details・Examples・初期値の補足を読む。出る文は変わらない。 ([#421](https://github.com/pecotcraft/pecot/pull/421), [#415](https://github.com/pecotcraft/pecot/issues/415))
- GitHub Copilot CLI の auto でも、レビューと実装のエージェントが起きて結果を返す。 ([#425](https://github.com/pecotcraft/pecot/pull/425), [#416](https://github.com/pecotcraft/pecot/issues/416))

### ⚠️  Breaking Changes

- `issue quick` を消し、入力名を `issue_ref`・`repo`・`branch`・`dry_run` にそろえた。 ([#431](https://github.com/pecotcraft/pecot/pull/431), [#428](https://github.com/pecotcraft/pecot/issues/428))
  読むコマンドは何も書き換えず、書き込むコマンドは `--dry-run` で予行できる。
  古い入力名は使えない。README の「コマンド名の移行」で書き換える。

- MCP ツールの結果を、pecot-tools・pecot-visual と同じ JSON の形にした。 ([#429](https://github.com/pecotcraft/pecot/pull/429), [#422](https://github.com/pecotcraft/pecot/issues/422))
  失敗の原因の名前を `kind` で返す。文だけの結果と `exit code: <n>` の行は無くなった。

- コマンド名とツール名を、対象のグループと決めた動詞の 2 語にそろえ、17 個の名前が変わった。 ([#424](https://github.com/pecotcraft/pecot/pull/424), [#412](https://github.com/pecotcraft/pecot/issues/412))
  古い名前は使えない。許可の設定とスクリプトは、README の「コマンド名の移行」で書き換える。

### ❤️ Thank You

- Kohei Hayakawa @kouhei0831

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
