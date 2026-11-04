---
version: alpha
name: Poster / Swimlane Flow (日本語)
description: poster（説明に使う自己完結の 1 枚絵）のうち、スイムレーン形式の処理フローを描くためのレイアウト別リファレンス。役割レーン × 工程列の直交グリッドに処理を配置し、誰が何をどの順で行うかを 1 枚で示す。poster 系の design tokens を埋め込み、この 1 ファイルで完結する（poster/general/DESIGN.md は読まなくてよい）。
$extensions:
  pecotv:
    textCellBaseStyle: "text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;strokeColor=none;fillColor=none;fontFamily={typography.body.fontFamily};"
    typography:
      scale: "Major Third (1.25), base 17px"
    canvas:
      screen: "1200x900"
      printA4Landscape: "1120x794"
      printA3Landscape: "1584x1122"
    composition:
      grid: 横軸 = 工程列 / 縦軸 = 役割レーン。1 ノードは 1 レーン × 1 工程列の交点に置く。
      laneCount: "3-6"
      stageCount: "3-5"
      laneLabelColumnWidth: 176
      laneBandFill: "surfaceMuted と paperWhite の交互塗り。主役レーン 1 本だけ primaryFog。"
      mainPathRule: レーンをまたぐ受け渡しが主経路（arrow-emphasis）。同一レーン内の工程送りは arrow-default。
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
      lane-band:
        description: レーン 1 本の背景帯。図の全幅に敷き、レーンラベル列も含めて 1 枚で塗る。
        strokeColor: none
      lane-label-divider:
        description: レーンラベル列とノード領域を分ける破線の縦罫。全レーンを貫いて 1 本だけ引く。
        strokeColor: "{colors.borderHairline}"
        strokeWidth: hairline
        dashed: true
        endArrow: none
      stage-node:
        description: 主役レーン外の工程ノード。工程名（body Bold）+ 補足行（caption）2 行までに収める。
        strokeColor: "{colors.borderHairline}"
        strokeWidth: hairline
        align: center
        verticalAlign: middle
      stage-node-lead:
        description: 主役レーン内の通常ノード（要ノード以外）。罫線色を primary にして主役レーンに属することを示す。寸法は stage-node と同じ。
        strokeColor: "{colors.primary}"
        strokeWidth: hairline
      stage-node-key:
        description: 図の要となる 1 ノード。accent の太罫線で抜き、補足行を accent Bold にする。1 図 1 ノード。
        strokeColor: "{colors.accent}"
        strokeWidth: bold
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
        intent: 同一レーン内の工程送り / 主経路から外れる枝
      arrow-emphasis:
        strokeColor: "{colors.accent}"
        strokeWidth: bold
        endArrow: classic
        endFill: true
        intent: レーンをまたぐ受け渡し = 図を貫く主経路（1 図 1 系統。系統内なら複数本を連ねてよい）
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
        intent: レーンラベル脇 / 工程列見出し / status（意味補強）
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
  lane-band:
    backgroundColor: "{colors.surfaceMuted}"
    rounded: "{rounded.sharp}"
  lane-band-paper:
    backgroundColor: "{colors.paperWhite}"
    rounded: "{rounded.sharp}"
  lane-band-lead:
    backgroundColor: "{colors.primaryFog}"
    rounded: "{rounded.sharp}"
  lane-label-divider:
    backgroundColor: "{colors.borderHairline}"
  stage-node:
    backgroundColor: "{colors.paperWhite}"
    rounded: "{rounded.sm}"
    width: 240px
    height: 72px
  stage-node-two-line:
    height: 88px
  stage-node-stroke:
    backgroundColor: "{colors.borderHairline}"
  stage-node-lead:
    backgroundColor: "{colors.paperWhite}"
    rounded: "{rounded.sm}"
  stage-node-lead-stroke:
    backgroundColor: "{colors.primary}"
  stage-node-key:
    backgroundColor: "{colors.paperWhite}"
    rounded: "{rounded.sm}"
  stage-node-key-stroke:
    backgroundColor: "{colors.accent}"
  card:
    backgroundColor: "{colors.surfaceMuted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 24px
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

# Poster / Swimlane Flow（日本語）

## Overview

- poster（説明に使う自己完結の 1 枚絵）のうち、**スイムレーン形式の処理フロー** を描くためのレイアウト別リファレンス。誰が・何を・どの順で行うかを、役割レーン × 工程列の直交グリッドで示す。業務フロー・承認フロー・システム間連携の手順に使う。
- **このファイルだけで完結する。** poster 系の design tokens はフロントマターに埋め込み済み。汎用の `references/poster/general/DESIGN.md` を併せて読む必要はない。
- 想定読者: 図 1 枚を渡されて単独で読む日本語話者の技術メンバー・意思決定者。口頭補足なしで手順を追えることを求める。
- 思想ベース: [デジタル庁デザインシステム (DADS)](https://design.digital.go.jp/dads/foundations/typography/) の Typography 規範に準拠。宣言の書体を使い、weight は N(400) と B(700) の 2 階層。最小は 16px。行間は 1.5-1.7。letter-spacing は 0 または 0.02em。イタリックは禁止。サイズスケールは Major Third (1.25) で展開する。base 17px から 21 / 27 / 33 / 52 / 65 とし、14 / 16 も使う。
- レイアウト固有のパラメータは、フロントマターの拡張の `composition` にまとめる。対象は、グリッドの取り方・レーン数と工程列数・レーン帯の塗り分け・主要な流れの規則。[google-labs-code/design.md](https://github.com/google-labs-code/design.md) 仕様に置き場が無いため、レイアウト別リファレンス共通の置き場とする。
- 役割の区別が要らず順序だけを追う題材は、このレイアウトでは扱わない。スイムレーンに当てはまらない題材も同じ。どちらも、汎用の `references/poster/general/DESIGN.md` で組み立てる。

### この定義の扱い

- 元データは front matter の YAML とする。書式は [Google DESIGN.md 仕様](https://github.com/google-labs-code/design.md)（alpha）に従う。本文の値は YAML の写しで、食い違ったら YAML を正とする
- 文字: `components.text-<段>` が `typography.<段>`（書体・大きさ・太さ・行間・字間の組）と文字色（`textColor`）を組にする。1 セルのコンポーネント（badge）でも文字は `text-badge` 側に置く
- 面: `components.<部品>` の `backgroundColor`（塗り）・`rounded`・`padding`・`width` / `height` / `size`
- 描線の色: 線だけのコンポーネントは、自身の `backgroundColor`。対象は `divider-*` / `arrow-*` / `lane-label-divider`。塗りと描線を持つコンポーネントは、`<コンポーネント>-stroke` コンポーネントの `backgroundColor`。対象は `panel` / `stage-node` / `stage-node-lead` / `stage-node-key`
- 拡張の `components.<コンポーネント>.strokeColor` は style 側の写し。本体と食い違ったら、本体を正とする。本体とは、`<コンポーネント>-stroke` と線コンポーネントの `backgroundColor`
- 仕様に置き場の無い値は、`$extensions` の `pecotv` の下（以下「拡張」）に置く。text セルの必須ベースは、拡張の `textCellBaseStyle`。画面寸法は `canvas`。レイアウトのパラメータは `composition`。線幅は `stroke`。コンポーネントごとの値は、拡張の `components.<コンポーネント>`（仕様側と同名）に置く。値は strokeColor / strokeWidth / dashed / endArrow / endFill / align。ほかに verticalAlign / paddingX / paddingY / description / intent 等
- 角丸: `rounded` は実半径 px の尺度。draw.io での書き方は拡張の `rounded.<段>`
- 余白: `spacing.base` と `spacing.ladder-<値>`（8px ladder の 9 段）

## レイアウト規範

- **直交グリッドに載せる。** 横軸を工程列、縦軸を役割レーンとし、1 ノードは必ず 1 レーン × 1 工程列の交点に置く。工程列の x とレーンの y は全ノードで共有し、グリッドから外れた位置に置かない。
- **レーン帯を全幅の背景矩形として敷く。** レーン帯（`components.lane-band`）は、レーンラベル列も含めた全幅で塗る。`surfaceMuted`（`lane-band`）と `paperWhite`（`lane-band-paper`）を交互に塗る。レーンの境界に罫線を引かず、塗り分けだけで区切る。
- **主役レーンを 1 本だけ外す。** 図の焦点になるレーン（処理の中核を担う役割）だけ `primaryFog`（`lane-band-lead`）に塗り、交互塗りの規則から外す。主役レーンの識別は **この塗りとレーンラベルの文字色 `primary`** で行い、帯の高さでは表さない。帯の高さは収容するノードの高さと余白で決まるため、レーンごとに異なってよい。
- **レーンラベルは左端の固定幅列に置く。** 幅 176px 前後の列を取り、`body` Bold の役割名を縦中央に置く。主役レーンのラベルだけ文字色を `primary` にする。ラベル列とノード領域は `lane-label-divider`（破線 hairline の縦線）1 本で分ける。
- **工程列見出しはレーン帯の外に置く。** 各列の上に `text-caption-label`（14px Bold・textMuted）で置く。「① 注文の受付」のように連番を付ける。見出し行とレーン帯の間に、hairline の水平罫線を全幅で通す。
- **ノードの幅を揃え、高さは 2 段に収める。** 幅は全ノード同一（240）。高さは **補足行 1 行 = 72（`stage-node`）/ 2 行 = 88（`stage-node-two-line`）の 2 段のみ** とする。工程名（`body` Bold）+ 補足行（`caption`、textMuted）2 行までに収める。この 2 段以外の高さを作らない。
- **罫線色でレーンの主従を示す。** 主役レーンの中で図の要となる 1 ノードを、`stage-node-key`（accent 3px 罫線）にする。補足行は accent Bold にする（1 図 1 ノード）。主役レーン内の残りのノードは `stage-node-lead`（`primary` hairline 罫線）。主役レーン外のノードは `stage-node`（`borderHairline` hairline 罫線）を使う。
- **主要な流れと工程送りを線種で分ける。** レーンをまたぐ受け渡しを `arrow-emphasis`（accent 3px・classic）で引く。これを 1 系統の主要な流れとして、図を縦断させる。同一レーン内で右へ送る線は、`arrow-default`（textMuted 1px・open）に下げる。主要な流れが複数系統になるなら、系統を 1 本に絞れるところまで題材を狭める。
- **エッジラベルは矢印に載せない。** 独立した text セルとして線の脇に置く。主要な流れのラベルは 14px Bold の accent。工程送りのラベルは `text-caption-label`。
- **空いた交点は注記に使う。** ノードが無いレーン × 工程の空白は、注記テキスト（`body`・textMuted）の置き場として使ってよい。注記では、そのレーンで何が起きないか、誰が関与しないかを述べる。
- **ヘッダは 4 点セットで組む。** eyebrow バッジ（`components.badge`）+ h1 のタイトル + `primary` 3px の全幅罫線 + リード文。リード文（`text-body`）は、レーン数と工程数を明示する。
- レーンは 3〜6、工程列は 3〜5。上限を超えるとノードが小さくなり、補足行が入らない。

## Colors

- `primary` (#4f46e5): 主色。タイトル下の太罫線、eyebrow バッジ、主役レーンのラベル文字色、主役レーン内ノードの罫線（hairline）。
- `primaryFog` (#EEF2FF): 主役レーンの帯色。
- `accent` (#c2410c): 強調 1 点用。主要な流れの矢印とそのラベル、要のノードの罫線と補足行。
- `ink` (#111418): 本文文字色（pure black を避けた near-black）。
- `textMuted` (#6B7280): 工程列見出し・ノードの補足行・注記・工程送りの矢印。
- `paperWhite` (#FFFFFF): 紙地・ノードの塗り・交互塗りの片方。
- `surfaceMuted` (#F3F4F6): 交互塗りのもう片方。
- `borderHairline` (#C7CBD1): 標準罫線色・レーンラベル列の破線。

色は 1 枚あたり 4-5 色に抑える。配色表にない純赤・純緑など追加禁止。レーンごとに色を割り当てない（レーンの区別は交互塗りと位置で足りる）。

コントラスト比は、白文字 `paperWhite` との組で見る。`badge` の primary 地は 6.29:1。`badge-accent` の accent 地は 5.18:1 で、どちらも WCAG AA（通常の文字 4.5:1）を満たす。

## Typography

- font-family: 段の `fontFamily` の値。宣言が決まっているときは、`fonts.body`、`eastAsian`（`body` に無ければ）、末尾の `sans-serif` の順に並べる。例は `Test Sans, Test Sans JP, sans-serif`。英文だけの書体の並びは禁止。
- スケール: Major Third (1.25) / base 17px から ×1.25 で展開し四捨五入で整数化。14 / 17 / 21 / 27 / 33 / 52 / 65 px の 7 階層。
- weight: N(400) / B(700) の 2 階層のみ（DADS 準拠）。中間ウェイト 500/600 禁止。
- line-height: 1.4 / 1.5 / 1.7 のいずれか。本文 17px 以下は 1.7 を使う。
- letter-spacing: 0 または 0.02em のみ。マイナス値（詰め）禁止（日本語の組版禁則）。
- イタリック禁止（DADS。日本語の可読性が下がるため）。
- UPPERCASE 化は欧文要素のみに限定。日本語にケース概念なし。
- 最小フォントサイズ 16px。14px は `caption` / `badge` のみ例外。`caption` は注釈・補助情報（`text-caption`、Regular）を含む。さらに、工程列見出し・ノード内の補足行・エッジラベルといったラベル用途（`text-caption-label`、Bold）も含む。本文・見出しを 14px にすることは認めない。

## Layout & Spacing

- 8px base ladder: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128（`spacing.ladder4` 〜 `spacing.ladder128`）。**外周マージンと、ヘッダ・工程列見出しまわりのブロック間隔** はこの ladder から選ぶ（実例: 外周 48、工程列見出しの罫線とレーン帯の間 8）。
- **レーン帯の高さ・帯内の上下余白・工程列の x 間隔・ノードの寸法は ladder には載せない。** 収容する内容で決まるため、**8 の倍数** であればよい。実例は次のとおり。帯高 152 / 168 / 184 / 200。帯内の上下余白 40 / 48 / 56。列 x 間隔 320。ノード 240×72 と 240×88。
- 工程列の x 間隔は全列で同一にする。帯内の上下余白は 1 本のレーンの中で上下同値にする。

## Elevation & Depth

- 影なし、3D 効果なし、グラデーション禁止。
- opacity プロパティ完全禁止（CMYK 変換時の色濁り、PDF flatten の色シフトを避ける）。
- 階層は **トーン段階の純色** で表現する: paperWhite → surfaceMuted → primaryFog の 3 段、または ink ↔ textMuted の文字色対比。レーン帯とノードのトーン差だけで前後関係を作る。

## Shapes

- 角丸: `sharp` (0) / `sm` (4) / `pill` (999) の 3 段階。中間値（2 / 6 / 8 / 12 / 16）禁止。段階の数値は **実半径 px** の規定であり、draw.io の `arcSize` 属性値の字面ではない。
- draw.io では次の書き方で表す（拡張の `rounded.sharp` / `rounded.sm` / `rounded.pill`）。`arcSize` は `absoluteArcSize=1` を付けると直径相当（実半径 = `arcSize` ÷ 2）、付けないと短辺に対する % 解釈になるため、値をそのまま px 半径として読まない。
  - `sharp`: `rounded=0`（レーン帯・罫線）
  - `sm`（実半径 4px）: `rounded=1;absoluteArcSize=1;arcSize=8`（工程ノード）
  - `pill`: `rounded=1;arcSize=50`（% 指定。短辺の半分 = 半円。eyebrow バッジ）
- 線幅: `hairline` (1px) / `bold` (3px) の 2 段階（拡張の `stroke`）。中間値（2, 4, 5）禁止。

## Components

draw.io の個別シェイプ・テキスト・矢印に対応する **UI primitive** 群。

### Text primitives

- `text-display` / `text-hero`: 主役数値用（52 / 65px Bold、line 1.4、letter 0）
- `text-h1` / `text-h2` / `text-h3`: 見出し階層（33 / 27 / 21px Bold、line 1.5、letter 0.02em）
- `text-body`: 本文・工程名・レーンラベル 17px（line 1.7、letter 0.02em。工程名とレーンラベルは Bold）
- `text-caption`: 注釈・補助情報 14px Regular、textMuted
- `text-caption-label`: 工程列見出し・ノード内の補足行・エッジラベルなどラベル用途の 14px Bold、textMuted
- `text-mono`: コード・識別子用 monospace（`typography.mono`。17px Regular、line 1.5、letter 0）

draw.io 上では、拡張の `textCellBaseStyle` を全 text セルの **必須ベース** とする。`textCellBaseStyle` の値は次のとおり。

```text
style="text;html=1;whiteSpace=wrap;align=left;verticalAlign=top;strokeColor=none;fillColor=none;fontFamily=..."
```

`whiteSpace=wrap` を欠くと、セル幅を超えるテキストが折り返されず、横にはみ出す。そのため必ず入れる。HTML 値は `<font style="font-size:Xpx;color:#hex;line-height:Y;letter-spacing:Z;">` 形式。

### Lane primitives

- `lane-band`: レーン 1 本の背景帯（全幅・塗りのみ・罫線なし）。塗りは `lane-band`（surfaceMuted）/ `lane-band-paper`（paperWhite）/ `lane-band-lead`（primaryFog、主役レーン）
- `lane-label-divider`: レーンラベル列とノード領域を分ける破線の縦罫（全レーンを貫いて 1 本）
- `stage-node`: 主役レーン外の工程ノード（paperWhite + borderHairline の hairline 罫線、rounded sm）。幅 240、高さ 72（補足行 1 行）/ 88（2 行、`stage-node-two-line`）。罫線の色は `stage-node-stroke`
- `stage-node-lead`: 主役レーン内の通常ノード（paperWhite + primary の hairline 罫線、rounded sm）。寸法は `stage-node` と同じ。罫線の色は `stage-node-lead-stroke`
- `stage-node-key`: 要のノード（paperWhite + accent 3px 罫線、rounded sm）。1 図 1 ノード。罫線の色は `stage-node-key-stroke`

### Containers

- `card`: surfaceMuted 薄塗りカード（rounded sm 4px、padding 24px）
- `panel`: paperWhite + hairline 罫線パネル（rounded sm 4px、padding 24px、strokeWidth 1px）。罫線の色は `panel-stroke`

### Badges

- `badge`: primary 塗り + paperWhite caption、pill 形（rounded 999）、paddingX 16 / paddingY 4
- `badge-accent`: accent 塗り版
- `text-badge`: badge の文字（caption の 14px Bold、paperWhite）

### Dividers

- `divider-h`: 水平 hairline 罫線（borderHairline 1px、工程列見出しの下）
- `divider-h-strong`: 水平 太罫線（ink 3px）
- `divider-v`: 垂直 hairline 罫線

### Arrows

- `arrow-default`: textMuted 1px、open arrowhead（同一レーン内の工程送り）
- `arrow-emphasis`: accent 3px、filled arrowhead（レーンをまたぐ受け渡し = 主要な流れ）
- `arrow-reference`: borderHairline 1px、dashed、open arrowhead（参照関係）

`arrow-emphasis` は、本数ではなく **系統数** で制限する。読者が最初に辿る主要な流れが 1 系統であれば、レーンや工程をまたいで何本連ねてもよい。互いに無関係な複数系統を同時に accent で描くと、主要な流れが埋もれる。そのため、1 図 1 系統に絞る。

矢印の接続点は明示する。線がノードの角を回らずグリッドに沿うよう、次の 3 通りに分ける。

- 同一レーン内の送り: `edgeStyle=none` + `exitX=1;exitY=0.5` → `entryX=0;entryY=0.5`（右辺から左辺）
- レーンをまたぎ、工程列は同じ: `edgeStyle=none` + 上下辺で結ぶ。下のレーンへ送るなら `exitX=0.5;exitY=1` → `entryX=0.5;entryY=0`。上のレーンへ戻すなら `exitX=0.5;exitY=0` → `entryX=0.5;entryY=1`
- レーンと工程列の両方が変わる: `edgeStyle=orthogonalEdgeStyle` にして直交で回す（`edgeStyle=none` のままだと斜線がグリッドを横切る）

エッジラベルは矢印に載せず、独立した text セルで置く。線の強弱と色・weight を一致させる。`arrow-default` に添えるラベルは `text-caption-label`（14px textMuted Bold）。`arrow-emphasis` に添えるラベルは、同じ 14px Bold で色を accent に差し替える。

### Icons

- アイコンは **full bounding box** で描画されるため、同サイズのフォントより視覚的に約 1.4 倍大きく見える。隣接テキストの **font-size × 0.7-0.85（cap-height 相当）** をサイズの目安にする:
  - caption (14px) の隣 → icon 10-12px
  - body (17px) の隣 → icon 12-14px
  - h3 (21px) の隣 → icon 14-16px
  - h2 (27px) の隣 → icon 18-20px
  - h1 (33px) の隣 → icon 24px
- 目安のうち、body / h3 / h2 の隣に置く既定値は、次の `size`。`icon-symbol-body`（12px）/ `icon-symbol-h3`（16px）/ `icon-symbol-h2`（20px）。
- `icon-symbol`: ink（`icon-symbol-muted` は textMuted）の単色。レーンラベル脇・工程列見出し・status の意味補強用。
- `icon-accent`: accent 単色。1 図 1 ヶ所までの最重要シンボル。
- 多色塗り・グラデーション・隣接テキストより大きいサイズは禁止。

## Sample Diagrams

`references/poster/swimlane-flow/samples/` に、このレイアウトの組み方を示したサンプルがある。作成前に読み、レイアウト規範がどう組まれているかを読み取ること。

- `swimlane-flow.drawio`: レーン 5 × 工程列 4、主役レーン 1 本・要ノード 1 個・主要な流れ 1 系統の構成

```bash
ls references/poster/swimlane-flow/samples/
```

## Do's and Don'ts

### 必ず守る

- font-family は段の `fontFamily` の値全体を全 text セルに必ず指定（英文だけの書体の並びは禁止）
- weight は N(400) / B(700) の 2 階層のみ
- letter-spacing は 0 または 0.02em のみ。マイナス値禁止
- line-height は 1.4 / 1.5 / 1.7 のいずれか
- 最小フォントサイズ 16px（caption / badge の 14px のみ例外。ラベル用途の 14px Bold は `text-caption-label`）
- 外周マージンとヘッダまわりのブロック間隔は 8px ladder（4 / 8 / 16 / 24 / 32 / 48 / 64 / 96 / 128）から選ぶ
- レーン帯の高さ・帯内の上下余白・工程列の x 間隔・ノードの寸法は 8 の倍数にする
- 角丸は実半径 sharp(0) / sm(4) / pill(999) のみ（draw.io 上の書き方は Shapes 節を参照）
- 線幅は hairline(1) / bold(3) のみ
- 全エッジに `<mxGeometry relative="1" as="geometry"/>` を含める
- HTML 属性値はダブルクォート（`&quot;`）
- text セルは `style="text;html=1;whiteSpace=wrap;..."` を必須。`whiteSpace=wrap` を欠くと折り返されず横にはみ出す
- 工程ノードの幅を全ノード同一（240）にし、高さは 72（補足行 1 行）/ 88（2 行）の 2 段に収める
- 工程列の x とレーンの y を全ノードで共有する
- 主要な流れは 1 系統に絞り、accent はその系統と要ノードだけに使う

### 避ける

- 外周マージン・ヘッダまわりの間隔に ladder 外の半端な数値（margin=18 / spacing=22 等）を使う
- 帯高・帯内余白・列 x 間隔・ノード寸法に 8 の倍数でない値（height=150 / width=244 等）を使う
- 帯の高さを主役レーンの識別に使う（識別は `primaryFog` の塗りとラベル文字色 `primary`）
- opacity プロパティでの elevation 表現
- 影・グラデーション・3D 効果
- イタリック / 日本語の UPPERCASE 化
- 中間ウェイト（500 / 600）
- マイナス letter-spacing
- 配色表にない純赤・純緑の追加
- レーンごとに色を割り当てる（区別は交互塗りと位置で足りる）
- レーン境界に罫線を引く（塗り分けで区切る）
- グリッドから外れた位置へのノード配置
- アイコンの多色塗り・グラデーション・48px 以上の大型化
