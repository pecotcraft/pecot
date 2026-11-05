#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
# fontconfig は明示的に入れる。base:ubuntu イメージには fc-cache の無い版もある。
# libreoffice-impress/calc・poppler-utils: PPTX→PDF 変換と PDF テキスト抽出のため (#165)。
# pptx 変換自体は impress だけで足りる (draw は impress の Depends)。calc が要るのは
# evidence-xlsx 系 E2E のため。--no-install-recommends は付けない。
# pdftotext が日本語を抽出するのに必要な poppler-data は、recommends 経由でしか入らない。
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y shellcheck fontconfig fonts-noto-cjk fonts-inter fonts-crosextra-carlito libreoffice-impress libreoffice-calc poppler-utils

# PPTX が要求するフォントのファミリー名と、コンテナの deb 実体は一致しない。
# "Noto Sans JP" の deb 配布は "Noto Sans CJK JP" のみで、
# theme 既定の Calibri Light は metric alias の対象外になる。
# alias が無いと fontconfig は WenQuanYi Zen Hei へフォールバックする。
# その結果、LibreOffice の PDF 変換でフォントが崩れる (#728)。
# 日本語は weak alias だと LibreOffice が Noto Sans CJK SC (簡体字グリフ) を選ぶ。
# そのため strong prefer にする。
sudo tee /etc/fonts/local.conf > /dev/null <<'EOF'
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
EOF
sudo fc-cache -f

bash "$(dirname "${BASH_SOURCE[0]}")/install-git-hooks.sh"
bash "$(dirname "${BASH_SOURCE[0]}")/../../setup.sh"
(cd "$(dirname "${BASH_SOURCE[0]}")/../../plugins/pecot-visual/cli" && npx --no-install playwright install --with-deps chromium)
