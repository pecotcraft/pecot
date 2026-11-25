# Contract: pecot-workflow の MCP ツールの変更

入力・出力は、各コマンドの zod の定義から `inputSchema`・`outputSchema` を作る今の形に従う。定義書（`plugins/pecot-workflow/interface/authored.yaml`）の振る舞いの ID は、実装のフェーズで足す。

## A. pecot のフィールド

### `project_create`・`project_init`

| 入力 | 変更 | 内容 |
|---|---|---|
| `suffix` | 削除 | 渡されたら、無い入力として止める（`additionalProperties: false`） |
| `lanes` | 追加 | 文字列の配列。省略できる。渡すと `pecot-lane` を作り、レーンのビューを作る |

| 出力 | 変更 | 内容 |
|---|---|---|
| `fields` | 変更 | 作った・あったフィールド。`pecot-status`・`pecot-lane` |
| `view` | 追加 | `{ created: boolean, name, url? , manual_steps? }`。作れなかったときは `manual_steps` |

### `project_init`（既存のボードを整える）

既存のボードの改名と設定の移行は、`project_init` が行う。新しいツール `project_sync` は作らない。

| 入力 | 変更 | 内容 |
|---|---|---|
| `lanes` | 追加 | 足す `pecot-lane` の値。既存の値は消さない |
| `confirm_delete` | 追加 | 真偽値。true のときだけ、`pecot-priority`・`pecot-size`・旧い `pecot-workflow-<suffix>` を消す |

| 出力 | 変更 | 内容 |
|---|---|---|
| `migration` | 追加 | `renamed`（改名した旧い名前か null）・`config_moved`（`from`・`to` か null）・`pending_delete`（消す予定の名前）・`deleted`（消した名前） |

Phase 1 の `migration` は `renamed`・`config_moved` だけを持つ。`pending_delete`・`deleted` は Phase 2 で足す。

### `project_activate`

| 出力 | 変更 | 内容 |
|---|---|---|
| `config_moved` | 追加 | 旧い名前の設定ファイルを新しい名前に移したときの `from`・`to`。移していなければ null |

### `issue_create`

| 入力 | 変更 | 内容 |
|---|---|---|
| `priority`・`size` | 削除 | 渡されたら、無い入力として止める |
| `lane` | 追加 | `pecot-lane` の値。省略できる。そのときボードから読んだ選択肢と照らす。`parent_epic` があり省略したら、親の値。`attributes` にも `pecot-lane` を入れると、どちらを使うか決まらないので、Issue を作らずに止める（`ambiguous_attribute`） |
| `attributes` | 追加 | B を参照 |

frontmatter: `priority`・`size` は読み捨てる。`lane` と `attributes` を受ける。

### `board_show`

| 出力 | 変更 | 内容 |
|---|---|---|
| `board.items[].lane` | 追加 | string か null |
| `lanes` | 追加 | LaneSummary の配列（data-model.md）。`pecot-lane` が無いボードでは空 |

### `board_sync`

| 出力 | 変更 | 内容 |
|---|---|---|
| `missing_lane` | 追加 | `pecot-lane` の無い開いた Issue の参照の配列。`pecot-lane` が無いボードでは空 |

`missing_lane` が空でなければ、警告を 1 行出す。終了コードは変えない。

### 旧い形のボードと設定での各操作

`board_show`・`board_sync` は、進行の欄が旧い名前でも今と同じに動き、警告を 1 行出す。ほかの操作は警告を出さない。

```text
warning: this board uses the old field name pecot-workflow-pecotcraft
  run: pecot project init <owner> <name> --host <host>
```

`<owner>`・`<host>` は設定の値で、`<name>` だけを利用者が埋める。MCP では、2 行目が `project_init` の呼び出しの形になる。

Phase 2 で、残った `pecot-priority`・`pecot-size` の名前を同じ警告に足す。2 行目には `confirm_delete` を付けない。承認の流れは `project_init` の `warnings` が案内する（FR-010）。

## B. Issue の機能

### `issue_attributes`（新規）

| 入力 | 内容 |
|---|---|
| `repo` | `owner/repo`。省略すると今のリポ |

| 出力 | 内容 |
|---|---|
| `attributes` | AttributeDefinition の配列（data-model.md）。`pecot-status` と組み込みの Status は `writable: false` で、列は `board_move` で動かす |
| `unsupported` | `kind` が `unsupported` のものの名前と GitHub の種類 |

### `issue_create` の `attributes`

AttributeValue の配列。検証に 1 つでも通らなければ、Issue を作らずに止め、出力の `errors` に次の形で並べる。

```json
{ "code": "invalid_value", "name": "Estimate", "source": "project", "value": "big", "expected": "number" }
```

項目は `code`・`name` のほかに、あるものだけを入れる。`source`・`value`・`expected`（取りうる値）・`candidates`（似た名前）・`sources`（同じ名前を持つ `source`）・`hint`（代わりに使う操作や、読めなかった理由）。

ファイルから起票するときは、値を書いたファイルの名前を `file` に入れる。検証で止めたときの失敗の `kind` は `invalid-input`。

CLI では、`--attribute` に要素 1 つの JSON（`{"name":"Estimate","value":3}`）を繰り返して渡す。

ファイルから起票するときは、frontmatter の `attributes` に同じ形の配列を書く。入力の `attributes` と `files` は一緒に渡せない。
入力の `label` か frontmatter の `labels` と、`attributes` の `labels` を両方渡すと、`ambiguous_attribute` で止める。`issue_check` も、frontmatter の `attributes` を同じく照らし、合わない値を error の行に出す（何も書かない）。

### `issue_edit`（新規）

| 入力 | 内容 |
|---|---|
| `issue_ref` | `owner/repo/N` |
| `attributes` | AttributeValue の配列。`value: null` で外す。今の値と同じ値は書かない |
| `project` | 設定の名前。省略すると、対象のリポを含む設定 |

| 出力 | 内容 |
|---|---|
| `changed` | 変えた機能の名前と、前の値・後の値 |
| `errors` | 検証で止めたときの一覧。止めたときは何も書かない |
| `failed` | 検証は通ったが書けなかった機能と理由（Issue fields の権限の不足など）。ほかの機能は書く（FR-020）。`issue_create` の出力にも、作った Issue の `issue` を添えて同じ項目を足す |

`failed` が 1 つでもあれば、`issue_edit` は失敗の `kind` を `partial-failure` にする。`issue_create` は、Issue を作れていれば警告の行に出し、成功で終える。

CLI の `pecot issue edit` は `--dry-run` を持つ。値を照らし、変わる機能を出すだけで、何も書かない。MCP には出さない（ほかの書き込みのコマンドと同じ）。

### `issue_show`

| 出力 | 変更 | 内容 |
|---|---|---|
| `attributes` | 追加 | AttributeReading の配列。値の入っている機能をすべて |
| `unsupported` | 追加 | 値は入っているが pecot が扱えない種類の機能の、名前と GitHub の種類（FR-022） |

## 担保の確かめ

| 確かめ | どこで | 落ちる条件 |
|---|---|---|
| 一覧の網羅 | PR の CI（`pecot-workflow:test-cli` の vitest） | 写しの項目が担保の一覧に無い。`supported` の `handler` が `ATTRIBUTE_HANDLERS` に無い |
| GitHub との差 | `issue-surface-drift.yml`（Lambda の Scheduler から dispatch） | 今の SDL・OpenAPI から抜いた項目が写しと違う。落ちる代わりに Issue を 1 件作る |
