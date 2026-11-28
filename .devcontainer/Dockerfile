# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/devcontainers/base:ubuntu26.04@sha256:e15941f70f26542ef9b0ef4bb64f88b8ecdfe8c3372e730ab6e405792805e742

LABEL org.opencontainers.image.source=https://github.com/pecotcraft/pecot

# libreoffice・poppler-utils は PPTX→PDF 変換と PDF の抽出のため (#165)。
# parallel（GNU parallel）は、bats の --jobs で @test を並べて動かすため (#844)。
# --no-install-recommends を付けない。日本語の抽出に要る poppler-data は recommends でしか入らない。
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y shellcheck tmux fontconfig fonts-noto-cjk fonts-inter fonts-crosextra-carlito libreoffice-impress libreoffice-calc poppler-utils parallel \
  && rm -rf /var/lib/apt/lists/*

# PPTX のフォント名を deb の実体へ寄せる。無いと PDF 変換でフォントが崩れる (#728)。
# weak alias だと LibreOffice が Noto Sans CJK SC (簡体字) を選ぶため strong にする。
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

# Claude Code はネイティブ版を vscode の持ち物で入れる。
# root の持ち物だと、セッション中の自動更新が権限で止まる (#134)。
USER vscode
RUN bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash' \
  && /home/vscode/.local/bin/claude --version
USER root
ENV PATH="/home/vscode/.local/bin:${PATH}"
