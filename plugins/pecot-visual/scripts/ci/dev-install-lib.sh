# shellcheck shell=bash
# 開発環境の依存導入 (#1297)。install.sh / run-lint.sh / run-tests.sh / publish-mcp-dist.sh が source する。
#
# pnpm 12 は、リンク越しのワークスペースメンバー（libs/text-rules）があると、
# `pnpm install --frozen-lockfile` を誤って失敗させる。
# 直前に `pnpm install` した lock でも「local dependency ... is outdated」と判定する。
# pnpm 11.28.3 では通り、リンクを実ディレクトリにすると 12 でも通る。
# 一方 `pnpm install --lockfile-only` は正しく判定でき、lock が最新なら差分を出さない。
# そこで開発環境では、lock が package.json と合っているかを --lockfile-only で確かめる。
# 合っていれば `--prefer-frozen-lockfile` で導入する。prefer-frozen は lock を満たせないと lock を書き換えて成功するため、
# 導入のあとにもう一度 lock を退避分と比べる。
# 利用者の bootstrap（bin/_lib.sh）が install するミラーは実ディレクトリなので、frozen のまま変えない。
#
# この lib は `set` しない（source 元のオプションを尊重）。
#
# pecotv_dev_install <plugin root> <pnpm 起動コマンド>
#   手順は次のとおり。
#   1. pnpm-lock.yaml を TMPDIR 側の一時ファイルへ退避する。lock に触る区間は INT / TERM でも戻す。
#   2. `install --lockfile-only --prefer-offline` を実行する。registry に届かない環境でも metadata の取得で待たせない。
#   3. lock が 1 バイトでも変わったら、退避分で元に戻して 1 を返す。
#   4. 変わらなければ `install --prefer-frozen-lockfile --ignore-scripts` を実行する。失敗したら、lock を元に戻し、6 と同じ npm ci で依存を戻してから、その終了コードを返す。
#   5. 導入のあとに lock をもう一度退避分と比べる。違えば lock を元に戻し、npm ci で依存を戻してから 1 を返す。
#   6. リポジトリ root から `npm --prefix libs/text-rules ci` を実行する。失敗したら、その終了コードを返す。
#      開発環境では node がリンクを実体の libs/text-rules に解決する。
#      tsc と text-rules の依存は libs/text-rules/node_modules から読まれる。
#      pnpm はリンク先をメンバーとして整理するため、導入し直すと、その node_modules を削る。
#      そこで、最後に npm で戻す。
#   7. assets/slidev の prepare（build.mjs）を、`pnpm --filter @pecot/slidev-assets-dev run prepare` で実行する。PECOTV_SKIP_SLIDEV_PREPARE=1 のときは行わない。
#
# 手順 4 で pnpm が導入を始めたあとの失敗（4・5）は、libs/text-rules/node_modules が欠けたまま残る。
# そこで、元の終了コードを返す前に npm ci で戻す。戻す処理が失敗しても、元の終了コードを返す。
# 手順 3 までの失敗は、pnpm が配置し直していないので、npm ci を呼ばない。
# INT / TERM を受けたときは、npm を実行せずに lock だけ戻して終わる。
#
# lifecycle を pnpm の導入の中で動かさない理由。
# 導入し直す回の pnpm は、libs/text-rules/node_modules を削ってから lifecycle を動かす。
# このとき assets/slidev の prepare は、text-rules の build に要る typescript7 を解決できない。
# その結果、導入ごと失敗する。
# そこで導入には --ignore-scripts を付ける。npm で戻した後に、必要な lifecycle を明示して実行する。
# ワークスペースで導入時に動く lifecycle は assets/slidev の prepare（build.mjs）だけ。
# 依存の install scripts は permissions の build: false で、実行しない。
#
# 6 の npm ci は、env に関係なく行う。pnpm の導入が libs/text-rules/node_modules を削るため、
# どの nx の run でも、この関数の最後に戻す。libs/text-rules:install は何もしない target で、順序だけを与える。
# PECOTV_SKIP_SLIDEV_PREPARE=1 は nx の install target の command だけが渡す。
# nx では text-rules:build のあとの build-slidev が同じ build を担う。
# 手動の run-tests.sh / run-lint.sh / publish-mcp-dist.sh は、この env を渡さないので 7 まで行う。

# pnpm の導入を始めたか（1 のとき、libs/text-rules/node_modules が欠けている恐れがある）。
_PECOTV_PNPM_INSTALL_STARTED=0

# lock を退避分へ戻す。$1 = lock、$2 = 退避ファイル。
_pecotv_restore_lock() {
    cp "$2" "$1"
}

# pnpm が配置し直した libs/text-rules の依存を、npm ci で戻す。$1 = リポジトリ root。
# 失敗しても呼び出し元の終了コードを隠さないよう、警告だけ出して 0 を返す。
_pecotv_restore_text_rules_deps() {
    echo "==> npm --prefix libs/text-rules ci (cwd=$1)"
    ( cd "$1" && npm --prefix libs/text-rules ci ) || echo "WARN: libs/text-rules の依存を戻せませんでした。npm --prefix libs/text-rules ci を実行してください。" >&2
    return 0
}

# lock の確認と導入。lock に触る区間で、呼び出し元が trap を張っている。
# $1 = プラグイン root、$2 = pnpm 起動コマンド、$3 = lock、$4 = 退避ファイル。
_pecotv_dev_install_locked() {
    local root="$1" pnpm="$2" lock="$3" backup="$4" rc=0

    # `$pnpm` は意図的に quote しない（"corepack pnpm" を 2 トークンに分割するため）
    echo "==> $pnpm install --lockfile-only --prefer-offline (cwd=$root)"
    # shellcheck disable=SC2086
    ( cd "$root" && $pnpm install --lockfile-only --prefer-offline ) || rc=$?
    if [ "$rc" -ne 0 ]; then
        _pecotv_restore_lock "$lock" "$backup"
        return "$rc"
    fi

    if ! cmp -s "$backup" "$lock"; then
        _pecotv_restore_lock "$lock" "$backup"
        echo "ERROR: pnpm-lock.yaml が package.json とずれています。pnpm install で作り直して commit してください。" >&2
        return 1
    fi

    echo "==> $pnpm install --prefer-frozen-lockfile --ignore-scripts (cwd=$root)"
    _PECOTV_PNPM_INSTALL_STARTED=1
    # shellcheck disable=SC2086
    ( cd "$root" && $pnpm install --prefer-frozen-lockfile --ignore-scripts ) || rc=$?
    if [ "$rc" -ne 0 ]; then
        _pecotv_restore_lock "$lock" "$backup"
        return "$rc"
    fi

    # prefer-frozen は lock を満たせないと lock を書き換えて成功する。commit 済みの lock と違えば止める。
    if ! cmp -s "$backup" "$lock"; then
        _pecotv_restore_lock "$lock" "$backup"
        echo "ERROR: pnpm install が pnpm-lock.yaml を書き換えました。pnpm install で作り直して commit してください。" >&2
        return 1
    fi
}

pecotv_dev_install() {
    local root="$1" pnpm="$2" lock backup rc=0 repo_root saved_traps restore_cmd
    # plugins/pecot-visual の 2 つ上がリポジトリ root。
    repo_root="$(cd "$root/../.." && pwd)" || return 1
    lock="$root/pnpm-lock.yaml"
    backup="$(mktemp -t pnpm-lock.backup.XXXXXX)" || return 1
    cp "$lock" "$backup" || { rm -f "$backup"; return 1; }

    # 呼び出し元の trap は、lock に触る区間のあとで元に戻す。
    saved_traps="$(trap -p INT TERM)"
    restore_cmd="$(printf '_pecotv_restore_lock %q %q; rm -f %q' "$lock" "$backup" "$backup")"
    # shellcheck disable=SC2064
    trap "$restore_cmd; exit 130" INT
    # shellcheck disable=SC2064
    trap "$restore_cmd; exit 143" TERM

    _PECOTV_PNPM_INSTALL_STARTED=0
    _pecotv_dev_install_locked "$root" "$pnpm" "$lock" "$backup" || rc=$?

    rm -f "$backup"
    trap - INT TERM
    if [ -n "$saved_traps" ]; then eval "$saved_traps"; fi
    if [ "$rc" -ne 0 ]; then
        if [ "$_PECOTV_PNPM_INSTALL_STARTED" = "1" ]; then _pecotv_restore_text_rules_deps "$repo_root"; fi
        return "$rc"
    fi

    echo "==> npm --prefix libs/text-rules ci (cwd=$repo_root)"
    ( cd "$repo_root" && npm --prefix libs/text-rules ci ) || return $?

    if [ "${PECOTV_SKIP_SLIDEV_PREPARE:-0}" = "1" ]; then
        return 0
    fi

    echo "==> $pnpm --filter @pecot/slidev-assets-dev run prepare (cwd=$root)"
    # shellcheck disable=SC2086
    ( cd "$root" && $pnpm --filter @pecot/slidev-assets-dev run prepare )
}
