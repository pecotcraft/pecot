---
version: alpha
name: AWS Architecture
description: draw.io 組み込みの aws4 シェイプライブラリで AWS インフラ構成図を描くスタイル。VPC / Subnet / リソースアイコンを使い、構成の正確性を優先する。
omitted:
  - section: rounded
    reason: 角丸は draw.io の rounded フラグ（0 / 1）で、px の尺度を持たない
$extensions:
  pecotv:
    rounded:
      icon: 0
      edge: 1
    components:
      resource-icon:
        description: aws4 resourceIcon shape。`resIcon` でサービス名、`fillColor` でカテゴリ色を指定する。
        styleTemplate: "sketch=0;outlineConnect=0;fontColor={colors.iconForeground};fillColor=<categoryColor>;strokeColor={colors.iconLabel};dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;fontSize=11;fontFamily={typography.iconLabel.fontFamily};fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.<serviceName>;"
      group-boundary:
        description: aws4 group shape。`grIcon` で境界種別を切り替える（aws_cloud_alt / vpc / security_group）。
        styleTemplate: "sketch=0;outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontFamily={typography.groupLabel.fontFamily};fontStyle=1;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_<grIcon>;verticalAlign=top;align=left;spacingLeft=30;spacingTop=5;dashed=0;container=1;collapsible=0;expand=0;"
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
  compute: "#ED7100"
  network: "#8C4FFF"
  database: "#3B48CC"
  storage: "#3F8624"
  management: "#E7157B"
  security: "#DD344C"
  iconForeground: "#232F3E"
  iconLabel: "#FFFFFF"
  awsCloudStroke: "#232F3E"
  vpcStroke: "#248814"
  publicSubnetStroke: "#248814"
  publicSubnetFill: "#E9F3E6"
  privateSubnetStroke: "#147EBA"
  privateSubnetFill: "#E6F2F8"
  edge: "#232F3E"
  primary: "{colors.iconForeground}"
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
  groupPaddingTop: 60px
  groupPaddingHorizontal: 50px
  groupPaddingBottom: 50px
  vpcOuterMargin: 60px
components:
  text-icon-label:
    typography: "{typography.iconLabel}"
    textColor: "{colors.iconForeground}"
  text-group-label:
    typography: "{typography.groupLabel}"
  text-edge-label:
    typography: "{typography.edgeLabel}"
  resource-icon:
    width: 48px
    height: 48px
  resource-icon-compute:
    backgroundColor: "{colors.compute}"
  resource-icon-network:
    backgroundColor: "{colors.network}"
  resource-icon-database:
    backgroundColor: "{colors.database}"
  resource-icon-storage:
    backgroundColor: "{colors.storage}"
  resource-icon-management:
    backgroundColor: "{colors.management}"
  resource-icon-security:
    backgroundColor: "{colors.security}"
  resource-icon-stroke:
    backgroundColor: "{colors.iconLabel}"
  group-aws-cloud:
    backgroundColor: "{colors.awsCloudStroke}"
  group-vpc:
    backgroundColor: "{colors.vpcStroke}"
  group-public-subnet:
    backgroundColor: "{colors.publicSubnetFill}"
  group-public-subnet-stroke:
    backgroundColor: "{colors.publicSubnetStroke}"
  group-private-subnet:
    backgroundColor: "{colors.privateSubnetFill}"
  group-private-subnet-stroke:
    backgroundColor: "{colors.privateSubnetStroke}"
  edge-standard:
    backgroundColor: "{colors.edge}"
  edge-async:
    backgroundColor: "{colors.edge}"
  edge-labeled:
    backgroundColor: "{colors.edge}"
---

<!-- markdownlint-disable MD013 -->

# AWS Architecture

## Overview

- AWS リソースの実構成を、aws4 公式シェイプで正確に描くためのスタイル。
- azure スタイルと違い AWS マネージドサービス前提で `mxgraph.aws4.*` シェイプを使う。infographic と違い構成図の正確性（VPC/Subnet 境界・接続関係）を優先し、装飾要素を持たない。poster と違い 1 枚で結論まで伝える設計ではなく、口頭・テキスト併用の前提でリソース関係に集中する。
- 想定読者は AWS 上のインフラ・アプリ設計をレビューする技術メンバー。

### この定義の扱い

- 元データは front matter の YAML とする。書式は [Google DESIGN.md 仕様](https://github.com/google-labs-code/design.md)（alpha）に従う。本文の値は YAML の写しで、食い違ったら YAML を正とする
- draw.io の style 文字列は、`$extensions` の `pecotv` の `components.<コンポーネント>.styleTemplate` に置く。`{colors.x}` と `{typography.<段>.fontFamily}` は front matter の値に置き換える。`<categoryColor>` / `<serviceName>` / `<grIcon>` は本文の表から埋める
- variant（`resource-icon-compute` 等・`group-aws-cloud` 等）と `-stroke` コンポーネントの style は、値の埋め込みで作る。埋め込み先は、`$extensions` の `resource-icon` / `group-boundary` のプレースホルダー。埋める値は、variant の色と Groups 表の値
- 文字の色と段は `components.text-<段>`（`text-icon-label` / `text-group-label` / `text-edge-label`）に置く。`textColor` の無い段は、style に文字色の指定が無い
- 描線の色の置き場は、コンポーネントの種類で決まる。線だけのコンポーネントは、自身の `backgroundColor` に置く。対象は `edge-standard` / `edge-async` / `edge-labeled`。塗りの無い境界（`group-aws-cloud` / `group-vpc`）も、自身の `backgroundColor` に置く。塗りと描線の両方を持つコンポーネントは、`<コンポーネント>-stroke` の `backgroundColor` に置く。style では `strokeColor` に入れる
- `resource-icon-stroke` の色（`iconLabel`）はアイコンのグリフの色で、`-stroke` と呼ぶのは draw.io のキー名が `strokeColor` であるため
- `primary` は仕様が要求する別名（`iconForeground` の値）で、図の塗りには使わない
- 角丸は draw.io の `rounded` フラグ（0 / 1）で px の値を持たないため、仕様の `rounded` には書かず `omitted` に理由を書く。フラグは `$extensions.pecotv.rounded` に置く

## Colors

- カテゴリ色は AWS 公式アイコン配色を踏襲する。対象は `compute` / `network` / `database` / `storage` / `management` / `security`。色は `resource-icon-<カテゴリ>` の `backgroundColor` で決める。この値が `resource-icon` の style の `fillColor`（`<categoryColor>`）に直接入る。
- `iconForeground` はアイコンと一緒に並ぶ短いラベル文字色（`text-icon-label`）、`iconLabel` はアイコン本体内の白色領域（`resource-icon-stroke`）。
- グループ境界色は、`vpcStroke` などのトークンで管理する。色は `group-<種類>` と `group-<種類>-stroke` の `backgroundColor` から流し込む。流し込み先は、`group-boundary` の style の `strokeColor` / `fillColor`。
- `edge` はすべての接続線で共通。色を変えてしまうと「正常／異常」のような新しい意味を読み手が勝手に補完するため、強調はストローク幅と破線（`edge-async`）で行う。

## Typography

- 全ラベルの style に、`fontFamily=<body の書体>, <eastAsian>, sans-serif` を指定する。末尾は必ず `sans-serif` にする。宣言が無いときは `fontFamily=sans-serif` とするする（HTML ラベル不要）。
- アイコンラベル 11px、グループラベル 12px、エッジラベル 9px に統一。
- 太字はグループラベルのみ（`fontStyle=1`）。アイコンラベル本文を太字にしない。

## Layout

- アイコンの水平間隔 `{spacing.iconHorizontal}`、垂直間隔 `{spacing.iconVertical}`。
- グループ内余白は、上が `{spacing.groupPaddingTop}`（ラベル分）。左右が `{spacing.groupPaddingHorizontal}`。下が `{spacing.groupPaddingBottom}`。
- VPC 外マージン `{spacing.vpcOuterMargin}`。
- AWS Cloud 境界は内包要素に合わせた最小サイズで、Subnet と入れ子で表現する。
- 子要素の座標は親グループ内のローカル座標（親左上が原点）。

## Elevation & Depth

- 視覚階層は「AWS Cloud > VPC > Subnet > リソース」の入れ子で表す。色の濃淡や影は使わない。
- Public / Private Subnet は `fillColor` の有無で区別（Public は薄緑塗り、Private は薄青塗り）。

## Shapes

- リソースはすべて `mxgraph.aws4.resourceIcon` 派生。サイズは 48×48 固定。
- グループ境界は `mxgraph.aws4.group` 派生。`grIcon` の値で外観が変わる（下表）。
- 角丸はエッジ側のみ（`rounded=1`）。アイコン・境界は角丸なし（`$extensions.pecotv.rounded` の `icon: 0` / `edge: 1`）。

## Components

`$extensions.pecotv.components.resource-icon.styleTemplate` のカテゴリ色とサービス名は下表を組み合わせる。`<categoryColor>` に `resource-icon-<カテゴリ>` の `backgroundColor`（見出しの色トークン）、`<serviceName>` に下表のサービス名を入れる。

### Compute — `{colors.compute}` (#ED7100)

| サービス名 | 表示名 |
|-----------|--------|
| lambda | Lambda |
| eks | EKS |
| ecs | ECS |
| fargate | Fargate |
| ec2 | EC2 |

### Network — `{colors.network}` (#8C4FFF)

| サービス名 | 表示名 |
|-----------|--------|
| elastic_load_balancing | Elastic Load Balancing |
| cloudfront | CloudFront |
| route_53 | Route 53 |
| api_gateway | API Gateway |

### Database — `{colors.database}` (#3B48CC)

| サービス名 | 表示名 |
|-----------|--------|
| aurora | Aurora |
| rds | RDS |
| dynamodb | DynamoDB |
| elasticache | ElastiCache |

### Storage — `{colors.storage}` (#3F8624)

| サービス名 | 表示名 |
|-----------|--------|
| s3 | S3 |

### Management / Messaging — `{colors.management}` (#E7157B)

| サービス名 | 表示名 |
|-----------|--------|
| cloudwatch | CloudWatch |
| sqs | SQS |
| sns | SNS |
| eventbridge | EventBridge |

### Security — `{colors.security}` (#DD344C)

| サービス名 | 表示名 |
|-----------|--------|
| waf | WAF |
| cognito | Cognito |
| iam | IAM |
| secrets_manager | Secrets Manager |

### Edge usage example

```xml
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;strokeColor=#232F3E;strokeWidth=2;rounded=1;" edge="1" source="sourceId" target="targetId" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

非同期は `dashed=1` を足す。ラベル付きはエッジの `value` 属性にテキストを置き `fontSize=9` を style に追加する。

## Groups

`$extensions.pecotv.components.group-boundary.styleTemplate` の `<grIcon>` と色を下表で切り替える。`strokeColor` / `fillColor` は front matter のコンポーネント（variant）の `backgroundColor` を使う。

| 種類 | コンポーネント | `grIcon` | strokeColor | fillColor |
|------|------|----------|-------------|-----------|
| AWS Cloud | `group-aws-cloud` | aws_cloud_alt | `{colors.awsCloudStroke}` (#232F3E) | none |
| VPC | `group-vpc` | vpc | `{colors.vpcStroke}` (#248814) | none |
| Public Subnet | `group-public-subnet` / `-stroke` | security_group | `{colors.publicSubnetStroke}` (#248814) | `{colors.publicSubnetFill}` (#E9F3E6) |
| Private Subnet | `group-private-subnet` / `-stroke` | security_group | `{colors.privateSubnetStroke}` (#147EBA) | `{colors.privateSubnetFill}` (#E6F2F8) |

## Edges

- 標準: `edge-standard`。同期呼び出し・参照関係に使う。
- 非同期 / オプショナル: `edge-async`（破線）。SQS/SNS など疎結合な接続を区別する用途だけに限定。
- ラベル付き: `edge-labeled`。プロトコルや条件を 1〜2 単語で添える。

## Do's and Don'ts

- 必ず全エッジに `<mxGeometry relative="1" as="geometry"/>` を含める。省略すると VSCode draw.io 拡張でキャンバスが表示されなくなる。
- **必ず** Subnet を VPC の中に、VPC を AWS Cloud の中に入れ子で配置する。並列に置くと境界の意味が崩れる。
- **必ず** 子要素の座標は親グループ内のローカル座標で指定する。親グループの絶対座標を子に流用しない。
- しない: カテゴリ色を AWS 配色から外れた色に置き換える（読み手の学習済みマッピングを損なう）。
- しない: エッジ色を意味で塗り分ける（正常/異常の区別が必要なら破線 `edge-async` で表現）。
- しない: アイコンサイズを 48×48 から変える（並んだ時にアイコン同士の重みが揃わなくなる）。
