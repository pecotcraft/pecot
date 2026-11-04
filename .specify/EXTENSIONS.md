# Spec Kit Extensions — 再導入・アップグレード手順

このドキュメントは `aist-roadmap` における spec-kit テンプレートと extension の
導入・再アップグレード手順をまとめたもの。

## 現在の状態

<!-- 次回アップグレード時はこの「現在の状態」節のバージョン番号を書き換える -->

- spec-kit template: `1.2.3`（`.specify/init-options.json` の `speckit_version`。
  `.specify/integration.json` と `.specify/integrations/*.manifest.json` の `version` も同じ値）
- 採番方式: `sequential`（`.specify/extensions/git/git-config.yml` の `branch_numbering`。
  v0.10.0 でスキーマが変わり `init-options.json` 側は `feature_numbering: "sequential"`、
  実際の採番制御は git-config.yml が真値）
- 統合先 AI: `claude`（skills 形式。`--integration claude` 単独でよい。追加フラグ不要）
- インストール済み extension（`.specify/extensions/.registry`）:
  - `git` v1.0.1（Enabled）
  - `agent-context` v1.0.2（bundled。**disabled 運用** — CLAUDE.md 自動更新は不要との判断で
    `extension disable` 済み）
- `.specify/feature.json` は **Git 管理外**（v1.0.4 以降が生成する `.specify/.gitignore` で除外。
  現在フィーチャーの pointer は checkout / worktree ごとのローカル状態）

## 実行コマンド（CLI 配布元）

公式 GitHub リポジトリのリリースタグ経由で `uvx` を使う。

```sh
uvx --from "git+https://github.com/github/spec-kit.git@v1.2.3" specify <subcommand>
```

タグ部分（`@v1.2.3`）はアップグレード時に書き換える。最新タグは
<https://github.com/github/spec-kit/releases> で確認する。persistent な `specify` を
`uv tool install` している場合は `specify self check` / `specify self upgrade` が使える（v1.0.x）。

## アップグレード手順

公式 Upgrade Guide（`docs/upgrade.md`、v0.13.4 以降）に従い、**manifest ベースの経路**を使う。
`init --here --force` は manifest チェックを経ずに上書きする escape hatch であり、既定では使わない。

### 1. 事前確認（読み取りのみ）

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify integration status
```

`Modified managed files: 0` / `Missing managed files: 0` であることを確認する。
managed ファイルにローカル編集があると次の `integration upgrade` がブロックされる
（`--force` で上書き可能だが、このリポでは managed ファイルを編集しない前提）。

### 2. integration（skills / scripts / templates）の更新

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" \
  specify integration upgrade claude --script sh
```

- `.claude/skills/speckit-*/SKILL.md`、`.specify/scripts/bash/*`、`.specify/templates/*`、
  `.specify/integrations/*.manifest.json`、`.specify/init-options.json`、`.specify/integration.json`
  が更新される。新コマンドがあれば `.claude/skills/speckit-<name>/` が追加される。
- 「`N shared infrastructure path(s) already exist and were not updated`」という警告が
  出るが、manifest に一致している scripts/templates は upgrade 本体で更新される
  （1.0.4 化の際に確認済み）。実行後に `integration status` が OK で
  `init-options.json` の `speckit_version` が新しい値になっていれば成功。
- 1.2.3 化の時点では、警告に挙がった shared infrastructure のうち一部
  （`.specify/scripts/bash/setup-tasks.sh`）が旧版のまま残り、`--force` を付けても更新されなかった。
  差分はエラーメッセージ中のコマンド名をハードコード（`/speckit-plan`）するか
  `format_speckit_command` で生成するかだけで、claude では出力が同じなので許容している。
  templates の差分は `__SPECKIT_COMMAND_*__` プレースホルダの展開結果で、内容は同等。
- `.specify/memory/constitution.md`、`specs/**`、`CLAUDE.md` はこの経路では触られない。

### 3. extension の更新

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension update
```

bundled の `git` / `agent-context` が新版なら更新される。`.registry` の `enabled` は維持される
（agent-context は disabled のまま）。実行後に `.specify/extensions/.cache/`（catalog キャッシュ）が
生成されるが、ルート `.gitignore` で除外済み。コミット前に削除してよい。

v1.2.x では更新前に `Update these extensions? [y/N]` の確認が出る（非対話実行では `Aborted.`）。
非対話で実行する場合は `echo y | uvx ... specify extension update` とする。

### 3b. extension update 後の skills 再描画（v1.2.x で必要）

1.2.3 化の際、`extension update` 後に `.registry` の git の `registered_skills` が空になり、
`.claude/skills/speckit-git-*/SKILL.md` の frontmatter から `user-invocable` /
`disable-model-invocation` が消えた。続けて次を実行すると、skills 登録と frontmatter が
従来（1.0.4 時）と同じ形に戻る:

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" \
  specify integration upgrade claude --script sh --force
```

事前確認（手順 1）で Modified 0 を確認済みなら `--force` で失われるローカル編集はない。
`.specify/extensions/.backup/`（空ディレクトリ）が残った場合は削除する。

### 4. extension の追加・削除（必要時のみ）

`extension add` / `extension remove` は extension を **後から個別に
ON / OFF したい** 場合のみ使う:

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension add <name>
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension remove <name>
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension list
```

すでに登録済の extension に対して `extension add` を実行すると
`Error: Extension '<name>' is already installed.` が出る（無害）。

### 5. fallback: `init --here --force`

manifest が壊れている・integration メタデータが欠けている等、`integration upgrade` が
使えない場合だけ使う:

```sh
uvx --from "git+https://github.com/github/spec-kit.git@<tag>" \
  specify init --here --force --integration claude --script sh
```

legacy の `--ai claude` / `--ai-skills` フラグは v0.10.0 で削除済み（指定するとエラー）。
既存の `.registry` に登録済みの extension は installed 検出でスキップ・温存される。

### 6. 動作確認

- `integration status` が OK（Modified / Missing 0）
- `extension list` で `git`（Enabled）と `agent-context`（Disabled）が出る
- `.specify/extensions.yml` に `before_specify` で `speckit.git.feature` が登録されている
- `.specify/extensions.yml` の `after_specify`/`after_plan` に `speckit.git.commit`（git）と
  `speckit.agent-context.update`（agent-context、`enabled: false`）が併存している
- `.specify/scripts/bash/*.sh` と `.specify/extensions/git/scripts/bash/*.sh` に実行権限が付いている
- `.claude/skills/speckit-git-feature/SKILL.md` 等（git 系 5 個）が存在する
- `.claude/skills/speckit-agent-context-update/SKILL.md` が存在する
- `.specify/extensions/git/git-config.yml` の `branch_numbering: sequential` が維持されている
- `.specify/extensions/agent-context/agent-context-config.yml` の `context_file: CLAUDE.md`
- `bash .specify/scripts/bash/check-prerequisites.sh --json --paths-only` が現在フィーチャーを解決する

## 登録済みフック

`.specify/extensions.yml` で有効化されているのは以下:

- `before_specify` → `speckit.git.feature` (`enabled: true`, `optional: false`)
  - `/speckit-specify` 実行前に `<NNN>-<short-name>` ブランチを自動作成・切替
- `before_constitution` → `speckit.git.initialize`（`optional: false`）
- `before_*` / `after_*` の各ステップ → `speckit.git.commit`（`optional: true`、自動コミット）
- `after_specify` / `after_plan` → `speckit.agent-context.update`
  （agent-context extension、`optional: true`、**`enabled: false`** — disabled 運用）
  - 有効化すると `/speckit-specify` / `/speckit-plan` 後に `CLAUDE.md` の
    `<!-- SPECKIT START/END -->` ブロックを最新 feature の plan 参照へ更新する

`after_specify`/`after_plan` は git.commit（optional）と agent-context.update
（disabled）の 2 hook 連鎖になっている点に注意。

`optional: true` のフックは実行時にプロンプトで明示的に同意した場合だけ走る。
`optional: false` のフックは原則自動実行（aist-roadmap の運用方針はここに依存）。
v1.0.x の SKILL.md は「`EXECUTE_COMMAND:` ブロックを出すだけでなく実際にフックを起動して
完了を待つ」旨が明記されている。

## agent-context extension（v0.9.0 で切り出し / v0.12.0 で完全 opt-in / **disabled 運用**）

`CLAUDE.md` の `<!-- SPECKIT START -->` 〜 `<!-- SPECKIT END -->` ブロック管理は、
v0.9.0 で integration 本体から bundled の `agent-context` extension に切り出され、
**v0.12.0 で完全 opt-in 化**された（integration 本体に残っていた compat 経路は削除済み。
`/speckit-plan` の手順からも「agent context 更新」ステップが消えている）。

**aist-roadmap では CLAUDE.md の自動更新は不要との判断で、導入直後に
`specify extension disable agent-context` を実行し disabled 運用としている**
（hooks の `enabled: false` と `.registry` の `enabled: false` がその痕跡）。
extension 自体は installed のままなので `extension update` で更新は追随する。

- **再有効化**: `uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension enable agent-context`
- **再有効化時の注意**: bash フックスクリプトは **PyYAML 必須**で、import できない環境では
  CLAUDE.md を更新せず silent skip する（exit 0）。この devcontainer には PyYAML が
  入っていないため、再有効化する場合は devcontainer への `pyyaml` 追加もセットで行うこと
  （v0.12.8 以降は Python 版 `scripts/python/update_agent_context.py` も同梱）

- **役割**: `/speckit-specify` / `/speckit-plan` 後（`after_specify`/`after_plan` フック）に
  `CLAUDE.md` の SPECKIT ブロックへ最新 feature の plan 参照などを書き込む
- **config 場所**: `.specify/extensions/agent-context/agent-context-config.yml`
  - `context_file: CLAUDE.md`（書き込み対象）
  - `context_markers`: `<!-- SPECKIT START -->` / `<!-- SPECKIT END -->`
- **スクリプト**: `.specify/extensions/agent-context/scripts/bash/update-agent-context.sh`
  （実行権限あり）。`/speckit-agent-context-update` スキル
  （`.claude/skills/speckit-agent-context-update/`）経由で起動される

## spec-kit 生成ファイルは編集しない

`.specify/extensions.yml`、`.specify/extensions/**`、`.specify/scripts/**`、`.specify/templates/**`、
`.claude/skills/speckit-*/SKILL.md` は `integration upgrade` / `extension update` で上書きされる。
直接編集すると manifest 不一致で次回 `integration upgrade` がブロックされる（`--force` で
上書き＝編集が失われる）ので、**手を入れない**。

upstream の出力に違和感があっても（例: git 系 SKILL.md に `user-invocable` が無い）、
`.registry` が真値・git skills はフック経由でしか呼ばれない設計など、upstream の意図に
沿っていることが多い。挙動に問題があれば upstream に issue を立てるのが正攻法。

このリポで上書き禁止対象に手を入れる必要が出たら、対応を本ドキュメントに残し、
アップグレード後に再適用する手順をここに書く。

## 未登録フックの追加方法

新しい hook を有効化するには `.specify/extensions.yml` の該当 hook 配列に
extension コマンドを足す:

```yaml
hooks:
  before_plan:
    - extension: git
      command: speckit.git.commit
      enabled: true
      optional: true
      prompt: Commit outstanding changes before planning?
      description: Auto-commit before implementation planning
      condition: null
```

利用可能な extension コマンド一覧は
`uvx --from "git+https://github.com/github/spec-kit.git@<tag>" specify extension list`
で確認する。

## 再アップグレード時の注意（保護対象差分チェック）

アップグレード後は `git status` で意図しない差分が出ていないか必ず確認する。
更新されるのは以下:

- `.specify/scripts/bash/*`、`.specify/templates/*`、`.specify/integrations/**`、
  `.specify/init-options.json`、`.specify/integration.json`、`.specify/extensions/.registry`
- `.claude/skills/speckit-*/SKILL.md`（新コマンド分のディレクトリ追加を含む）

以下は触られないはず。差分が出たら個別に `git restore <path>` で復元する:

- `specs/**`（各 feature ディレクトリ）
- `.specify/memory/**`（プロジェクト固有。constitution.md は `integration upgrade` では
  上書きされない＝差分が出たら想定外として内容確認のうえ復元する）
- `.specify/extensions/git/git-config.yml`
- `CLAUDE.md`（agent-context が disabled なので更新されない）

`.specify/extensions.yml` は `extension update` が書き直す。1.2.3 化では `installed` への `git` 追加、
各フックへの `priority: 10` 付与、`after_specify` / `after_plan` の位置移動という正規化だけだった。
各フックの `enabled` / `optional` が変わっていないことを確認し、変わっていれば復元する。
- `README.md`（導入バージョン表記は手動で更新する）

`.specify/feature.json` は Git 管理外なので差分には出ない。worktree を新規作成した直後は
存在しないが、`/speckit-specify` 実行時に自動生成される。既存フィーチャーで作業したい場合は
`SPECIFY_FEATURE_DIRECTORY=specs/<NNN-name>` を指定するか、フィーチャーブランチ名
（`<NNN>-<name>`）から解決させる。

採番方式の確認先は v0.10.0 で移動した。`.specify/extensions/git/git-config.yml` の
`branch_numbering: sequential` が消えていたら手動で復元する
（`.specify/init-options.json` 側は `feature_numbering: "sequential"` に変わっており、
こちらは表示用。実際の採番は git-config.yml が制御する）。

### orphan ファイルの撤去

`integration upgrade` は manifest 管理下の stale ファイルを削除するが、過去の版で
manifest 外に配置されたファイルは残る。再生成された場合は撤去する:

- `.specify/scripts/bash/update-agent-context.sh`（v0.8.x の同梱物。agent-context extension
  配下へ移設済み。0.10.1 化の際に撤去）
- `.specify/templates/agent-file-template.md`（v1.0.x の core テンプレには存在しない。
  agent-context extension 側に実体がある。1.0.4 化の際に撤去）
- `.specify/extensions/.cache/`（catalog キャッシュ。`.gitignore` 済みだが削除してよい）
- `.specify/extensions/.backup/`（`extension update` が作る退避先。空なら削除してよい）

## 採用していない上流機能（1.1〜1.2 系）

- core `/speckit-taskstoissues` は v1.1.0 で非推奨になり、bundled の `github` extension
  （`/speckit-github-taskstoissues`）へ移行予定。pecot では Issue 化に `pecot-w:w-issueize` を使うため
  `github` extension は導入しない。core 版が将来のマイナー版で削除されたら、そのまま消えてよい
- claude integration の `--no-model-invocation`（v1.2.0）は使わない。speckit スキルの
  モデル起動可否は従来どおり（`disable-model-invocation: false`）
- git extension の `branch_template` / `branch_prefix`（`git-config.yml` の任意キー）は未設定。
  既定の `{number}-{slug}` 形式で採番する
