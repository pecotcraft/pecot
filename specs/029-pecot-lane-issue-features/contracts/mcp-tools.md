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

`<owner>`・`<host>` は設定の値で、`<name>` だけを利用者が埋める。MCP では、2 行目が `project_init` の呼び出しの形になる。Phase 2 で、`pecot-priority`・`pecot-size` と `--confirm-delete` を、この文に足す。

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

### `issue_edit`（新規）

| 入力 | 内容 |
|---|---|
| `issue_ref` | `owner/repo/N` |
| `attributes` | AttributeValue の配列。`value: null` で外す |

| 出力 | 内容 |
|---|---|
| `changed` | 変えた機能の名前と、前の値・後の値 |
| `errors` | 検証で止めたときの一覧。止めたときは何も書かない |
| `failed` | 検証は通ったが書けなかった機能と理由（Issue fields の権限の不足など）。ほかの機能は書く（FR-020）。`issue_create` の出力にも同じ項目を足す |

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
