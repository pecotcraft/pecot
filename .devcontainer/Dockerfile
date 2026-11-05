# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/devcontainers/base:ubuntu26.04

LABEL org.opencontainers.image.source=https://github.com/pecotcraft/pecot

# fontconfig は明示的に入れる。base:ubuntu イメージには fc-cache の無い版もある。
# libreoffice-impress/calc・poppler-utils: PPTX→PDF 変換と PDF テキスト抽出のため (#165)。
# pptx 変換自体は impress だけで足りる (draw は impress の Depends)。calc が要るのは
# evidence-xlsx 系 E2E のため。--no-install-recommends は付けない。
# pdftotext が日本語を抽出するのに必要な poppler-data は、recommends 経由でしか入らない。
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y shellcheck tmux fontconfig fonts-noto-cjk fonts-inter fonts-crosextra-carlito libreoffice-impress libreoffice-calc poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# PPTX が要求するフォントのファミリー名と、コンテナの deb 実体は一致しない。
# "Noto Sans JP" の deb 配布は "Noto Sans CJK JP" のみで、
# theme 既定の Calibri Light は metric alias の対象外になる。
# alias が無いと fontconfig は WenQuanYi Zen Hei へフォールバックする。
# その結果、LibreOffice の PDF 変換でフォントが崩れる (#728)。
# 日本語は weak alias だと LibreOffice が Noto Sans CJK SC (簡体字グリフ) を選ぶ。
# そのため strong prefer にする。
RUN <<'EOF'
set -e
cat >/etc/fonts/local.conf <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="strong">
    <family>Noto Sans JP</family>
    <prefer><family>Noto Sans CJK JP</family></prefer>
  </alias>
  <alias binding="strong">
    <family>Calibri Light</family>
    <prefer><family>Carlito</family></prefer>
  </alias>
</fontconfig>
XML
fc-cache -f
EOF
