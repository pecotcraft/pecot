// 利用者に伝える警告の文言。create・convert が同じ文言を使う。

export const LINK_COLOR_OMITTED_WARNING
  = 'pptx.linkColor を省いたため、PPTX ではリンクは変換されません（ハイパーリンクが付きません）。'
    + 'リンクを変換するには pecot-theme.json の pptx.linkColor に 6 桁の 16 進で書いてください'

export const EAST_ASIAN_FONT_OMITTED_WARNING
  = 'pptx.eastAsianFont を省いたため、PPTX では東アジア書体を書き込みません。'
    + '日本語の書体を揃えるには pecot-theme.json の pptx.eastAsianFont に書体名を書いてください'
