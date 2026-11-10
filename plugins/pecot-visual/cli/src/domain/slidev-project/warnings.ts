// 利用者に伝える警告の文言。create・convert が同じ文言を使う。

export const LINK_COLOR_OMITTED_WARNING
  = 'pptx.linkColor is omitted, so links are not converted in the PPTX (no hyperlinks are added); '
    + 'to convert links, set pptx.linkColor in pecot-theme.json to 6 hex digits'

export const EAST_ASIAN_FONT_OMITTED_WARNING
  = 'pptx.eastAsianFont is omitted, so no East Asian font is written to the PPTX; '
    + 'to set the Japanese font, set pptx.eastAsianFont in pecot-theme.json to a font name'
