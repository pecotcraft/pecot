# Nx Release によるリリース

`release_type: nx` が設定されているリポ向け。`$NX release` が version plan をもとに、
リリース処理を一括で実行する。

## nx の起動コマンド（`$NX`）

npm 11 以降は、`devEngines.packageManager` が pnpm の dir で `npx` が `EBADDEVENGINES` で止まる。
対象は root に `pnpm-lock.yaml` がある pnpm のリポ。
そのため、pnpm のリポは `pnpm exec nx`、それ以外は `npx nx` で起動する。
Bash の呼び出し間で変数は残らないので、`$NX` を使うコマンド例は 1 行の中で判定まで行う。
判定は `cd <project-root>/base/<repo>` の後に置き、リポの root の `pnpm-lock.yaml` を見る。
以降のコマンド例の `$NX` は、この判定で決まる値を指す。

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX <subcommand>
```

## 前提

- リポに `nx.json` の `release` セクションが整備されている
- PR merge 時点で `.nx/version-plans/*.md` に plan が累積されている
- 各 plan の frontmatter に bump 種別 (`patch` / `minor` / `major`) が宣言済み

Nx Release の自動処理は各リポの `nx.json` 設定で決まる。対象は manifest の書き換え・
CHANGELOG の形式・commit メッセージ・タグ形式・GitHub Release の発行など。
詳細はそのリポの設定と Nx 公式ドキュメントを参照。

## ブランチモードによる分岐

w-release SKILL.md の Step 1 で判定したブランチモードに従う。

- `pecot project info` の対象リポ行で `develop:` と `release:` が同じなら、**単一ブランチモード**になる
  （pecot は両方 `main`）。[単一ブランチモード（develop == release）](#単一ブランチモードdevelop--release) に従う。
  `main` 上で `$NX release` を実行し、リリース PR と `pecot release merge` は行わない。
- 対象リポ行で `develop:` と `release:` が異なるなら、**2ブランチモード**になる。
  下記の [2ブランチモードの手順](#2ブランチモードの手順) に従う。

pecot では pecot-visual の version 作成より前に、依存監査が自動で動く。
対象は配布ツリー（`@pecot/visual-mcp`）と永続層の 2 つ。永続層は、`setup` が置き場の `mcp-dist/` へ入れる
Slidev / dom-to-pptx とその推移依存を指す。どちらかのツリーで high 以上の脆弱性を検出したときと、
監査結果を得られなかったときは、リリースが止まる。止まるのは version フェーズの前なので、
commit・タグ・push は作られない。待ち上限は npm 呼び出し 1 回あたり 180 秒で、呼び出しは最大 5 回
（カナリア監査・2 ツリーの依存解決・2 ツリーの監査）。不達で止まったときは監査エンドポイントの回復を待って
再実行する。`--verbose` を付けるのは監査の要約行を出力に残すため。

high 以上でも中止しない advisory は `plugins/pecot-visual/scripts/release/audit-exceptions.json`
に列挙する。期限で自動失効しないので、リリースのたびに各項目の `reevaluate` を読み、
上流に修正版が出ていれば依存を上げて項目を削除する。免除した advisory の id とパッケージは
監査の出力に列挙される。

この監査は dry-run でも実際に実行され、レジストリへの到達が要る（dry-run の出力に監査結果
を残すため）。オフラインでは dry-run も監査未実施で止まる。監査は毎回使い捨てキャッシュを使うので、
dry-run にも本実行と同じだけ時間がかかる。

publish は監査時の配布ツリーの指紋と、これから配布するツリーの指紋を突合し、不一致なら
配布しない（監査したツリーと配布ツリーの取り違え・ドリフトの検出であって、改竄防止では
ない）。永続層の指紋も記録に残るが突合しない。永続層は利用者の環境で毎回解決し直されるため、
監査時点の証跡以上の意味を持たない。

## publish フェーズの扱い

Nx Release の最終段（publish phase）は release group 内の project の `nx-release-publish`
target を実行する。**このフェーズを通すか止めるかでコマンドのフラグが変わる**ため、
dry-run の前に対象リポで判定する。

判定するのは「**自リポが publish target を意図的に定義しているか**」。`$NX show projects
--with-target nx-release-publish` の出力が非空であることを条件にしてはいけない。`@nx/js` を
使うリポでは、publishable package に `nx-release-publish` が自動で付く。その実体は
**npm registry への publish** になる。出力の非空を `--yes` の根拠にすると、registry への
公開を意図しないリポまで公開されてしまう。

自リポの設定ファイルに明示の定義があるかを見る。

```bash
grep -rln '"nx-release-publish"' \
    --include=project.json --include=package.json --include=nx.json \
    . --exclude-dir=node_modules
```

| 出力 | 付けるフラグ | 理由 |
|---|---|---|
| なし | `--skip-publish` | 自リポが定義していない publish は実行しない。publish prompt の抑止も兼ねる（`private: true` だけでは prompt は止まらず、フラグを消すと prompt が復活して hang する） |
| 自リポの設定ファイル | `--yes` | `--skip-publish` を付けると publish target が実行されない。リポが publish フェーズに載せている処理（pecot なら MCP サーバの tgz を Release に添え、npm への publish のワークフローを起動する処理）が丸ごと飛ぶ |

grep には出ないのに publish target が存在するリポ（= `@nx/js` の自動付与）で publish を
通したい場合、それは npm registry への公開そのもの。公開が意図どおりであることを確認して
から `--yes` を選ぶ。

`--yes` と `--skip-publish` は Nx で **mutually exclusive**。両方付けると Nx がエラーで
終了するため、必ずどちらか一方にする。以降の手順ではここで決めたフラグを
`<publish-flag>` と表記する。

**dry-run にも同じフラグを使う。** publish target を実行するかどうかの判定に dryRun は
関与しない。dry-run だけ `--skip-publish` にすると、publish フェーズを一度も
プレビューしないまま本実行を迎える。

裏返すと、`--yes` を選んだ dry-run では publish target のコマンドが実際に起動する。
pecot は pecot-visual と pecot-tools の 2 本の publish target を持ち、どちらも動く。
pecot-visual 側の配布スクリプトは次の順に実行する。

1. `pnpm install --frozen-lockfile`（pecot は pnpm のリポ）
2. cli / eslint プラグインのビルド（`prebuild` が `dist` を消すため毎回フルビルド）
3. `npm install --package-lock-only`
4. `npm pack`

pecot-tools 側の配布スクリプトも、同じ frozen install・cli のビルド・依存の解決・`npm pack` を実行する。
どちらも npm レジストリへの照会を伴うため**ネットワーク接続が要る**。frozen install は lockfile と
`package.json` の一致も求める。乖離があればそこで止まる。pecot-visual・pecot-tools の
一方しか bump しないリリースでも、dry-run は両方のコストがかかる（Release への添付と
ワークフローの起動は表示だけ）。

### publish が失敗したとき

publish フェーズは、version commit・タグ・push・GitHub Release がすべて完了した後に動く。
publish だけが失敗した場合、リリース自体は成立しているので最初からやり直す必要はない。
原因を除去してから、publish だけを再実行する。

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release publish
```

再実行の安全性は publish target の実装が担保する。pecot では、pecot-visual と pecot-tools が
それぞれ HEAD のタグで冪等性を判定する。タグは `pecot-visual-v<version>` / `pecot-tools-v<version>`。
Release に同名の tgz があれば `--clobber` で上書きし、ワークフローは公開済みの版を既出として
成功で終える。判定はスクリプトごとに独立しているため、一方の再実行が他方の状態に影響しない。

再実行は release commit を checkout した状態で行う。監査記録は、最後に実行した `nx release` の
もので上書きされる。その実行時の HEAD に pecot-visual の version plan とリリースタグのどちらも
無かった場合は、`skipped` 記録になり publish が止まる。

止まった理由が `skipped` 記録か指紋の不一致（`監査した依存ツリーと配布ツリーが一致しません`）なら、
release commit 上で監査を再実行する。記録を作り直してから publish する。
HEAD の `pecot-visual-v<version>` タグがあるため、version plan が消費済みでも再監査として動く。

```bash
bash plugins/pecot-visual/scripts/release/audit-mcp-dist.sh
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release publish
```

## 単一ブランチモード（develop == release）

開発ブランチと release ブランチが同一（`main`、trunk-based）のリポ向け。Nx Release は
current branch に commit する。そのため `main` 上で `$NX release` を実行すれば、commit・タグ・
push・GitHub Release の発行までが一括で完結する。**`develop` と `release` が同じブランチで
中間 PR が存在しないため、リリース PR 作成と `pecot release merge` は行わない。**

以降、GitHub ホスト名を `<gh-host>` と表記。値は `pecot project info` の Host で決まる（例: `github.com`）。

### 手順の選び方（ランナーか手元か）

次のコマンドで、リモートの default branch の `release.yml` を取る。

```bash
gh workflow view release.yml -R <owner>/<repo> --yaml
```

ランナーの手順に従うのは、次の 2 つをどちらも満たすときだけ。

1. コマンドが成功する
2. 出力の YAML に、job `plan`・`release` がある

`release.yml` はよくある名前なので、別の目的のファイルを起動しないよう、2 を確かめる。
手元の手順（下の 1〜8）に進むのは、`HTTP 404` のときと、2 を満たさないときだけ。
認証切れ・ネットワークなど、それ以外の失敗では止めて、ユーザーに報告する。

### ランナーの手順（`release.yml` があるリポ）

承認は GitHub の画面でユーザーが行う。
エージェントは、画面でも `pending_deployments` の API でも承認しない。

1. 起動する。出力の URL の末尾が run の id になる。

   ```bash
   gh workflow run release.yml --ref main -R <owner>/<repo>
   ```

   URL が取れなければ、次のコマンドで引く。
   起動した時刻より後で、`headSha` が main の HEAD の run を選ぶ。

   ```bash
   gh run list --workflow release.yml --event workflow_dispatch --json databaseId,createdAt,headSha -L 5 -R <owner>/<repo>
   ```

2. `plan` の job の結論を待つ。`gh run watch` は承認待ちで戻らないので使わない。
   次の 1 コマンドで、上限 30 分まで待つ。`plan` の結論が出たら、その値を表示して終わる。

   ```bash
   timeout 1800 bash -c 'until c=$(gh run view <id> -R <owner>/<repo> --json jobs --jq ".jobs[]|select(.name==\"plan\").conclusion") && [ -n "$c" ]; do sleep 20; done; echo "$c"'
   ```

   `success` なら次へ進む。
   `success` 以外（`failure`・`cancelled`・`skipped`）は止めて、
   [release-nx-recovery.md](release-nx-recovery.md) の「ランナーが失敗した場合」に従う。
   `skipped` は、リポジトリの変数 `PECOT_BOT_CLIENT_ID` か ref の問題として、ユーザーに伝える。
   上限まで待っても結論が出ず、run の `status` が `pending` のままなら、承認待ちの別の run がある。
   次のコマンドで確かめる。

   ```bash
   gh run list --workflow release.yml --status waiting -R <owner>/<repo>
   ```

3. `plan` が残した案を読み、ユーザーに示す。
   観点は、2ブランチ手順の「5. bump 妥当性のユーザー確認」と同じ。
   案は `release-plan` という名前の artifact に入っている。
   `nx.log` から bump・tag・CHANGELOG の案を読む。`plans.log` は plan の件数である。

   ```bash
   gh run download <id> -n release-plan -D .pecot/work/<Issue番号>/release-plan -R <owner>/<repo>
   ```

   `preflight.log` に `warning:` で始まる行があれば、その行と続く行をユーザーに示す。
   Summary の「preflight warnings」にも同じ行が出る。
   `warning: could not check Dependabot alerts` が出たときは、App の権限（Dependabot alerts の read）とトークンを確かめていただく。

   案が誤っていたら、承認を案内しない。
   `gh run cancel <id> -R <owner>/<repo>` で止め、plan を直す PR を出し、マージしてから起動し直す。

4. 案に問題が無ければ、承認の画面を開いて承認していただくようユーザーに案内する。
   承認を待つ間、エージェントは何もしない。ユーザーが承認したと伝えるまで、次へ進まない。
5. `release` の job の完了を待つ。待ち方は 2 と同じで、job 名を `release` にする。
   完了したら、発行したタグ名と GitHub Release の URL を報告する。
   タグ名と URL は、次のコマンドで取る。

   ```bash
   gh release list -L 4 -R <owner>/<repo>
   ```

   `plan` が preflight で止まったときは、open の code scanning・secret scanning の alert があるか、その一覧を取得できない。
   手元の手順の「3. open の security alert を確認（preflight）」に従う。
   扱いは、解消か理由付きの dismiss である。

### 手元の手順（`release.yml` が無いリポ）

以降の 1〜8 が、手元の手順になる。

### 1. base worktree で `main` を最新化

**`base/<repo>` で実行する。** どの worktree から起動しても base へ移動して実行する。
実行場所はユーザーに確認しない。Nx Release は checkout 中のブランチに release commit を
載せるため。base は `main` を checkout している前提。

```bash
git worktree list                       # base/<repo> のパスを確認
cd <project-root>/base/<repo>         # base worktree に移動
git status                              # clean かつ main が checkout されていることを確認
git pull --ff-only origin main
```

pecot では root フック（`check-text` / `check-commit-text`）が `libs/text-rules/dist` を使う。
release commit は `--no-verify` なしでそのフックを通る。dist は依存の導入の lifecycle でしか作られないため、導入して作る。
pnpm のリポでは `pnpm install --frozen-lockfile`、npm のリポでは `npm ci` を使う。lockfile のずれで導入が止まったら、release を止めて報告する。

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else npm ci; fi
```

`main` 以外が checkout されている場合は実行しない（release commit が意図しない
ブランチに載る）。

### 2. GitHub Release 発行用 token を環境変数に投入

```bash
export GH_TOKEN="$(gh auth token --hostname <gh-host>)"
```

### 3. open の security alert を確認（preflight）

```bash
cd <project-root>/base/<repo> && pecot release preflight
```

Dependabot の open の alert は、件数・最高 severity・一覧 URL を警告に出すだけで止めない。
その一覧を取得できないときも警告にとどめる。
後で対応する open の Dependabot alert は、`pecot security sync` が立てる security alert の Tracker で追う。
止めるのは、code scanning・secret scanning の open の alert があるときと、その一覧を取得できないときの 2 つ。
alert は、解消（fixed）か理由付きの dismiss で 0 件にして再実行する。
一覧を取得できないときは、トークンと権限を直して再実行する。
alerts 無効のリポは `skipped: Dependabot alerts (feature disabled)` と出て通る。nx のリポでは version 引数と `--package` は指定できず、
version 整合・タグ・差分の検証は Nx Release が担う。

### 4. dry-run でプレビュー確認

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release --dry-run --verbose <publish-flag>
```

Step 1 の `cd` とは別の Bash 呼び出しになるため、毎回 `cd` を先頭に付けて cwd の持続に
依存させない。

`<publish-flag>` は [publish フェーズの扱い](#publish-フェーズの扱い) で判定したもの。
確認観点は 2ブランチ手順の dry-run と同じ（bump 対象 project・新バージョン・タグ名・
CHANGELOG 追記内容・GitHub Release 対象 URL）。想定と違う場合は plan ファイルを編集
してから再実行する。

### 5. bump 妥当性のユーザー確認

2ブランチ手順の同名 Step と同じ観点でユーザーへ提示し、明示承認を得る（過剰 bump の
チェック等。判断基準の詳細は
[2ブランチモードの「5. bump 妥当性のユーザー確認」](#5-bump-妥当性のユーザー確認-1) を参照）。承認を
得るまで本実行しない。

### 6. 本実行（main 上で発行）

ユーザー承認後に `main` 上で実行する。

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release --verbose <publish-flag>
```

`<publish-flag>` の選び方と mutually exclusive の制約は
[publish フェーズの扱い](#publish-フェーズの扱い) を参照。

これで Nx Release が `main` 上に release commit を作る。release commit には manifest 更新・
CHANGELOG 追記・消費した version-plan の削除が入る。続けてタグ付け・remote `main` への push・
GitHub Release の発行までを完了する。

### 7. リリース PR・release merge はスキップ

単一ブランチモードでは `<develop> → <release>` の PR が存在しない。2ブランチ手順の
「リリース PR 作成」「リリース PR マージ」（`pr create --template release` /
`pecot release merge`）は **丸ごとスキップする**。Step 6 で remote `main` への push と
GitHub Release 発行まで完結しているため追加操作は不要。

`pecot release create` は Nx Release のリリースでは不要（2ブランチモードと同じ）。`pecot release preflight` は Step 3 で実行済み。

### 8. 完了報告

発行タグ名・GitHub Release URL を報告して終了（リリース PR URL は無し）。

---

## 2ブランチモードの手順

開発ブランチと release ブランチが分かれているリポ向け。対象リポの `develop` branch は
`pecot project info` で事前に確認。以降、開発ブランチを `<develop>`、GitHub ホスト名を
`<gh-host>` と表記。値は `pecot project info` の Host で決まる（例: `github.com`）。

### 1. develop ブランチの worktree を最新化

**`base/<repo>` で実行する。** どの worktree から起動しても base へ移動して実行する。
実行場所はユーザーに確認しない。Nx Release は checkout 中のブランチに release commit を
載せるため。base は `<develop>` を checkout している前提。

```bash
git worktree list                       # base/<repo> のパスを確認
cd <project-root>/base/<repo>         # base worktree に移動
git status                              # clean であること (未コミット変更が pull で消えるのを防ぐため先に確認)
git pull --ff-only origin <develop>
```

`git checkout <develop>` は不要（すでに `<develop>` が checkout されている前提）。base
worktree でも `<develop>` 以外のブランチが checkout されている場合は実行しない（release
commit が意図しないブランチに載る）。

### 2. GitHub Release 発行用 token を環境変数に投入

Nx Release が GitHub API を叩くため必要。

```bash
export GH_TOKEN="$(gh auth token --hostname <gh-host>)"
```

### 3. open の security alert を確認（preflight）

```bash
cd <project-root>/base/<repo> && pecot release preflight
```

Dependabot の open の alert は、件数・最高 severity・一覧 URL を警告に出すだけで止めない。
その一覧を取得できないときも警告にとどめる。
後で対応する open の Dependabot alert は、`pecot security sync` が立てる security alert の Tracker で追う。
止めるのは、code scanning・secret scanning の open の alert があるときと、その一覧を取得できないときの 2 つ。
alert は、解消（fixed）か理由付きの dismiss で 0 件にして再実行する。
一覧を取得できないときは、トークンと権限を直して再実行する。
alerts 無効のリポは `skipped: Dependabot alerts (feature disabled)` と出て通る。nx のリポでは version 引数と `--package` は指定できず、
version 整合・タグ・差分の検証は Nx Release が担う。

### 4. dry-run でプレビュー確認

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release --dry-run --verbose <publish-flag>
```

dry-run も本実行と同条件にする。`<publish-flag>` は
[publish フェーズの扱い](#publish-フェーズの扱い) で判定したもの。

以下を目視確認:

- bump 対象 project が意図通り（plan の frontmatter と一致）
- 新バージョン・タグ名が妥当
- CHANGELOG 追記内容・ファイル書き換え計画が正しい
- GitHub Release の作成対象 URL が正しい

想定と違う場合は plan ファイルを編集してから再実行する。

### 5. bump 妥当性のユーザー確認

Step 4 の dry-run 出力をもとに、ユーザーへ以下を提示して明示的承認を得る。
承認を得るまで Step 6（本実行）の `$NX release`（dry-run 無し）は発行しない。

提示項目:

- 各 project の現バージョン → 新バージョン（dry-run 出力から拾う）
- 各 plan の bump 種別（`patch` / `minor` / `major`）と plan ファイル名（`.nx/version-plans/*.md`）

確認観点:

- 「未使用機能の削除」「内部のみの変更」「ドキュメント追加のみ」など、外部影響の無い変更を
  `major` plan として起票していないか
- 後方互換のある追加が `major` になっていないか
- バグ修正のみのはずが `minor` 以上になっていないか

過去に #205 で、機能削除を `major` plan で起票したまま流し、`1.0.0 → 2.0.0` に過剰 bump した。
「削除」だからといって自動的に破壊的変更ではない（未使用・内部限定なら patch が妥当）。

違和感があれば該当の `.nx/version-plans/*.md` を編集して Step 4（dry-run）からやり直す。
ユーザーから「OK」「進めて」等の明示承認を得て初めて Step 6 へ進む。

### 6. 本実行

Step 5 でユーザー承認を得た後に実行する。

```bash
cd <project-root>/base/<repo> && if [ -f pnpm-lock.yaml ]; then NX="pnpm exec nx"; else NX="npx nx"; fi && $NX release --verbose <publish-flag>
```

`<publish-flag>` は [publish フェーズの扱い](#publish-フェーズの扱い) で判定したもの。
`versionPlans` を有効にしたリポは、version bump 系 prompt が発生しない。
有効とは、`true` か `ignorePatternsForPlanCheck` を持つオブジェクトを指す。
そのため、このフラグ 1 本で non-interactive 化できる。

これで Nx Release が `<develop>` 上に release commit を作る。release commit には manifest 更新・
CHANGELOG 追記・消費した version-plan の削除が入る。続けてタグ付け・remote への push・
GitHub Release の発行までを完了する。commit メッセージ・タグ形式などの詳細は、冒頭の方針どおり
`nx.json` 設定に従う。

ただし **`<release>` ブランチ（通常 `main`）は更新されない**。Nx Release は current
branch にしか commit しないため、別途 PR で `<develop> → <release>` に反映する必要がある。

### 7. リリース PR 作成

release-single / release-multi と同じ `--prepare --template release` フローを使う。

```bash
pecot pr create --prepare --template release
```

下書きファイルを編集:

- `repository: <owner>/<repo>`
- `head: <develop>` （Step 6 の release commit が載っている branch）
- `title: "release: <project と ver を列挙>"` （例: `release: pecot-workflow v0.19.0 + pecot-visual v0.67.0`）
- 本文: release 雛形の 4 節（Summary / Changes / Migration / Verified）を
  すべて埋める（1 つでも欠けると投稿時検証で弾かれる）。Changes には bump した各 package の
  CHANGELOG の該当セクション（`## 0.19.0 (2026-04-23)` 等）を順に転記する。Nx Release が
  生成する節見出しには絵文字が付くので、外して `### Features` の形で転記する
  （本文に絵文字があると投稿時検証で弾かれる）。

```bash
pecot pr create --template release <ファイルパス>
```

**PR 作成用に feat ブランチを切る必要はない** — `<develop>` 自体を head にする（release commit が
`<develop>` 上にあるため）。

### 8. リリース PR マージ

```bash
pecot release merge <owner>/<repo>/<PR番号>
```

`--delete-branch` は**付けない**。Nx Release のリリースでは、PR の head が `<develop>` 自体になる。
このフラグを付けると `<develop>` ブランチが削除される。release-single / release-multi で
付けない理由も同じ。

`pecot release merge` は **regular merge（merge commit）を強制** し、base が `release_branch`
設定と一致することを検証する。**必ずこれを使い、`gh pr merge` は使わない**。
squash merge だと tag が指す commit が `<release>` の履歴から到達不能になり、
GitHub Release が孤児 commit を参照する状態になる。

`pecot release create` は Nx Release のリリースでは不要。Nx Release が version 整合確認・tag 作成・
GitHub Release 発行を Step 6 で完結させている。`pecot release preflight` は Step 3 で実行済み。

### 9. 完了報告

発行タグ名・GitHub Release URL・リリース PR URL を報告して終了。

---

手順を誤った場合のリカバリは [release-nx-recovery.md](release-nx-recovery.md) を参照。
