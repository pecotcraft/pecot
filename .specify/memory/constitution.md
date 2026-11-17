<!--
  =========================================================================
  Sync Impact Report
  =========================================================================
  Version change: 3.2.1 → 4.0.0
  Restructure: Spec Kit の spec-driven.md の「The Nine Articles of Development」の
    訳を骨組みにし、IV〜VI の枠に pecot の原則を置いた
  Principle mapping (3.2.1 → 4.0.0):
    - I. ドメイン駆動設計 → VI. 層の分離（縮めて移した）
    - II. テスト駆動開発 → III. テストファースト・IX. 統合を先にするテスト（分けて移した）
    - III. コード品質ゲート → V. 品質の自動チェック（縮めて移した）
    - IV. シンプルさと YAGNI → 削除（VII・VIII に置き換えた。依頼の範囲を超えた改善の禁止は持ち込まない）
    - V. 本体実装優先 → 削除
    - VI. 標準準拠と不適合の是正 → IV（中身は変えず、文体だけ直した）
  Added principles: I. ライブラリ優先、II. CLI インタフェース、VII. シンプルさ、
    VIII. 抽象化しない、IX. 統合を先にするテスト
  Removed principles: 旧 IV（シンプルさと YAGNI）、旧 V（本体実装優先）
  Templates requiring updates:
    - .specify/templates/plan-template.md ✅ 更新不要（Constitution Check は原則を汎用で参照し、
      Complexity Tracking の表がガバナンスの「条を外れるとき」の置き場になる）
    - .specify/templates/spec-template.md ✅ 更新不要
    - .specify/templates/tasks-template.md ✅ 更新不要
    - .specify/templates/checklist-template.md ✅ 更新不要
    - CLAUDE.md ✅ 標準準拠の原則の番号を VI から IV に直した
  Follow-up TODOs:
    - 計画の雛形（pecot-workflow の plan テンプレ）に、標準との対照を書く必須の見出しを足す。
      CLI と lint には、不適合を止める仕組みがまだ無い
  =========================================================================
-->

# pecot 憲法

この憲法は、仕様をコードにするときに従う原則を定める。
I〜III と VII〜IX は、Spec Kit の `spec-driven.md` にある「The Nine Articles of Development」の訳である。
IV〜VI は、Spec Kit がプロジェクトに任せている枠で、pecot の原則を置く。
各条の「このリポジトリでは」は、原則を pecot に当てはめるときの読み替えと補足である。

## 基本原則

### I. ライブラリ優先

すべての機能は、独立したライブラリとして作り始めなければならない（MUST）。
アプリケーションのコードに機能を直接書いてはならない。まず再利用できるライブラリの部品として切り出す。

- ライブラリは自己完結し、単独でテストでき、文書を持たなければならない（MUST）
- ライブラリには明確な目的が必要である。整理のためだけのライブラリは作らない

**このリポジトリでは**: ライブラリの単位は nx project（`libs/<name>`・`plugins/<name>`）とする。
プラグインの機能は `cli/src/` のモジュールに置き、スキル・hook・MCP ツールの入口には処理を書かない。
pecot-workflow の hook の入口は、`check-entry-point-logic` が振り分けだけであることを確かめる。

### II. CLI インタフェース

すべてのライブラリは、機能をコマンドラインのインタフェースで公開しなければならない（MUST）。

- 入力はテキストで受け取る（標準入力・引数・ファイル）
- 出力はテキストで標準出力に出す
- 構造のあるデータのやり取りには JSON を使えるようにする

**このリポジトリでは**: プラグインの CLI（`cli/src/cli.ts`）と MCP サーバ（`cli/src/mcp/`）は、
同じ処理（`commands/`・`domain/`）を呼ぶ。MCP ツールの構造化した結果は、定義書の `outputSchema` と一致させる。

### III. テストファースト（交渉不可）

すべての実装は、厳密なテスト駆動開発に従わなければならない（MUST）。
次の 3 つが済むまで、実装のコードを書いてはならない。

1. 単体テストを書く
2. テストを利用者が確かめて承認する
3. テストが失敗すること（Red）を確かめる

**このリポジトリでは**:

- 利用者の承認は、テストの方針を書いた計画の承認で兼ねる
- カバレッジの閾値を下回ると、テストを失敗させる（MUST）。値の正は各 `vitest.config.ts` の `thresholds` と、
  `plugins/pecot-visual/assets/slidev/.c8rc.json` とする。Python のテストには閾値を置いていない
- 公開面（コマンド・MCP ツール・hook）の振る舞いは、各プラグインの `interface/` の定義書に項目として書く（MUST）。
  項目を確かめるテストは、`verifies` で項目の ID を書く（MUST）
- `interface-spec:lint-defs` は、テストに ID が出てこない項目・定義書に無い ID・空の欄を止める
- テストの題は `.claude/rules/test-conventions.md` に従う（MUST）

### IV. 標準準拠と不適合の是正（交渉不可）

仕組みに標準や公式の仕様があるなら、その形に従わなければならない（MUST）。
対象は、プロトコル（MCP など）、プラグインの仕様（Agent Plugins など）、
プラットフォームの決まり（GitHub Actions など）である。

- **仕様を読んでから決める**: 設計の前に、仕様の文と公式の参照実装を読まなければならない（MUST）。
  記憶をもとに決めてはならない（MUST NOT）
- **独自の項目を作らない**: 仕様に置き場所があるものに、同じ役割の独自の項目を作ってはならない（MUST NOT）
- **不適合の扱い**: 標準とのずれは不適合として扱う。見つけたら、その場で利用者に伝え、
  Issue に記録し、是正しなければならない（MUST）
- **残す理由にならないもの**: 修正の手間と、既存の実装との一貫性は、不適合を残す理由にならない
- **特別採用**: 不適合を残せるのは、利用者が明示して承認したときだけである。
  計画には、残す項目と理由を 1 つずつ書かなければならない（MUST）
- **テストは根拠にならない**: テストの通過を、標準に合っていることの根拠にしてはならない（MUST NOT）。
  テストが確かめるのは、実装が自分の定義と一致することである

守っているかは、次の方法で確かめる。

- 計画のレビュー（w-reviewer）が、仕様と項目ごとに照らし合わせ、不適合を挙げる
- 承認者が、計画に書かれた特別採用を読んで決める
- 機械で照合できる標準は、テストで止める（`outputSchema` と定義書の一致など）
- CLI と lint には、不適合を止める仕組みがまだ無い

**根拠**: 利用者とほかのクライアントは、標準の形を前提に動く。
独自の形は pecot を知らない相手に通じず、修正の費用は後になるほど増える。
#433 の計画は、MCP の標準との差を知りながら、承認を得ずに独自の入れ物を残した。

### V. 品質の自動チェック

コードの品質は、自動のチェックで守らなければならない（MUST）。
チェックの無いプロジェクトでは、機能の開発より先にチェックを整える。

- **型**: 本番のコードは、TS は tsc の `strict`、Python は pyright の `strict` を通らなければならない（MUST）。
  export する関数・メソッドの引数と戻り値には型を書く。lint の `explicit-module-boundary-types` が止める
- **未使用のコード**: 未使用の export・依存・ファイルは、プラグインの TS の CLI で knip が止める。
  未使用のコードは、コメントアウトや名前の変更で残さず、削除する（MUST）
- **バイパスしない**: 通常の作業で `--no-verify` を使ってはならない（MUST NOT）。
  ツールが内部で付けるもの（`nx release` の push）は除き、その場合も push する中身は PR の検証を通っていなければならない

チェックの置き場は次のとおり。hook の一覧の正は `.pre-commit-config.yaml`、置き場ごとの内訳と理由の正は `.githooks/README.md` とする。

| 置き場 | 役割 |
|---|---|
| pre-commit（CI でも動く） | 変更のある nx project の lint（`nx-affected-lint`）、文面・Markdown・YAML・ワークフロー・Python の形、リポの配置と運用の決まり |
| commit-msg | Conventional Commits の形、文面の規則、`main` への直接の commit |
| pre-push | push の範囲の文面、nx の入力の宣言の不足、version plan の欠け（いずれも CI でも動く） |
| CI の必須チェック | `ci-result`（affected なテストのレーンと、pre-commit・pre-push の hook の結果）、`version-plan` |

### VI. 層の分離

コードは、プレゼンテーション層（CLI・MCP）、ドメイン層（業務の処理）、インフラ層（外部の I/O）に分けなければならない（MUST）。
依存の向きは、プレゼンテーション → ドメイン ← インフラとする。モジュールの間で循環して import してはならない（MUST NOT）。

**このリポジトリでは**:

- lint が止めるもの
  - TS の CLI（pecot-tools・pecot-visual・pecot-workflow の `cli/` と `libs/interface-spec`）は、
    各 `eslint.config.js` の `import-x/no-restricted-paths` が層の向きを止める
  - pecot-workflow の `cli/` は、`src/domain/` からの I/O の import（`node:fs`・`node:child_process` など）と、
    グローバルの `fetch`・`process` を止める
- PR レビューで確かめるもの（SHOULD）
  - 循環 import（`no-cycle` はどのプロジェクトにも無い）
  - pecot-tools・pecot-visual の `cli/` と `libs/interface-spec` の、domain からの I/O

### VII. シンプルさ

構成は最小限から始める。

- 1 つの機能の最初の実装で使うプロジェクトは、3 つまでとする
- それより多いプロジェクトには、理由を記録しなければならない（MUST）
- 将来への備えをしない

**このリポジトリでは**: プロジェクトは nx project と読み替える。1 つの機能で新しく作る nx project を数える。

### VIII. 抽象化しない

フレームワークの機能は、包む層を作らずに直接使う。

- フレームワークを直接使っているか
- 同じものを表すモデルは 1 つか

### IX. 統合を先にするテスト

テストは、実際に近い環境で動かさなければならない（MUST）。

- モックより実物のデータベースを使う
- スタブより実際のサービスのインスタンスを使う
- 実装の前に、契約テストを書く（MUST）

**このリポジトリでは**:

- モックは I/O の境界（HTTP・ファイルシステム・外部プロセス）に限る（MUST）。
  業務の処理・データの変換・パースは、実際の入力と出力でテストする
- アサーションは具体的な期待値と比べる（MUST）。次の書き方を主なアサーションにしない
  - vitest: `toBeDefined()`・`toBeTruthy()`・`toBeInstanceOf()`・`length` が 0 より大きいことだけの確認
  - pytest: `assert result is not None`・`assert isinstance(...)`・`assert len(...) > 0`
- テストの入力は、実際の使い方を反映させる。ハッピーパスだけを通る作為的な例にしない
- 単体テストの通過は、正しさの十分な証拠にならない。変更は、計画の CUJ で実際のスキル・MCP ツール・
  コマンドを動かして確かめる（MUST）。外へ書き込む CUJ は、検証用のリポ `pecotcraft/pecot-sandbox` に流す

## ガバナンス

この憲法は、プロジェクトの原則の正であり、その場限りの慣習より優先する。
Spec Kit の成果物（仕様・計画・タスク・チェックリスト）は、この憲法と整合しなければならない（MUST）。

- **適用範囲**: このリポジトリ（`pecotcraft/pecot`）の Spec Kit の成果物（`specs/`・`.specify/`）と実装に適用する
- **計画での確認**: `speckit-plan` スキルの Constitution Check で、計画を各条と照らし合わせる（MUST）。
  条を外れる計画は、Complexity Tracking の表に、外れる条・必要な理由・採らなかった簡単な案を書けば進められる。
  IV（標準準拠）の不適合は、この表ではなく IV の特別採用の手順に従う
- **改正**: 憲法の変更は PR で提案し、次をそろえてレビューと承認を経なければならない（MUST）
  - 変更の理由の記録
  - プロジェクトの保守者による確認と承認
  - 後方互換性への影響の評価
- **版**: セマンティック バージョニング（MAJOR.MINOR.PATCH）に従う。
  MAJOR は原則の削除・再定義、MINOR は追加・拡張、PATCH は明確化・誤字の修正とする

**Version**: 4.0.0 | **Ratified**: 2026-02-21 | **Last Amended**: 2026-11-17
