# Implementation Plan: AIST から名前を変えて公開し、MCP の単体配布を npm に移す

**Branch**: `018-public-release-readiness` | **Date**: 2026-11-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/018-public-release-readiness/spec.md`

## Summary

製品名を `aist` から `pecot` に変え、GitHub の Organization を `pecotcraft` にする。
改名と点検を終えた aist-plugin を、1 commit の新しいリポ `pecotcraft/pecot` として公開する。
MCP の単体配布は配布リポをやめ、`@pecot/visual-mcp`・`@pecot/tools-mcp` として npm に出す。
ビルドは手元の `nx release` に残し、npm への publish だけを GitHub Actions の trusted publishing で行う（[research](research.md) の R4）。

## Technical Context

**Language/Version**: aist-plugin の既存の構成のまま

- TypeScript（aist-visual・aist-tools の CLI）
- Python 3.10–3.13（aist-workflow の CLI）
- bash（bin・hooks・リリースのスクリプト）

**Primary Dependencies**: 次の 5 つ

- nx release（version plans）と pnpm
- npm 11.5.1 以上（trusted publishing）
- gh CLI
- gitleaks v8.30.1（公開前のスキャンだけ）

**Storage**: 該当なし

**Testing**: aist-plugin の既存の関門（`.githooks` の pre-commit・pre-push、nx affected のテスト）。名前を変えたテストの通る件数とカバレッジを、改名の前後で比べる

**Target Platform**: Claude Code のプラグイン、npm の public registry、github.com の Organization `pecotcraft`。GitHub Copilot CLI 向けの構成と表記は、Epic aistcraft/aist-roadmap#10 で扱う

**Project Type**: CLI とプラグインの monorepo（aist-plugin）と、その配布

**Performance Goals**: 該当なし

**Constraints**: GitHub は Free プラン。古い名前を読む互換の仕組みを作らない（FR-004）。内部の名前も変える（FR-005）。公開は Epic aistcraft/aist-roadmap#14 の完了後

**Scale/Scope**: aist-plugin の 1,149 ファイルに `aist` が出る。利用者に見える名前の対応は [data-model](data-model.md) の表の 21 種類

## Constitution Check

| 原則 | 判定 | 根拠 |
|---|---|---|
| I. DDD | 合格 | 層の構造を変えない。名前の文字列と配布の手順だけを変える |
| II. TDD | 合格 | 名前を変えたテストを先に直し、通る件数とカバレッジを改名の前後で比べる（SC として tasks に入れる）。npm への publish は、dry-run と初回の publish の結果で確かめる |
| III. 品質の関門 | 合格 | 既存の関門をそのまま通す。`--no-verify` を使わない |
| IV. シンプルさ | 合格 | 古い名前の互換を作らない。CI は publish だけに絞る |
| V. 本体実装優先 | 合格 | aist-roadmap は編集しない。この spec・speckit・devcontainer・tmux の設定を aist-plugin に移し、`.aist/` を `.pecot/` に移す設定の書き換えに限る |

GitHub Actions を初めて入れる。publish だけに使い、テストと関門は手元のまま変えない。理由は R4 にある。

## Project Structure

### Documentation (this feature)

```text
specs/018-public-release-readiness/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── npm-publish.md
│   └── install.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks が作る
```

### Source Code (repository root)

変更先は aist-plugin（公開後は `pecotcraft/pecot`）。ディレクトリ名も新しい名前にする。

```text
.claude-plugin/marketplace.json          # marketplace の名前
.github/workflows/publish-npm.yml        # [新規] npm への publish
.github/dependabot-exceptions.json       # 新しいリポで空にする
nx.json                                  # releaseTagPattern を pecot-* に
README.md / SECURITY.md / CLAUDE.md
plugins/pecot-workflow/
├── .claude-plugin/plugin.json
├── bin/aist → bin/pecot
├── cli/ (pyproject.toml, core/paths.py, core/github/auth.py, core/config.py, commands/project.py)
├── cli-node/src/ (infra/paths.ts, infra/github/auth.ts, domain/config.ts)
├── hooks/ (skill-name.sh ほか、スキル名と .aist の参照)
├── skills/a-* → skills/w-*（name: と本文）
└── agents/a-* → agents/w-*
plugins/pecot-visual/
├── .claude-plugin/plugin.json, .mcp.json
├── bin/aistv → bin/pecotv, bin/_lib.sh
├── assets/certs/                        # 削除
├── cli/src/infra/_shared/extra-ca-certs.ts  # 削除
├── hooks/ (.aistv の参照、aist-v: の判定)
└── scripts/release/ (publish-mcp-dist.sh, finalize-dist.mjs, mcp-dist-README.md)
plugins/pecot-tools/
├── .claude-plugin/plugin.json, .mcp.json
├── bin/aist-tools → bin/pecot-tools, bin/_lib.sh
└── scripts/release/ (publish-mcp-dist.sh, finalize-dist.mjs, mcp-dist-README.md)
```

aist-roadmap は廃止し、次を aist-plugin に移した（FR-006）。

- `specs/018-public-release-readiness/`
- `.specify/`、`.claude/skills/speckit-*`
- `.devcontainer/`(tmux のスクリプトは `.devcontainer/tmux/`)
- ボードの設定 `.pecot/config/projects/*.json`・`.active`（git 管理にする）

設定ファイルの `owner`・`repositories`・`aggregation_repo` は `pecotcraft` にする。Issue は aist-roadmap に残り、公開のときに新しいリポで起票し直す。spec 001〜017 は aist-roadmap に残す。

**Structure Decision**: 実装は aist-plugin の中で進め、公開の直前に新しいリポへ 1 commit で移す。点検と改名が終わるまで、新しいリポは作らない。

## 作業の段階

| 段階 | 内容 | 主な FR |
|---|---|---|
| 0 | #14 の完了を待つ | FR-026 |
| 1 | 名前の取得: Organization を `pecotcraft` に改名し、npm の Organization `pecot` を作る | FR-002 |
| 2 | 改名: data-model の対応表どおりに aist-plugin を書き換える。テストの件数とカバレッジを前後で比べる | FR-003〜005 |
| 3 | 中身の点検: Zscaler の除去、第三者の素材の一覧、点検の語と例外の一覧、gitleaks、CHANGELOG を先頭の見出しと 1 文だけにする、license を揃える | FR-012〜017・019 |
| 4 | 配布: publish の手順を npm に変え、ワークフローを足す。初回の publish と trusted publisher の設定。README を書き換える | FR-007〜011 |
| 5 | 配布リポを削除する | FR-009 |
| 6 | 新しいリポ: aist-plugin を改名して残し、`pecotcraft/pecot` を 1 commit で作る。タグ、Issue の起票し直し（aist-roadmap の Issue を含む）、ボード、ボードの設定、clone し直し | FR-006・018・020 |
| 7 | 公開と公開後の設定、`SECURITY.md`、ワークフローでリリースを 1 回通す | FR-021〜025 |

## Complexity Tracking

該当なし。
