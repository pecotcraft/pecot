#!/usr/bin/env bash
set -euo pipefail

# actionlint の版と sha256。版を上げるときは、この 3 行と .pre-commit-config.yaml の rev を直す。
# sha256 は公式 Release の actionlint_<版>_checksums.txt から取る。
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256_AMD64=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
ACTIONLINT_SHA256_ARM64=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
ACTIONLINT_BIN_DIR=/usr/local/bin

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

# actionlint は公式 Release を取り、リポに書いた sha256 と一致したときだけ入れる。
case "$(uname -m)" in
  x86_64) actionlint_arch=amd64; actionlint_sha256=$ACTIONLINT_SHA256_AMD64 ;;
  aarch64 | arm64) actionlint_arch=arm64; actionlint_sha256=$ACTIONLINT_SHA256_ARM64 ;;
  *) echo "actionlint: 未対応のアーキテクチャです: $(uname -m)" >&2; exit 1 ;;
esac
actionlint_tmp="$(mktemp -d)"
actionlint_tgz="actionlint_${ACTIONLINT_VERSION}_linux_${actionlint_arch}.tar.gz"
curl -fsSL -o "$actionlint_tmp/$actionlint_tgz" \
  "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${actionlint_tgz}"
echo "${actionlint_sha256}  $actionlint_tmp/$actionlint_tgz" | sha256sum -c -
tar -xzf "$actionlint_tmp/$actionlint_tgz" -C "$actionlint_tmp" actionlint
sudo install -m 0755 "$actionlint_tmp/actionlint" "$ACTIONLINT_BIN_DIR/actionlint"
rm -rf "$actionlint_tmp"

bash "$(dirname "${BASH_SOURCE[0]}")/install-git-hooks.sh"
bash "$(dirname "${BASH_SOURCE[0]}")/../../setup.sh"
