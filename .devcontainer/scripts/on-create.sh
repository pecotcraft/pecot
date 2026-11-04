#!/usr/bin/env bash
set -euo pipefail

sudo chown vscode:vscode /workspaces /home/vscode/.claude /commandhistory
touch /commandhistory/.bash_history /commandhistory/.zsh_history

if ! grep -q 'HISTFILE=/commandhistory' /home/vscode/.bashrc; then
  cat <<'EOF' >> /home/vscode/.bashrc

# devcontainer: persist bash history across rebuilds
export HISTFILE=/commandhistory/.bash_history
export PROMPT_COMMAND="history -a${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
history -c; history -r 2>/dev/null || true
EOF
fi

if ! grep -q 'HISTFILE=/commandhistory' /home/vscode/.zshrc; then
  cat <<'EOF' >> /home/vscode/.zshrc

# devcontainer: persist zsh history across rebuilds
export HISTFILE=/commandhistory/.zsh_history
fc -P 2>/dev/null; fc -R "$HISTFILE" 2>/dev/null || true
EOF
fi
