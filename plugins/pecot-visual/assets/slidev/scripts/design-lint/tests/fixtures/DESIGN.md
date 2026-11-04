---
version: alpha
name: sample
description: lint-design.mjs の退行テストに使う、汎用の最小の体裁の定義。
colors:
  text-primary: "#111827"
  surface: "#ffffff"
  primary: "{colors.text-primary}"
typography:
  title:
    fontFamily: "sans-serif"
    fontSize: 24px
    fontWeight: 700
rounded:
  card: 6px
components:
  title:
    textColor: "{colors.text-primary}"
    typography: "{typography.title}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
---

## Overview

一色のインクと一点の差し色で組む。
