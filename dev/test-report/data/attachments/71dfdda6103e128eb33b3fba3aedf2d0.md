# pptx 比較: clip-in-text-a.pptx → clip-in-text-b.pptx

- before: `/tmp/bats-run-3zdoR9/file/1/clip-in-text-a.pptx`
- after: `/tmp/bats-run-3zdoR9/file/1/clip-in-text-b.pptx`

## 判定

結果: FAIL（機械判定 5 項目のうち 1 項目が FAIL）

- [FAIL] before の `a:t` が after に全て残る: 消失 1 件
- [PASS] テキスト一致 sp の `xfrm` 差が無い: xfrm 差 0 件
- [PASS] 対応する slide でテキストあり sp が減らない: 減少した slide 0 件
- [PASS] 対応する slide で `p:pic` が減らない: 減少した slide 0 件
- [PASS] before の埋め込み typeface が after に全て残る: 消失 typeface 0 件

### 要判断（事実のみ）

- slide 数: 2 → 2（対応 2 / before 固有 0 / after 固有 0）。対応の付かない slide は機械判定の対象外
- `detectPreviewDivergence` 合計: 1 → 1
- ファイルサイズ比: ×1.000
- after で増えた `a:t`: 1 件
- `p:timing` 合計: 0 → 0 / `a:highlight` 合計: 0 → 0
- ラスタ media の相違: 0 件
- after だけの typeface: (なし)
- 埋め込み書体 part（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0

## 全体

| 指標 | before | after | 差 |
|---|---:|---:|---:|
| ファイルサイズ | 0.00 MB (3,704 B) | 0.00 MB (3,705 B) | +1 B |
| パート数 | 11 | 11 | 0 |
| slide 数 | 2 | 2 | 0 |
| `p:sp` 合計 | 5 | 5 | 0 |
| うちテキストあり sp | 4 | 4 | 0 |
| `p:pic` 合計 | 2 | 2 | 0 |
| `a:t` 合計 | 4 | 4 | 0 |
| `detectPreviewDivergence` 合計 | 1 | 1 | 0 |
| `p:timing` を持つ slide | 0 | 0 | 0 |
| `a:highlight` 合計 | 0 | 0 | 0 |
| media 件数 (png/svg) | 2 (1/1) | 2 (1/1) | 0 |
| media 合計バイト | 0.00 MB (408 B) | 0.00 MB (408 B) | 0 B |
| 埋め込み書体 part | 3 | 3 | 0 |
| 埋め込み書体 バイト | 0.00 MB (62 B) | 0.00 MB (62 B) | 0 B |

- `p:timing` を持つ slide: before (なし) / after (なし)
- `a:highlight` を持つ slide: before (なし) / after (なし)

## 埋め込み書体

slot の突合先は `ppt/_rels/presentation.xml.rels` で解決した part の sha256。
part 名は run ごとに変わり得るため、名前ではなく sha256 で対応を見る。

| 側 | typeface | slot → 解決先 sha256 (先頭 12) / part / bytes |
|---|---|---|
| before | Sample Sans | regular → f9ffaa629f55 / `201314.fntdata` / 22 B<br>bold → 074f1102f674 / `201315.fntdata` / 19 B |
| before | Inter | regular → ed044522294e / `201316.fntdata` / 21 B |
| after | Sample Sans | regular → f9ffaa629f55 / `201314.fntdata` / 22 B<br>bold → 074f1102f674 / `201315.fntdata` / 19 B |
| after | Inter | regular → ed044522294e / `201316.fntdata` / 21 B |

- before にあって after に無い typeface: (なし)
- after で増えた typeface: (なし)
- 書体 part の突合（sha256 多重集合）: 一致 3 / before 固有 0 / after 固有 0

## slide 別

`a:t` 欠落 / 追加 / xfrm 差 は before → after で対応付けた結果の件数。

| slide | `p:sp` | `p:pic` | テキストあり sp | divergence | `p:timing` / `a:highlight` | 欠落/追加/xfrm差 | 備考 |
|---:|---|---|---|---|---|---|---|
| 1 | 3 → 3 | 1 → 1 | 2 → 2 | 1 → 1 | 0 → 0 / 0 → 0 | 1 / 1 / 0 |  |

（差分のある slide のみ 1 行を表示。対応する全 2 slide は `--all` で表示）

## before にあって after に無い `a:t` 文字列

合計 1 件（1 種）。

| slide | テキスト | before 件数 | after 件数 |
|---:|---|---:|---:|
| 1 | `clip_aaaaaaaaa` | 1 | 0 |

## after で増えた `a:t` 文字列

合計 1 件（1 種）。

| slide | テキスト | before 件数 | after 件数 |
|---:|---|---:|---:|
| 1 | `clip_bbbbbbbbb` | 0 | 1 |

## テキスト一致 sp の `xfrm` 差

なし。

## パート差分

正規化: ルート要素の xmlns 属性順、`p:cNvPr` の `id` / `name`、SVG `clipPath` 乱数 id、
`docProps/core.xml` の日時、font 種別 Relationship の Id / Target と `p:embeddedFontLst` の
`r:id`（解決先 part の sha256 へ置換）。
正規化後の集計から埋め込み書体 part とラスタ media を除く。
前者は sha256 多重集合で、後者は「ラスタ media の相違」で別に扱う。

- 生の sha256 相違: 1 件（一致 10 / before 固有 0 / after 固有 0）
- 正規化後の相違: 1 件（一致 6 / before 固有 0 / after 固有 0）

生の相違（区分別）:

| 区分 | 件数 | 例 |
|---|---:|---|
| `ppt/slides/slide*.xml` | 1 | `slide1.xml` |

正規化後の相違（区分別）:

| 区分 | 件数 | 例 |
|---|---:|---|
| `ppt/slides/slide*.xml` | 1 | `slide1.xml` |

- `ppt/slides/slide1.xml`: 1399 B → 1399 B


## ラスタ media の相違

同一テンプレの再変換でも、プリレンダした端末テキスト画像の字形描画揺れで相違し得る。
実回帰との判別ができないため除外リストを持たず、事実として列挙する。

- ラスタ media の相違: 0 件（一致 1 / before 固有 0 / after 固有 0）

