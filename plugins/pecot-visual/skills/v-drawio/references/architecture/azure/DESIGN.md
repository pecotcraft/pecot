---
version: alpha
name: Azure Architecture
description: draw.io 組み込みの azure2 アイコンライブラリで Azure インフラ構成図を描くスタイル。VNet / Subnet / Resource Group の入れ子と SVG ベースのリソースアイコンを使う。
omitted:
  - section: rounded
    reason: 角丸は draw.io の rounded フラグ（0 / 1）と短辺比の arcSize で、px の尺度を持たない
$extensions:
  pecotv:
    rounded:
      group: 1
      groupArcSize: 5
      edge: 1
    components:
      resource-icon:
        description: azure2 アイコンを img SVG として埋め込む。`image=` に `img/lib/azure2/<category>/<filename>.svg` を指定する。`<category>` と `<filename>` は同階層の `ICONS.md` から選ぶ。
        styleTemplate: "image;aspect=fixed;html=1;align=center;fontSize=11;fontFamily={typography.iconLabel.fontFamily};image=img/lib/azure2/<category>/<filename>.svg;labelPosition=center;verticalLabelPosition=bottom;verticalAlign=top;"
      group-boundary:
        description: 角丸破線の矩形でグループ境界を表す。`fillColor` / `strokeColor` を Groups 表から指定する。
        styleTemplate: "rounded=1;arcSize=5;whiteSpace=wrap;dashed=1;strokeWidth=2;fontSize=12;fontFamily={typography.groupLabel.fontFamily};fontStyle=1;verticalAlign=top;align=left;spacingLeft=10;spacingTop=5;fontColor={colors.labelText};fillColor=<fillColor>;strokeColor=<strokeColor>;"
      edge-standard:
        description: 同期呼び出しなど通常の関係線。
        styleTemplate: "edgeStyle=orthogonalEdgeStyle;strokeColor={colors.edge};strokeWidth=2;rounded=1;"
      edge-async:
        description: 非同期・オプショナル呼び出し。破線で区別する。
        styleTemplate: "edgeStyle=orthogonalEdgeStyle;strokeColor={colors.edge};strokeWidth=2;rounded=1;dashed=1;"
      edge-labeled:
        description: ラベル付きエッジ。`value` 属性にテキストを置き `fontSize=9` を追加する。
        styleTemplate: "edgeStyle=orthogonalEdgeStyle;strokeColor={colors.edge};strokeWidth=2;rounded=1;fontSize=9;fontFamily={typography.edgeLabel.fontFamily};"
colors:
  azureBrand: "#0078D4"
  azureBrandBg: "#E7F1FA"
  resourceGroupStroke: "#767676"
  resourceGroupFill: "#F2F2F2"
  subnetStroke: "#56A64B"
  subnetFill: "#F0F7ED"
  edge: "#333333"
  labelText: "#333333"
  primary: "{colors.azureBrand}"
typography:
  iconLabel:
    fontFamily: "sans-serif"
    fontSize: 11px
  groupLabel:
    fontFamily: "sans-serif"
    fontSize: 12px
    fontWeight: 700
  edgeLabel:
    fontFamily: "sans-serif"
    fontSize: 9px
spacing:
  iconHorizontal: 100px
  iconVertical: 120px
  groupPaddingTop: 50px
  groupPaddingHorizontal: 40px
  groupPaddingBottom: 40px
  vnetOuterMargin: 60px
components:
  text-icon-label:
    typography: "{typography.iconLabel}"
  text-group-label:
    typography: "{typography.groupLabel}"
    textColor: "{colors.labelText}"
  text-edge-label:
    typography: "{typography.edgeLabel}"
  resource-icon:
    width: 50px
    height: 50px
  group-azure:
    backgroundColor: "{colors.azureBrand}"
  group-resource-group:
    backgroundColor: "{colors.resourceGroupFill}"
  group-resource-group-stroke:
    backgroundColor: "{colors.resourceGroupStroke}"
  group-vnet:
    backgroundColor: "{colors.azureBrandBg}"
  group-vnet-stroke:
    backgroundColor: "{colors.azureBrand}"
  group-subnet:
    backgroundColor: "{colors.subnetFill}"
  group-subnet-stroke:
    backgroundColor: "{colors.subnetStroke}"
  edge-standard:
    backgroundColor: "{colors.edge}"
  edge-async:
    backgroundColor: "{colors.edge}"
  edge-labeled:
    backgroundColor: "{colors.edge}"
---

<!-- markdownlint-disable MD013 -->

# Azure Architecture

## Overview

- Azure リソースの実構成を、azure2 公式 SVG アイコンで正確に描くためのスタイル。
- aws スタイルと違い `img/lib/azure2/<category>/*.svg` の image shape を使う（mxgraph 内蔵シェイプではない）。infographic と違い構成図の正確性（VNet/Subnet/Resource Group の入れ子・接続関係）を優先し、装飾要素を持たない。poster と違い 1 枚で結論まで伝える設計ではなく、口頭・テキスト併用の前提でリソース関係に集中する。
- 想定読者は Azure 上のインフラ・アプリ設計をレビューする技術メンバー。

### この定義の扱い

- 元データは front matter の YAML とする。書式は [Google DESIGN.md 仕様](https://github.com/google-labs-code/design.md)（alpha）に従う。本文の値は YAML の写しで、食い違ったら YAML を正とする
- draw.io の style 文字列は、`$extensions` の `pecotv` の `components.<コンポーネント>.styleTemplate` に置く。`{colors.x}` と `{typography.<段>.fontFamily}` は front matter の値に置き換える。`<category>` / `<filename>` は [`ICONS.md`](ICONS.md) から埋める。`<fillColor>` / `<strokeColor>` は Groups 表から埋める
- variant（`group-azure` 等）と `-stroke` コンポーネントの style は、値の埋め込みで作る。埋め込み先は、`$extensions` の `group-boundary` のプレースホルダー。埋める値は、Groups 表の値
- 文字の色と段は `components.text-<段>`（`text-icon-label` / `text-group-label` / `text-edge-label`）に置く。`textColor` の無い段は、style に文字色の指定が無い
- 描線の色の置き場は、コンポーネントの種類で決まる。線だけのコンポーネントは、自身の `backgroundColor` に置く。対象は `edge-standard` / `edge-async` / `edge-labeled`。塗りの無い境界（`group-azure`）も、自身の `backgroundColor` に置く。塗りと描線の両方を持つ境界は、`<コンポーネント>-stroke` の `backgroundColor` に置く。style では `strokeColor` に入れる
- `primary` は仕様が要求する別名（`azureBrand` の値）で、図の塗りには使わない
- 角丸は draw.io の `rounded` フラグ（0 / 1）と短辺比の `arcSize` で px の値を持たないため、仕様の `rounded` には書かず `omitted` に理由を書く。フラグと `arcSize` は `$extensions.pecotv.rounded` に置く

## Colors

- `azureBrand` は VNet と Azure 全体境界の描線（VNet は `azureBrandBg` の塗りと組む）に使う Microsoft Azure ブランドカラー。
- `resourceGroupFill` / `resourceGroupStroke` は Resource Group 境界の薄グレー。`subnetFill` / `subnetStroke` は Subnet 境界の薄緑。
- `edge` は全エッジ共通。色を変えると勝手に意味付けされるため、強調は破線（`edge-async`）で行う。
- `labelText` は HTML ラベルやグループ見出しの基準文字色（`text-group-label`）。

## Typography

- 全ラベルの style に、`fontFamily=<body の書体>, <eastAsian>, sans-serif` を指定する。末尾は必ず `sans-serif` にする。宣言が無いときは `fontFamily=sans-serif` とするする。
- アイコンラベル 11px、グループラベル 12px、エッジラベル 9px。
- グループラベルのみ太字（`fontStyle=1`）。

## Layout

- アイコンの水平間隔 `{spacing.iconHorizontal}`、垂直間隔 `{spacing.iconVertical}`。
- グループ内余白は、上が `{spacing.groupPaddingTop}`（ラベル分）。左右が `{spacing.groupPaddingHorizontal}`。下が `{spacing.groupPaddingBottom}`。
- VNet 外マージン `{spacing.vnetOuterMargin}`。
- 子要素の座標は親グループ内のローカル座標（親左上が原点）。

## Elevation & Depth

- 視覚階層は「Azure 全体 > Resource Group > VNet > Subnet > リソース」の入れ子で表す。
- 境界は角丸破線で統一し、影や強い fill は使わない。fill は淡色のみ。角丸破線の指定は `dashed=1;rounded=1;arcSize=5`。対応する値は、`$extensions.pecotv.rounded` の `group: 1` / `groupArcSize: 5`。

## Shapes

- リソースは image shape（style の先頭の `image;`）で azure2 SVG を参照。サイズは 50×50。
- グループは角丸破線の矩形（標準 `mxCell` style）。
- 角丸はエッジ・グループに適用（`rounded=1`）、アイコンは適用しない。

## Components

対象は `$extensions.pecotv.components.resource-icon.styleTemplate`。その `<category>` と `<filename>` は、同階層の [`ICONS.md`](ICONS.md) から選ぶ。`ICONS.md` は Azure2 Icon Catalog。

### Edge usage example

```xml
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;strokeColor=#333333;strokeWidth=2;rounded=1;" edge="1" source="sourceId" target="targetId" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

非同期は `dashed=1` を足す。ラベル付きはエッジの `value` 属性にテキストを置き `fontSize=9` を style に追加する。

## Groups

対象は `$extensions.pecotv.components.group-boundary.styleTemplate`。その `<fillColor>` / `<strokeColor>` を、下表で切り替える。色は front matter のコンポーネント（variant）の `backgroundColor` を使う。

| 種類 | コンポーネント | fillColor | strokeColor |
|------|------|-----------|-------------|
| Azure 全体 | `group-azure` | none | `{colors.azureBrand}` (#0078D4) |
| Resource Group | `group-resource-group` / `-stroke` | `{colors.resourceGroupFill}` (#F2F2F2) | `{colors.resourceGroupStroke}` (#767676) |
| VNet | `group-vnet` / `-stroke` | `{colors.azureBrandBg}` (#E7F1FA) | `{colors.azureBrand}` (#0078D4) |
| Subnet | `group-subnet` / `-stroke` | `{colors.subnetFill}` (#F0F7ED) | `{colors.subnetStroke}` (#56A64B) |

## Edges

- 標準: `edge-standard`。同期呼び出し・参照関係。
- 非同期 / オプショナル: `edge-async`（破線）。Service Bus / Event Grid など疎結合な接続。
- ラベル付き: `edge-labeled`。プロトコルや条件を 1〜2 単語で添える。

## Do's and Don'ts

- 必ず全エッジに `<mxGeometry relative="1" as="geometry"/>` を含める。省略すると VSCode draw.io 拡張でキャンバスが表示されなくなる。
- 必ず Subnet を VNet の中に、VNet を Resource Group の中に入れ子で配置する。並列配置で境界の意味を損なわない。
- **必ず** 子要素の座標は親グループ内のローカル座標で指定する。
- しない: `image=` のパスを、自作 URL に差し替える。差し替え先は `img/lib/azure2/<category>/<filename>.svg` 以外の URL。draw.io 内蔵 SVG を使う前提が成り立たなくなる。
- しない: エッジ色を意味で塗り分ける（区別が必要なら破線 `edge-async` で表現）。
- しない: アイコンサイズを 50×50 から大きく変えて、構成図全体のリズムを損なう。
