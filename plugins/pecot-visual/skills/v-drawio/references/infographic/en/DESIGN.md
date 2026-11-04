---
version: alpha
name: Presentation Infographic (English)
description: スライドに縮小なしで載せる、英語ラベルの draw.io 図の体裁の定義。書体はテーマの宣言に従い、色と文字サイズはこの定義の値を使う。
colors:
  primary: "#4f46e5"
  on-primary: "#ffffff"
  ink: "#111827"
  body: "#1f2937"
  mute: "#6b7280"
  hairline: "#e5e7eb"
  hairline-strong: "#9ca3af"
  canvas: "#ffffff"
  canvas-soft: "#fafafa"
  info: "#1d4ed8"
  info-soft: "#dbeafe"
  alert: "#f97316"
  alert-soft: "#ffedd5"
  alert-deep: "#9a3412"
typography:
  heading:
    fontFamily: "sans-serif"
    fontSize: 16px
    fontWeight: 700
    lineHeight: 22px
    letterSpacing: 0px
  heading-sm:
    fontFamily: "sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 18px
    letterSpacing: 0px
  body:
    fontFamily: "sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
    letterSpacing: 0px
  body-sm:
    fontFamily: "sans-serif"
    fontSize: 10px
    fontWeight: 400
    lineHeight: 14px
    letterSpacing: 0px
  label:
    fontFamily: "sans-serif"
    fontSize: 9px
    fontWeight: 400
    lineHeight: 9px
    letterSpacing: 0px
rounded:
  sm: 4px
  md: 8px
  full: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
components:
  node:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.heading-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  node-detail:
    textColor: "{colors.body}"
    typography: "{typography.body}"
  node-focus:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.heading-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  node-info:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
    typography: "{typography.heading-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  node-alert:
    backgroundColor: "{colors.alert-soft}"
    textColor: "{colors.alert-deep}"
    typography: "{typography.heading-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.xs} {spacing.sm}"
  group:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.mute}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm}"
  edge:
    backgroundColor: "{colors.hairline-strong}"
  edge-info:
    backgroundColor: "{colors.info}"
  edge-alert:
    backgroundColor: "{colors.alert}"
  divider:
    backgroundColor: "{colors.hairline}"
  edge-label:
    textColor: "{colors.body}"
    typography: "{typography.body-sm}"
  tag:
    backgroundColor: "{colors.info-soft}"
    textColor: "{colors.info}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0px {spacing.xs}"
  table-header:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.mute}"
    typography: "{typography.body-sm}"
    padding: "{spacing.xs} {spacing.sm}"
  table-cell:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.body}"
    typography: "{typography.body}"
    padding: "{spacing.xs} {spacing.sm}"
$extensions:
  pecotv:
    components:
      node:
        borderColor: "{colors.hairline-strong}"
      node-info:
        borderColor: "{colors.info}"
      node-alert:
        borderColor: "{colors.alert}"
      group:
        borderColor: "{colors.hairline}"
      table-cell:
        borderColor: "{colors.hairline}"
---

<!-- markdownlint-disable MD013 -->

## Overview

At scale 1, a diagram sits on a slide. It sits next to the slide's own text and should read as part of the slide. That means one indigo accent, one ink color, and one body gray. It uses the same two faces at the same five sizes. Everything else is removed: no shadows, no gradients, no decorative icons.

The diagram has one quiet layer and two loud ones. White nodes with a gray hairline carry most of the content. One indigo node marks where the argument converges. Orange marks harm or impact; blue marks the fixed or safe state. A diagram that uses all three loud colors on many nodes has lost its point.

**Key Characteristics:**

- Faces come from the theme declaration. Colors and sizes are the values in this file.
- Flat: `shadow=0` everywhere; depth comes from fill, not elevation.
- At most one `node-focus` per diagram.

## Colors

- **Primary** (`{colors.primary}` — `#4f46e5`): The fill of `node-focus`.
- **Ink** (`{colors.ink}` — `#111827`): Node titles on light fills.
- **On Primary** (`{colors.on-primary}` — `#ffffff`): Every string on a primary fill. A primary node carries no gray or colored text.
- **Body** (`{colors.body}` — `#1f2937`): Body text. Node details, edge labels, table cells.
- **Mute** (`{colors.mute}` — `#6b7280`): Group labels and table headers only.
- **Hairline** (`{colors.hairline}` — `#e5e7eb`): Group and table borders.
- **Hairline Strong** (`{colors.hairline-strong}` — `#9ca3af`): Node borders and ordinary arrows.
- **Canvas** (`{colors.canvas}` — `#ffffff`): Node fill.
- **Canvas Soft** (`{colors.canvas-soft}` — `#fafafa`): Group and table-header fill.
- **Info** (`{colors.info}` — `#1d4ed8`) / **Info Soft** (`{colors.info-soft}` — `#dbeafe`): Blue. The fixed or safe state, and tags.
- **Alert** (`{colors.alert}` — `#f97316`): Orange accent. Harm, impact, or the not-yet-fixed state. **Alert Soft** (`{colors.alert-soft}` — `#ffedd5`) is its soft fill. **Alert Deep** (`{colors.alert-deep}` — `#9a3412`) is its deep tone. Text on the soft fill uses the deep tone.

## Typography

The theme declaration names the faces. `fonts.body` is for Latin letters and digits, and `eastAsian` is for Japanese. Every text cell sets `fontFamily` as `<body face>, <eastAsian face>, sans-serif`. `sans-serif` is always last. For example, `fontFamily=Test Sans, Test Sans JP, sans-serif`. With no declaration, it is `sans-serif` alone. It also sets a `fontSize` from the table. draw.io draws an unset cell in Helvetica at 11 px. Code, commands, and version numbers use the same faces.

| Token | Size | Weight | Use |
|---|---|---|---|
| `{typography.heading}` | 16px | 700 | A heading over the whole diagram, when the slide has none. |
| `{typography.heading-sm}` | 13px | 600 | Node titles. |
| `{typography.body}` | 12px | 400 | Node details and table cells. |
| `{typography.body-sm}` | 10px | 400 | Edge labels, group labels, table headers. |
| `{typography.label}` | 9px | 400 | Tags. |

Weight is written per token. `fontStyle=1` is 700 (heading). `fontStyle=0` is 400 (body, body-sm, label). A node title is 600, which `fontStyle` cannot express. Set `html=1` and wrap the title in `<span style="font-weight:600">` inside the value. Keep `fontStyle=0` on the cell.

## Layout

- Base unit: 4 px. Gaps between nodes run from `{spacing.md}` 16 px to `{spacing.lg}` 24 px. Padding inside a node is `{spacing.xs}` 8 px by `{spacing.sm}` 12 px.
- Alignment: nodes in a row share a height. Nodes in a column share a width.

## Elevation & Depth

None. Every cell sets `shadow=0`. A group is separated from the canvas by its soft fill and hairline. The focal node is separated by its primary fill.

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.sm}` | 4px: `rounded=1;absoluteArcSize=1;arcSize=8` | Table corners. |
| `{rounded.md}` | 8px: `rounded=1;absoluteArcSize=1;arcSize=16` | Nodes and groups. |
| `{rounded.full}` | pill: `rounded=1;absoluteArcSize=1;arcSize=` the cell height or more | Tags. |

`arcSize` is the corner's diameter, twice the radius.

Arrows are 1.5 px orthogonal connectors with a block end arrow.

## Components

- `node` — White fill and a `{colors.hairline-strong}` 1 px border. The title is in `{typography.heading-sm}` `{colors.ink}`. A second line, when needed, is `node-detail`.
- `node-detail` — The detail line inside a node: `{typography.body}` in `{colors.body}`.
- `node-focus` — Primary fill, white title, no border, no detail line. The one element the argument converges on.
- `node-info` / `node-alert` — Soft fill with a 1 px border in the full tone. The title is in the full or deep tone.
- `group` — Soft fill and hairline border around related nodes. Its label sits at the top left in `{typography.body-sm}` `{colors.mute}`.
- **`edge`** / **`edge-info`** / **`edge-alert`** — The connector. An arrow entering a `node-info` or `node-alert` takes that node's full tone; every other arrow is `edge`.
- `edge-label` — Sits beside the line, not on it, in `{typography.body-sm}` `{colors.body}`.
- `divider` — The 1 px hairline around groups and between table cells.
- `tag` — A pill in `{typography.label}` for a short status word on a node.
- **`table-header`** / **`table-cell`** — A grid of hairline-bordered cells when the content is a matrix.

## Do's and Don'ts

### Do

- Use the colors, faces, sizes, and weights as given in the tokens.
- Keep most nodes plain `node`. Save indigo, blue, and orange for the few nodes that carry the point.

### Don't

- Don't put gray or small text on `node-focus`.
- Don't use shadows, gradients, or a second border color on one node.
- Don't use a size or weight that is not in the typography table.
