---
version: alpha
name: Poster / Report (日本語)
description: 日本語ポスター・年次報告書 Design System（構図指定がない汎用ポスター用）。日本政府デジタル庁デザインシステム（DADS）の組版規範を骨格に、Major Third (1.25) モジュラースケールで typography を再構成。draw.io 図表で 1 枚自己完結の報告書・分析・比較資料を生成する際の design tokens（colors / typography / layout / elevation / shapes / components）を提供する。レイアウト・ページ構成は題材ごとにエージェントが判断するため、本ファイルには記述しない（google-labs-code/design.md 公式仕様準拠）。
$extensions:
  pecotv:
    textCellBaseStyle: "text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;strokeColor=none;fillColor=none;fontFamily={typography.body.fontFamily};"
    typography:
      scale: "Major Third (1.25), base 17px"
    canvas:
      screen: "1200x900"
      printA4Landscape: "1120x794"
      printA3Landscape: "1584x1122"
    rounded:
      sharp: "rounded=0"
      sm: "rounded=1;absoluteArcSize=1;arcSize=8"
      pill: "rounded=1;arcSize=50"
    stroke:
      hairline: 1
      bold: 3
    components:
      badge:
        paddingX: 16
        paddingY: 4
      badge-accent:
        paddingX: 16
        paddingY: 4
      card:
        strokeColor: none
      panel:
        strokeColor: "{colors.borderHairline}"
        strokeWidth: hairline
      arrow-default:
        strokeColor: "{colors.textMuted}"
        strokeWidth: hairline
        endArrow: open
        endFill: false
        intent: 標準の接続 / 主経路から外れる枝
      arrow-emphasis:
        strokeColor: "{colors.accent}"
        strokeWidth: bold
        endArrow: classic
        endFill: true
        intent: 最重要因果 / 図を貫く主経路（1 図 1 系統。系統内なら複数本を連ねてよい）
      arrow-reference:
        strokeColor: "{colors.borderHairline}"
        strokeWidth: hairline
        dashed: true
        endArrow: open
        endFill: false
        intent: 参照関係（処理の流れではない結びつき）
      icon-symbol:
        protocol: "icon://"
        sizingRule: "隣接テキストの font-size × 0.7-0.85（cap-height 相当）"
        intent: 章マーカー / KPI 横 / status / list bullet 代替（意味補強）
      icon-accent:
        protocol: "icon://"
        sizingRule: "隣接テキストの font-size × 0.7-0.85"
        intent: 1 図 1 ヶ所までの最重要アイコン
colors:
  primary: "#4f46e5"
  primaryFog: "#EEF2FF"
  accent: "#c2410c"
  ink: "#111418"
  textMuted: "#6B7280"
  paperWhite: "#FFFFFF"
  surfaceMuted: "#F3F4F6"
  borderHairline: "#C7CBD1"
typography:
  display:
    fontFamily: "sans-serif"
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0px
  hero:
    fontFamily: "sans-serif"
    fontSize: 65px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0px
  h1:
    fontFamily: "sans-serif"
    fontSize: 33px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02em
  h2:
    fontFamily: "sans-serif"
    fontSize: 27px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02em
  h3:
    fontFamily: "sans-serif"
    fontSize: 21px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02em
  body:
    fontFamily: "sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: 0.02em
  caption:
    fontFamily: "sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.02em
  captionLabel:
    fontFamily: "sans-serif"
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 0.02em
  mono:
    fontFamily: "'Noto Sans Mono', monospace"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
rounded:
  sharp: 0px
  sm: 4px
  pill: 999px
spacing:
  base: 8px
  ladder4: 4px
  ladder8: 8px
  ladder16: 16px
  ladder24: 24px
  ladder32: 32px
  ladder48: 48px
  ladder64: 64px
  ladder96: 96px
  ladder128: 128px
components:
  text-display:
    typography: "{typography.display}"
    textColor: "{colors.ink}"
  text-hero:
    typography: "{typography.hero}"
    textColor: "{colors.ink}"
  text-h1:
    typography: "{typography.h1}"
    textColor: "{colors.ink}"
  text-h2:
    typography: "{typography.h2}"
    textColor: "{colors.ink}"
  text-h3:
    typography: "{typography.h3}"
    textColor: "{colors.ink}"
  text-body:
    typography: "{typography.body}"
    textColor: "{colors.ink}"
  text-caption:
    typography: "{typography.caption}"
    textColor: "{colors.textMuted}"
  text-caption-label:
    typography: "{typography.captionLabel}"
    textColor: "{colors.textMuted}"
  text-mono:
    typography: "{typography.mono}"
    textColor: "{colors.ink}"
  badge:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.pill}"
  badge-accent:
    backgroundColor: "{colors.accent}"
    rounded: "{rounded.pill}"
  text-badge:
    typography: "{typography.captionLabel}"
    textColor: "{colors.paperWhite}"
  card:
    backgroundColor: "{colors.surfaceMuted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 24px
  card-fog:
    backgroundColor: "{colors.primaryFog}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.paperWhite}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 24px
  panel-stroke:
    backgroundColor: "{colors.borderHairline}"
  divider-h:
    backgroundColor: "{colors.borderHairline}"
    height: 1px
  divider-h-strong:
    backgroundColor: "{colors.ink}"
    height: 3px
  divider-v:
    backgroundColor: "{colors.borderHairline}"
    width: 1px
  arrow-default:
    backgroundColor: "{colors.textMuted}"
  arrow-emphasis:
    backgroundColor: "{colors.accent}"
  arrow-reference:
    backgroundColor: "{colors.borderHairline}"
  icon-symbol:
    backgroundColor: "{colors.ink}"
  icon-symbol-muted:
    backgroundColor: "{colors.textMuted}"
  icon-accent:
    backgroundColor: "{colors.accent}"
  icon-symbol-body:
    size: 12px
  icon-symbol-h3:
    size: 16px
  icon-symbol-h2:
    size: 20px
---

<!-- markdownlint-disable MD013 -->

# Poster / Report Design System（日本語）

## Overview

- 日本語の自己完結ポスター・年次報告書・白書・分析資料用 Design System。draw.io 図表での生成を前提とする。
- 想定読者: 図 1 枚を渡されて単独で読む日本語話者の技術メンバー・意思決定者。
- 棲み分け: aws / azure はインフラ構成図のリソース描画、infographic は口頭補足前提の概念図、本スタイルは **文書としての密度** を持つ自己完結ポスター。
- 本ファイルは、レイアウト指定がない汎用ポスターの設計仕様。スイムレーン処理フロー図のようにレイアウトが定まった依頼は、`references/poster/` 配下のレイアウト別ファイルが担当する。例は `poster/swimlane-flow/DESIGN.md`。
- 思想ベース: [デジタル庁デザインシステム (DADS)](https://design.digital.go.jp/dads/foundations/typography/) の Typography 規範に準拠。宣言の書体を使い、weight は N(400) と B(700) の 2 階層。最小は 16px。行間は 1.5-1.7。letter-spacing は 0 または 0.02em。イタリックは禁止。サイズスケールは Major Third (1.25) で展開する。base 17px から 21 / 27 / 33 / 52 / 65 とし、14 / 16 も使う。
- 本ファイルが記述するのは **design tokens（色・タイポ・余白・形・コンポーネント単位スタイル）のみ**。ページレイアウト・章構成・要素配置は題材ごとに生成エージェントが判断する（[google-labs-code/design.md](https://github.com/google-labs-code/design.md) 公式仕様準拠）。

### この定義の扱い

- 元データは front matter の YAML とする。書式は [Google DESIGN.md 仕様](https://github.com/google-labs-code/design.md)（alpha）に従う。本文の値は YAML の写しで、食い違ったら YAML を正とする
- 文字: `components.text-<段>` が `typography.<段>`（書体・大きさ・太さ・行間・字間の組）と文字色（`textColor`）を組にする。1 セルのコンポーネント（badge）でも文字は `text-badge` 側に置く
- 面: `components.<部品>` の `backgroundColor`（塗り）・`rounded`・`padding`・`width` / `height` / `size`
- 描線の色: 線だけのコンポーネント（`divider-*` / `arrow-*`）は、自身の `backgroundColor`。塗りと描線を持つコンポーネント（`panel`）は、`<コンポーネント>-stroke` コンポーネントの `backgroundColor`
- 拡張の `components.<コンポーネント>.strokeColor` は style 側の写し。本体と食い違ったら、本体を正とする。本体とは、`<コンポーネント>-stroke` と線コンポーネントの `backgroundColor`
- 仕様に置き場の無い値は、`$extensions` の `pecotv` の下（以下「拡張」）に置く。text セルの必須ベースは、拡張の `textCellBaseStyle`。画面寸法は `canvas`。線幅は `stroke`。コンポーネントごとの値は、拡張の `components.<コンポーネント>`（仕様側と同名）に置く。値は strokeColor / strokeWidth / dashed / endArrow / endFill / paddingX / paddingY / intent 等
- 角丸: `rounded` は実半径 px の尺度。draw.io での書き方は拡張の `rounded.<段>`
- 余白: `spacing.base` と `spacing.ladder-<値>`（8px ladder の 9 段）

## Colors

- `primary` (#4f46e5): 主色。document title 下の太罫線、badge success、micro-table summary 下線、主役区画の見出し文字色・主役区画内カードの罫線（hairline）。
- `primaryFog` (#EEF2FF): 薄い primary。引用・補足ブロック背景。
- `accent` (#c2410c): 強調 1 点用。最重要数値の色付け、警告 badge、引用記号。
- `ink` (#111418): 本文文字色（pure black を避けた near-black）。
- `textMuted` (#6B7280): 注釈・補助情報。
- `paperWhite` (#FFFFFF): 紙地。
- `surfaceMuted` (#F3F4F6): 引用・参考ブロック背景。
- `borderHairline` (#C7CBD1): 標準罫線色。

色は 1 枚あたり 4-5 色に抑える。配色表にない純赤・純緑など追加禁止。

コントラスト比は、白文字 `paperWhite` との組で見る。`badge` の primary 地は 6.29:1。`badge-accent` の accent 地は 5.18:1 で、どちらも WCAG AA（通常の文字 4.5:1）を満たす。

## Typography

- font-family: 段の `fontFamily` の値。宣言が決まっているときは、`fonts.body`、`eastAsian`（`body` に無ければ）、末尾の `sans-serif` の順に並べる。例は `Test Sans, Test Sans JP, sans-serif`。英文だけの書体の並びは禁止。
- スケール: Major Third (1.25) / base 17px から ×1.25 で展開し四捨五入で整数化。14 / 17 / 21 / 27 / 33 / 52 / 65 px の 7 階層。
- weight: N(400) / B(700) の 2 階層のみ（DADS 準拠）。中間ウェイト 500/600 禁止。
- line-height: 1.4 / 1.5 / 1.7 のいずれか。本文 17px 以下は 1.7 を使う。
- letter-spacing: 0 または 0.02em のみ。マイナス値（詰め）禁止（日本語の組版禁則）、0.01em は使わず 0 or 0.02 に絞る。
- イタリック禁止（DADS。日本語の可読性が下がるため）。
- UPPERCASE 化は欧文要素のみに限定。日本語にケース概念なし。
- 最小フォントサイズ 16px。14px は `caption` / `badge` のみ例外。`caption` は注釈・補助情報（`text-caption`、Regular）に加え、列見出し・ノード内の補足行・エッジラベルといったラベル用途（`text-caption-label`、Bold）を含む。本文・見出しを 14px に落とすことは認めない。

## Layout & Spacing

- 8px base ladder: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128（`spacing.ladder4` 〜 `spacing.ladder128`）。半端な数値（18, 21, 40 等）は使わない。
- スケールから任意の値を取れるが、1 ページで多用すると団子化する。実運用上は 3-4 段に絞ると視覚的リズムが生まれる（どの段を選ぶかはエージェント判断）。

## Elevation & Depth

- 影なし、3D 効果なし、グラデーション禁止。
- opacity プロパティ完全禁止（CMYK 変換時の色濁り、PDF flatten の色シフトを避ける）。
- 階層は **トーン段階の純色** で表現する: paperWhite → surfaceMuted → primaryFog の 3 段、または ink ↔ textMuted の文字色対比。

## Shapes

- 角丸: `sharp` (0) / `sm` (4) / `pill` (999) の 3 段階。中間値（2 / 6 / 8 / 12 / 16）禁止。段階の数値は **実半径 px** の規定であり、draw.io の `arcSize` 属性値の字面ではない。
- draw.io では次の書き方で表す（拡張の `rounded.sharp` / `rounded.sm` / `rounded.pill`）。`arcSize` は `absoluteArcSize=1` を付けると直径相当（実半径 = `arcSize` ÷ 2）、付けないと短辺に対する % 解釈になるため、値をそのまま px 半径として読まない。
  - `sharp`: `rounded=0`
  - `sm`（実半径 4px）: `rounded=1;absoluteArcSize=1;arcSize=8`
  - `pill`: `rounded=1;arcSize=50`（% 指定。短辺の半分 = 半円）
- 線幅: `hairline` (1px) / `bold` (3px) の 2 段階（拡張の `stroke`）。中間値（2, 4, 5）禁止。

## Components

draw.io の個別シェイプ・テキスト・矢印に対応する **UI primitive** 群。複合パターン（hero セクション・summary box 等）はここに含めない（題材ごとにエージェントが組み立てる）。

### Text primitives

- `text-display` / `text-hero`: タイトル・主役数値用（52 / 65px Bold、line 1.4、letter 0）
- `text-h1` / `text-h2` / `text-h3`: 見出し階層（33 / 27 / 21px Bold、line 1.5、letter 0.02em）
- `text-body`: 本文 17px Regular、line 1.7、letter 0.02em
- `text-caption`: 注釈・補助情報 14px Regular、textMuted
- `text-caption-label`: 列見出し・ノード内の補足行・エッジラベルなどラベル用途の 14px Bold、textMuted
- `text-mono`: コード・識別子用 monospace（`typography.mono`。17px Regular、line 1.5、letter 0）

draw.io 上では、拡張の `textCellBaseStyle` を全 text セルの **必須ベース** とする。`textCellBaseStyle` の値は次のとおり。

```text
style="text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;strokeColor=none;fillColor=none;fontFamily=..."
```

`whiteSpace=wrap` を欠くと、セル幅を超えるテキストが折り返されず、横にはみ出す。そのため必ず入れる。HTML 値は `<font style="font-size:Xpx;color:#hex;line-height:Y;letter-spacing:Z;">` 形式。

### Containers

- `card`: surfaceMuted 薄塗りカード（rounded sm 4px、padding 24px）
- `card-fog`: card の primaryFog 塗り版。引用・補足ブロック背景
- `panel`: paperWhite + hairline 罫線パネル（rounded sm 4px、padding 24px、strokeWidth 1px）。罫線の色は `panel-stroke`

### Badges

- `badge`: primary 塗り + paperWhite caption、pill 形（rounded 999）、paddingX 16 / paddingY 4
- `badge-accent`: accent 塗り版
- `text-badge`: badge の文字（caption の 14px Bold、paperWhite）

### Dividers

- `divider-h`: 水平 hairline 罫線（borderHairline 1px）
- `divider-h-strong`: 水平 太罫線（ink 3px、章末強調用）
- `divider-v`: 垂直 hairline 罫線

### Arrows

- `arrow-default`: textMuted 1px、open arrowhead（標準）
- `arrow-emphasis`: accent 3px、filled arrowhead（最重要の因果と、図を貫く主要な流れの強調）
- `arrow-reference`: borderHairline 1px、dashed、open arrowhead（参照関係）

`arrow-emphasis` は、本数ではなく **系統数** で制限する。読者が最初に辿る主要な流れが 1 系統であれば、工程や区画をまたいで何本連ねてもよい。主要な流れから外れる枝は、`arrow-default` に下げて差を作る。互いに無関係な複数系統を同時に accent で描くと、主要な流れが埋もれる。そのため、1 図 1 系統に絞る。

エッジラベルは矢印に載せず、独立した text セルで置く。線の強弱と色・weight を一致させる。`arrow-default` に添えるラベルは `text-caption-label`（14px textMuted Bold）。`arrow-emphasis` に添えるラベルは、同じ 14px Bold で色を accent に差し替える。

### Icons

- アイコンは **full bounding box** で描画されるため、同サイズのフォントより視覚的に約 1.4 倍大きく見える。隣接テキストの **font-size × 0.7-0.85（cap-height 相当）** をサイズの目安にする:
  - caption (14px) の隣 → icon 10-12px
  - body (17px) の隣 → icon 12-14px
  - h3 (21px) の隣 → icon 14-16px
  - h2 (27px) の隣 → icon 18-20px
  - h1 (33px) の隣 → icon 24px
- 目安のうち、body / h3 / h2 の隣に置く既定値は、次の `size`。`icon-symbol-body`（12px）/ `icon-symbol-h3`（16px）/ `icon-symbol-h2`（20px）。
- `icon-symbol`: ink（`icon-symbol-muted` は textMuted）の単色。章マーカー / KPI ラベル隣 / list bullet 代替の意味補強用。
- `icon-accent`: accent 単色。1 図 1 ヶ所までの最重要シンボル。
- 多色塗り・グラデーション・隣接テキストより大きいサイズは禁止。

## Do's and Don'ts

### 必ず守る

- font-family は段の `fontFamily` の値全体を全 text セルに必ず指定（英文だけの書体の並びは禁止）
- weight は N(400) / B(700) の 2 階層のみ
- letter-spacing は 0 または 0.02em のみ。マイナス値禁止
- line-height は 1.4 / 1.5 / 1.7 のいずれか
- 最小フォントサイズ 16px（caption / badge の 14px のみ例外。ラベル用途の 14px Bold は `text-caption-label`）
- 寸法は 8px ladder（4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128）に揃える
- 角丸は実半径 sharp(0) / sm(4) / pill(999) のみ（draw.io 上の書き方は Shapes 節を参照）
- 線幅は hairline(1) / bold(3) のみ
- 全エッジに `<mxGeometry relative="1" as="geometry"/>` を含める
- HTML 属性値はダブルクォート（`&quot;`）
- text セルは `style="text;html=1;whiteSpace=wrap;..."` を必須。`whiteSpace=wrap` を欠くと折り返されず横にはみ出す
- アイコンは `icon://` プロトコルで ink / textMuted / accent の単色、サイズは隣接テキスト font-size × 0.7-0.85 を目安に

### 避ける

- 半端な数値（padding=18 / size=22 / height=120 等、ladder 外の値）
- opacity プロパティでの elevation 表現
- 影・グラデーション・3D 効果
- イタリック / 日本語の UPPERCASE 化
- 中間ウェイト（500 / 600）
- マイナス letter-spacing
- 配色表にない純赤・純緑の追加
- アイコンの多色塗り・グラデーション・48px 以上の大型化
