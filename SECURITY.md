# セキュリティポリシー

pecot（pecot-w / pecot-v / pecot-t）の脆弱性を見つけたときの報告先と、報告後の扱いを示します。

## 報告の方法

GitHub の非公開の脆弱性報告で受け付けます。[Report a vulnerability](https://github.com/pecotcraft/pecot/security/advisories/new)（リポジトリの Security タブ）から送ってください。本文に次を書いてください。

- 影響するプラグインとバージョン（`claude plugin list` / `copilot plugin list` で分かる）
- 再現手順と、何が起きるか（例: 許可リスト外のコマンドが実行できる、認証情報がログに出る）

公開 Issue は誰でも読めるので、脆弱性は Issue に書かないでください。
また、トークン・パスワード・鍵などの認証情報は、漏えいの報告であっても値そのものを本文に書かないでください。
どこにあるか（ファイルパス・コミット・ログの場所）だけを書いてください。

## 対象

- 3 プラグインのコード（スキル・hooks・CLI・MCP サーバ）
- npm のパッケージ `@pecot/visual-mcp` / `@pecot/tools-mcp` の配布物
- 依存ライブラリの脆弱性は、このプラグインの使い方で悪用できる場合に、advisory の URL を添えて報告する
- Claude Code / GitHub Copilot CLI 本体や、awscli などの外部ツール本体の脆弱性は対象外。それぞれの提供元に報告する

## サポート対象のバージョン

各プラグインの最新リリースだけが修正の対象です。修正は main に入り、次のリリースで配布されます。
更新の手順は [README の「更新」](README.md#更新) を参照してください。
最新リリースは [Releases](https://github.com/pecotcraft/pecot/releases) で確認できます。
タグは pecot-w が `pecot-workflow-v*`、pecot-v が `pecot-visual-v*`、pecot-t が `pecot-tools-v*` です。

## alert の Issue から始める手順（メンテナ向け）

main の alert は、Actions の `security-alerts` が毎時、Tracker 1 件の一覧にそろえます。対象は Dependabot・code scanning・secret scanning です。
Tracker は、ラベル `security-alert` の Issue で、題は `[Tracker] security alert — <立てた日>` です。Status は Backlog です。
open の Tracker が無く、判断の要る alert があるときだけ、新しい Tracker が立ちます。

Tracker の本文には、Tracker の印と、alert の一覧の表だけがあります。表に載るのは、open で `.github/dependabot-exceptions.json` に載っていない、判断の要る alert だけです。
表の列は、種類・alert（Security タブへのリンク）・Priority・パッケージ（Dependabot のみ）です。
alert が直った・閉じられた・例外になったときは、次の実行で行が表から消えます。

直す作業は、`/pecot-w:w-ready` で Tracker の下にサブタスクとして切ります。一覧の行から 1 件を選びます。
決めた結果は、alert の側（修正・dismiss・例外）に反映します。次の実行で、その行が表から消えます。

Tracker は sync が閉じません。閉じる操作と、ボードの Archived へ移す操作は、人が行います。
sync は、表の印のある行だけを読み、本文の表の部分を丸ごと置き換えます。人が表に足した行は、次の実行で消えます。
表の外の文は残るので、メモは表の外に書きます。本文が前と同じなら、書き込みません。

Tracker の題と本文には、種類・番号・Priority・Security タブの alert の URL だけを書きます。
Dependabot は公開の advisory なので、パッケージ名と GHSA の ID も書きます。
code scanning の rule・パス・行や、secret の種類・場所は、公開の Issue に書きません。alert の中身は Security タブで読みます。
Tracker のコメントやサブタスクにも、alert の中身を書かないでください。

種類ごとの手順は、次の節にあります。

| 種類 | 手順の節 |
|---|---|
| Dependabot | [Dependabot の alert](#alert-dependabot) |
| code scanning | [code scanning の alert](#alert-code-scanning) |
| secret scanning | [secret scanning の alert](#alert-secret-scanning) |
| 例外の見直し | [例外の見直し](#alert-exceptions-review) |

### 費用の前提

このリポは公開なので、次のものは無料で使えます。

- GitHub が用意するランナーでの Actions の実行（`security-alerts` の毎時の job を含む）
- Dependabot・code scanning・secret scanning
- GitHub App

リポを非公開にすると、次の費用が出ます。

- Actions の実行時間が、組織の無料枠を消費する。実行ごとに分単位で切り上げるので、毎時の job だけで月 720 分以上になる
- code scanning と secret scanning に、有料の GitHub Advanced Security が要る

非公開へ切り替える前は、`security-alerts.yml` の schedule の間隔と、alert の機能を続けるかを決めます。

<a id="alert-dependabot"></a>

### Dependabot の alert

Tracker の表の alert の URL を開き、パッケージと、修正版の有無を確かめます。次の順で決めます。

1. lock の更新で修正版に上がる。直す。依存を更新する PR を出す。マージすると alert が fixed になり、次の実行で行が表から消える
2. 親の依存が修正版を許さず、上げられない。`.github/dependabot-exceptions.json` に例外を載せる。項目は次のとおりで、どれも空にできない
   - `alert`: alert 番号
   - `package`: パッケージ名
   - `reason`: 上げられない理由
   - `reevaluate`: 例外を外す条件（例: 親が修正版を許したら外す）
   - alert は open のままで、`pecot release preflight` だけが例外として通す。次の実行で、行は表から消える。見直しは下の「例外の見直し」で行う
3. canary など、配布物に入らない依存である。Security タブで `not_used` として dismiss する。コメントに理由を書く

```
gh api -X PATCH repos/pecotcraft/pecot/dependabot/alerts/<番号> \
  -f state=dismissed -f dismissed_reason=not_used -f dismissed_comment='<理由>'
```

<a id="alert-code-scanning"></a>

### code scanning の alert

実害のある alert と、直すほうが安い alert は、dismiss せずに直します。
直さない alert は、次の「誤検知の alert を閉じる」の手順で決めます。
閉じてよいのは admin が認めたものだけで、エージェントは一覧と理由を示して承認を待ちます。
閉じた alert は、次の実行で Tracker の行が表から消えます。

<a id="alert-secret-scanning"></a>

### secret scanning の alert

漏れた値は、まず失効させて入れ替えます。
値・種類・場所（ファイルパス・コミット）は、Issue・コメント・PR などの公開の場に書きません。
場所は Security タブの alert で確かめます。
テストのための合成の値など、直さない alert は、次の「誤検知の alert を閉じる」の手順で決めます。
閉じた alert は、次の実行で Tracker の行が表から消えます。

<a id="alert-exceptions-review"></a>

### 例外の見直し

例外の alert は Tracker の表に載らないので、リリースのときの `pecot release preflight` で見直します。
preflight は、例外ごとに、理由と見直しの条件（`reevaluate`）を表示します。リリースの前に、条件が満たされたかを確かめます。

見直しの手順は次のとおりです。

1. 例外ごとに、`reevaluate` の条件が満たされたかを確かめる。親の依存の最新版を調べる
2. 満たされた例外は、依存を更新して alert を fixed にし、例外を外す
3. 満たされない例外は残す。`reason` が古ければ書き直す
4. alert がすでに閉じている例外は、ファイルから外す
5. 見直しの結果をコミットまたは PR にする

## 誤検知の alert を閉じる（メンテナ向け）

対象は code scanning と secret scanning の alert です。
Dependabot の alert は、上の「Dependabot の alert」で扱います。

- 閉じてよいのは、リポジトリの admin が認めた alert だけである。エージェントは、閉じる alert の一覧と理由を示す。admin が承認してから dismiss を打つ
- 理由は、alert の dismiss コメントに書く。code scanning は `dismissed_comment` で、280 字以内である。secret scanning は `resolution_comment` で、後から直せない
- まとめて閉じるときは、一覧を承認した Issue の plan コメントの URL をコメントに書く
- 実害のある alert と、直すほうが安い alert は、dismiss せずに直す

閉じる前に、次の順で確かめます。

1. 書き直してテストや実装が良くなるなら、直す。例は、部分一致の assert を全体の比較にすることである
2. テストに要る秘密の形の値は、`.github/secret_scanning.yml` の `paths-ignore` で、そのファイルだけを外す。値を文字列の連結で組み立てて、検知を避けない
3. それでも残る誤検知を dismiss する

reason は次の表で選びます。

| alert の状況 | code scanning の `dismissed_reason` | secret scanning の `resolution` |
|---|---|---|
| テストのコード | `used in tests` | `used_in_tests` |
| 仕様どおり、または結果を描画しない加工 | `false positive` | `false_positive` |
| 入力が作者自身のファイルに限られ、直す益が薄い | `won't fix` | `wont_fix` |
| 別の層で防いでいる | `mitigated` | なし |

打つコマンドの例です。

```
gh api -X PATCH repos/pecotcraft/pecot/code-scanning/alerts/<番号> \
  -f state=dismissed -f dismissed_reason='used in tests' -f dismissed_comment='<理由と plan コメントの URL>'

gh api -X PATCH repos/pecotcraft/pecot/secret-scanning/alerts/<番号> \
  -f state=resolved -f resolution=used_in_tests -f resolution_comment='<理由と plan コメントの URL>'
```
