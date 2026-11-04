# Research: AIST から名前を変えて公開し、MCP の単体配布を npm に移す

spec の Clarifications で決まったことは再調査しない。ここでは、それを実現する手段を決める。

## R1. 新しい名前

- Decision: `pecot`。GitHub の Organization は `pecotcraft`
- Rationale:
  - 由来は観察研究の枠組み PECOT（Population・Exposure・Comparison・Outcome・Time）である。観察研究は、相手に手を加えず、何にさらされたらどうなったかを比べて確かめる
  - AI エージェントは作り手の思いどおりには動かない。決めつけて作らず、どんな指示と状況でどう振る舞ったかを見て、比べて確かめながら作る。この姿勢を名前に借りた
  - 5 文字で、一度聞けば綴れる。同じ領域（開発ツール・AI）の製品と OSS には、同名もハッシュタグのかぶりも無い
  - npm のスコープ `@pecot` と無印の `pecot` は空いている（2026-11-03 に registry で確認）。Homebrew・PyPI・crates.io にも同名は無い
  - GitHub の `pecot` は 2011 年作成の個人ユーザーが使っている。そのため Organization は `pecotcraft` にする
- Alternatives considered:
  - 1 回目の候補（jigsmith・dogubako・kumibako・tegumi ほか）は、所有者が「どれも微妙」と退けた
  - Organization の `pecot-dev`・`pecothq`・`getpecot`・`pecot-sh` も空いていた。当初は開発者向けと一目でわかる `pecot-dev` を選んだ。2026-11-04 に所有者が、`aistcraft` からの続きがわかる `pecotcraft` に変えた
- 似た名前: 対話的な絞り込みの CLI `peco`（Homebrew にある）が日本の開発者に知られている。綴りが違い、衝突はしない

## R2. Organization をどう新しい名前にするか

- Decision: 今の Organization `aistcraft` を `pecotcraft` に改名する
- Rationale: ボード `AIST-project` は Organization に属する。改名ならボードがそのまま残り、aist の設定は `owner` を書き換えるだけで済む。リポの設定はリポを owner と name で持ち、node ID を保存していない
- Alternatives considered:
  - 新しい Organization を作り、リポを移す — ボードは移せない。ボードを作り直すとフィールドの ID がすべて変わり、onboarding のやり直しになる
- 改名の影響: 改名すると `aistcraft` は誰でも取れる名前に戻る。リダイレクトは、他者がその名前を取るまで働く

## R3. 公開するリポの作り方

- Decision: 改名した Organization の中で、今の `aist-plugin` を `aist-plugin-private` に改名して残す。新しいリポ `pecotcraft/pecot` を作り、点検と改名を終えた main を孤立したブランチの 1 commit にして push する。各系列の最新の版に、新しい接頭辞のタグを付ける
- Rationale: PR の参照（`refs/pull/N/head`）は削除できず、close した PR の分も残る。公開前の commit を見せない方法は、新しいリポしかない
- Alternatives considered:
  - 今のリポを force push して公開する — PR 17 件の参照から最初の commit を取得できる
  - GitHub のサポートに PR の削除を頼む — 時期を制御できず、Issue の中身は残る
- 付随する作業:
  - `.github/dependabot-exceptions.json` は alert の番号で例外を持つ。番号はリポごとに振られるため、新しいリポでは空にして始める
  - プロジェクトへのリポの登録は、新しいリポで張り直す（a-repo-add に相当）
  - GitHub Releases は新しいリポに無い。最新の版だけを、新しいタグで Releases に作り直す

## R4. npm への publish の方式

- Decision: ビルドは今どおり手元の `nx release` の publish フェーズで行う。
  配布ツリーを `npm pack` で固め、リリースの GitHub Release に添付する。
  その後、GitHub Actions のワークフローを `workflow_dispatch` で起動する。
  ワークフローは添付物を取って、trusted publishing（OIDC）で `npm publish --provenance` する。
  最初の版だけは、手元から 2FA つきで publish してから trusted publisher を設定する
- Rationale:
  - 手元からの publish は、毎回 2FA が要る。2FA を省けるトークンは、2027 年 1 月ごろから直接の publish に使えなくなる予定である
  - trusted publishing ならトークンを持たず、リリース担当者の手作業も増えない（SC-006）
  - 依存の監査の記録と、ブランドの語の一覧（`AIST_BRAND_TERMS_FILE`）は手元にある。ビルドを手元に残せば、CI に秘密を置かずに済む
  - trusted publishing は、npm にパッケージがあることを設定の条件にする。最初の版だけ手元から出すのはこのため
- Alternatives considered:
  - 手元で `npm publish` し、毎回 2FA を入力する — リリースのたびに手作業が増える
  - ビルドから publish まで CI で行う — ブランドの語の一覧と監査の記録を CI に移す必要があり、変更が大きい
  - 2FA を省けるトークンを手元に置く — 2027 年 1 月ごろから直接の publish に使えなくなる
- 冪等性: ワークフローは publish の前に `npm view <pkg>@<ver>` で版の有無を確かめ、あれば何もしない。手元の publish フェーズは、HEAD に該当のタグが無ければ何もしない。この判定は今のまま残す

## R5. 秘密情報のスキャン

- Decision: 1 commit にする前の作業ツリーを、gitleaks v8.30.1 の `gitleaks dir` でスキャンする。公開後は、GitHub の secret scanning が新しいリポの全履歴（1 commit）を見る
- Rationale: 新しいリポの履歴は 1 commit だけなので、作業ツリーを見れば足りる。gitleaks は単体のバイナリで、手元に入れやすい
- Alternatives considered: secretlint（npm）— 規則の数が gitleaks より少ない

## R6. Zscaler Root CA の扱い

- Decision: 証明書の `plugins/aist-visual/assets/certs/` を消す。受け渡しの実装 `cli/src/infra/_shared/extra-ca-certs.ts` とそのテストも消す。README には、利用者が自分の CA を `NODE_EXTRA_CA_CERTS` で渡す手順を書く
- Rationale: 特定の企業のプロキシ向けの同梱物で、公開物に残す理由が無い。Node の標準の環境変数で足りる

## R7. CHANGELOG の整理

- Decision: 4 つの CHANGELOG（3 つのプラグインと `libs/text-rules`）は、1 commit へまとめる前に整理する。先頭の見出し行と 1 文（「pecotcraft/pecot で公開した最初の版。」）だけを残し、過去の項目は消す。未リリースの version plan（`.nx/version-plans/*.md`）は残し、点検の対象にする
- Rationale: 空のファイルは `.githooks/pre-commit/check-release-group-changelog.sh` が止める（存在・非空・末尾改行を要求する）。Nx は新しい節を既存の本文の前に足すだけなので、先頭の見出しと 1 文を残しても、公開後の最初のリリースから節が積まれる

## R8. 公開後の設定

- Decision: 公開した直後に `gh api` で次を有効にする
  - Dependabot alerts（`PUT /repos/{owner}/{repo}/vulnerability-alerts`）
  - Private vulnerability reporting（`PUT /repos/{owner}/{repo}/private-vulnerability-reporting`）
  - secret scanning と push protection（`PATCH /repos/{owner}/{repo}` の `security_and_analysis`）
  - main の ruleset — 削除（`deletion`）と force push（`non_fast_forward`）だけを禁止する
- Rationale: Free プランでも、public のリポならどれも使える。PR を必須にすると、main で直接行うリリース（単一ブランチのモード）が止まる（FR-023）

## R9. 設定のディレクトリと環境変数を移す範囲

- Decision: 利用者が置く・設定するものに加えて、内部の名前もすべて新しい名前にする
  - 設定のディレクトリは `.pecot/`・`.pecotv/`。データの置き場も新しい名前にする
  - 環境変数は `PECOT_*`・`PECOTV_*` にそろえる。内部の受け渡しと開発だけで使うもの（`PECOT_HOOK_*` など）も含む
- Rationale: 初めての公開なので、公開したリポに古い名前を残さない
  - 置換は、大文字小文字の形を保つ部分文字列の置換で決まる
  - テストの件数と行カバレッジを改名の前後で比べて、置換で誤りが入っていないことを確かめられる
- Alternatives considered: 利用者が設定するものだけを変える — ソースのディレクトリや識別子に `aist` が残り、公開したリポを読む人に古い名前が見える
- 所有者の環境の移し方: 各リポの `.aist/` を `git mv` で新しい名前に移す。aist-roadmap は廃止したので、ボードの設定は aist-plugin の `.pecot/config/projects/` に置いて git 管理にする。古い名前を読む互換の仕組みは作らない（憲法 IV、FR-004）

## R10. Epic aistcraft/aist-roadmap#14 との順番

- Decision: #14 の残りのタスク（aistcraft/aist-plugin#28・#30、aistcraft/aist-roadmap#15・#16・#17）を先に終える。#30 は配布リポへの publish を含むが、そのまま行う
- Rationale: #30 は社外で初めてリリースし、開発環境を入れ直すタスクである。リリースの手順が社外で動くことの確認は、本 spec の作業の前提になる。配布リポへの publish は、本 spec で npm に置き換えるまでの手順として残る
