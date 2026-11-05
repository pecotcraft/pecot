#!/usr/bin/env bash
# パッケージマネージャガード (#806 / #1217 / #52) の確認関数。source して使う（単体では何もしない）。
# pecot-visual の check-pm-guard.sh と、pecot-tools・pecot-workflow の check-pm-scripts.sh が共有する。
# 確認の処理は本ファイルだけに置き、複製しない。呼び出し側は失敗の集計（fail）を自分で持つ。

# package.json の宣言を「<形>|<name>|<version>|<onFail>|<engines の node 以外のキー（,区切り）>|<packageManager>」の 1 行で返す。
# <形> は devEngines.packageManager が無ければ none、オブジェクトなら object、配列なら array。
# 配列は corepack が読まずに無視するため、宣言として認めない（array のまま返して呼び出し側で fail にする）。
# engines が無い・オブジェクトでないときは、node 以外のキーを空として扱う。
read_pm_declaration() {
    node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const pm=(j.devEngines||{}).packageManager;
const shape=Array.isArray(pm)?"array":(pm&&typeof pm==="object")?"object":"none";
const p=shape==="object"?pm:{};
const e=(j.engines&&typeof j.engines==="object"&&!Array.isArray(j.engines))?j.engines:{};
const extra=Object.keys(e).filter((k)=>k!=="node").join(",");
process.stdout.write([shape,p.name??"",p.version??"",p.onFail??"",extra,j.packageManager??""].join("|"))' "$1"
}

# package.json の scripts のうち package manager を呼ぶものを「<script 名>: <値>」で 1 行ずつ返す (#1217)。
# scripts から `node "$npm_execpath" run ...` 等で自己呼び出しすると、動かなくなる起動方法がある。
# pnpm 12 が packageManager の版を @pnpm/exe（単一実行ファイル）で起動すると、$npm_execpath は ELF を指す。
# corepack 経由では、子プロセスの PATH に pnpm が立たない (#414)。
# どの起動方法でも動くよう、scripts は node / bin だけで完結させる。
# 値を空白とシェル演算子で語に割り、次のいずれかの語を違反とする。
# 語単位なので、パスの一部や `@scope/npm-foo` / `pnpm-lock.yaml` のような別名は拾わない。
#   - $npm_execpath。
#   - package manager の実行名（pnpm / npm / npx / pnpx / yarn / corepack / bun / bunx）。
#   - 内部で package manager を呼ぶ実行名（npm-run-all / run-s / run-p）。
#     ./ ../ / 始まりの語は、パスの末尾で比べる。
#   - `npm:build` のような concurrently の package manager 指定（npm: pnpm: yarn: bun:）。
list_pm_invoking_scripts() {
    node -e '
const fs=require("fs");
const s=(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).scripts)||{};
const PM=new Set(["pnpm","npm","npx","pnpx","yarn","corepack","bun","bunx","npm-run-all","run-s","run-p","npm-cli.js","npx-cli.js"]);
const hit=(raw)=>{
  const w=raw.replace(/^["\x27]+|["\x27]+$/g,"");
  if(/^\$\{?npm_execpath\}?$/.test(w))return true;
  if(/^(npm|pnpm|yarn|bun):\S/.test(w))return true;
  const name=/^\.{0,2}\//.test(w)?w.split("/").pop():w;
  return PM.has(name);
};
for(const[k,v]of Object.entries(s)){
  if(String(v).split(/[\s;&|()<>`]+/).some(hit))console.log(`${k}: ${v}`);
}' "$1"
}

# pnpm-workspace.yaml の `packages:` ブロックのメンバーだけを相対パスで返す。
# `packages:` 行から次のトップレベル（非インデント）キーまでの `- ...` のみ拾う。
# 将来 catalog: / catalogs: 等の別リストキーが増えても巻き込まない（find 全拾いも同理由で禁止）。
# 同じ解析を、release/release-groups.mjs の workspaceMembers も別実装で持つ。
# 解析の規則を変えるときは、両方をそろえる。
list_workspace_members() {
    awk '
        /^[^[:space:]#]/ { in_pkgs = ($1 == "packages:") ? 1 : 0; next }
        in_pkgs && /^[[:space:]]*-[[:space:]]*/ {
            sub(/^[[:space:]]*-[[:space:]]*/, ""); print
        }
    ' "$1"
}

# pnpm-workspace.yaml のトップレベルキーの値を YAML として読んで返す（文字列化。無ければ空）。
# 行完全一致の grep は末尾コメントやクォートで外れるため、依存の yaml パーサで読む。
# $1=pnpm-workspace.yaml のパス $2=キー。
# yaml は対象ファイルの dir、次に本ファイルの dir から解決する。
# install 済みが前提で、fixture のように node_modules の無い dir のファイルも読めるようにしている。
PM_GUARD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read_workspace_setting() {
    node -e '
const fs=require("fs"),path=require("path");
const file=path.resolve(process.argv[1]);
const {parse}=require(require.resolve("yaml",{paths:[path.dirname(file),process.argv[3]]}));
const v=(parse(fs.readFileSync(file,"utf8"))||{})[process.argv[2]];
process.stdout.write(v==null?"":String(v))' "$1" "$2" "$PM_GUARD_LIB_DIR"
}

# $1=plugin ルート $2=ラベル。その plugin の package.json（root + pnpm-workspace.yaml のメンバー）で
# scripts が package manager を呼んでいないことを確認する。違反は呼び出し側の fail() で報告する。
check_plugin_scripts_pm_free() {
    local root="$1" label="$2" rel pkg violation
    local -a members
    mapfile -t members < <(list_workspace_members "$root/pnpm-workspace.yaml")
    for rel in "." "${members[@]}"; do
        pkg="$root/$rel/package.json"
        if [ ! -f "$pkg" ]; then
            fail "$label メンバーの package.json が不在: $pkg"
            continue
        fi
        while IFS= read -r violation; do
            fail "scripts が package manager を呼んでいる（node / bin だけで完結させる）: $pkg の $violation"
        done < <(list_pm_invoking_scripts "$pkg")
    done
}

# ---- package.json の宣言の確認 (#52) ----
# 違うパッケージマネージャは、devEngines.packageManager で止める。
# 宣言は場所ごとに 3 種類で、宣言しない例外がある。
#   npm         = ルートと libs/text-rules。{ name: npm, onFail: error } を置く。
#   pnpm-root   = 3 プラグインのルート。{ name: pnpm, version: <完全一致>, onFail: download } を置く。
#                 同じ版の packageManager も置く。
#   pnpm-member = プラグインの pnpm-workspace.yaml のメンバー。{ name: pnpm, onFail: error } を置く。
#   exempt      = 宣言しない。監査の canary と、package を模したテストの fixture が当たる。
# engines は node だけにする。

PM_GUARD_PNPM_PLUGINS=(pecot-visual pecot-tools pecot-workflow)

# git を、hook が渡す GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE を外して呼ぶ。
pm_guard_git() {
    env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git "$@"
}

# $1=repo root。追跡している package.json を、repo root からの相対パスで返す。
# git の作業ツリーなら git ls-files、そうでなければ（テストの fixture）find で拾う。
# git hook の下では GIT_DIR などが渡り、git -C の先でも本体の index を読む。そのため pm_guard_git で外す。
list_package_jsons() {
    local root="$1" top
    top="$(pm_guard_git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$top" ] && [ "$(cd "$root" && pwd -P)" = "$(cd "$top" && pwd -P)" ]; then
        pm_guard_git -C "$root" ls-files '*package.json'
    else
        (cd "$root" && find . -name package.json -not -path '*/node_modules/*' | sed 's|^\./||' | sort)
    fi
}

# $1=repo root。追跡している .npmrc を、repo root からの相対パスで返す。
list_npmrc_files() {
    local root="$1" top
    top="$(pm_guard_git -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$top" ] && [ "$(cd "$root" && pwd -P)" = "$(cd "$top" && pwd -P)" ]; then
        pm_guard_git -C "$root" ls-files '*.npmrc'
    else
        (cd "$root" && find . -name .npmrc -not -path '*/node_modules/*' | sed 's|^\./||' | sort)
    fi
}

# $1=repo root $2=package.json の相対パス。種類（npm / pnpm-root / pnpm-member / exempt）を返す。分けられなければ空。
classify_package_json() {
    local root="$1" rel="$2" plugin sub member
    case "$rel" in
        plugins/pecot-visual/scripts/release/audit-canary/package.json | \
        plugins/pecot-visual/scripts/release/tests/fixtures/*/package.json | \
        plugins/pecot-visual/cli/tests/fixtures/themes/*/package.json)
            echo exempt; return ;;
        package.json | libs/text-rules/package.json)
            echo npm; return ;;
    esac
    for plugin in "${PM_GUARD_PNPM_PLUGINS[@]}"; do
        [ "$rel" != "plugins/$plugin/package.json" ] || { echo pnpm-root; return; }
        case "$rel" in "plugins/$plugin/"*) ;; *) continue ;; esac
        sub="${rel#plugins/"$plugin"/}"
        sub="${sub%/package.json}"
        [ -f "$root/plugins/$plugin/pnpm-workspace.yaml" ] || continue
        while IFS= read -r member; do
            [ "$member" != "$sub" ] || { echo pnpm-member; return; }
        done < <(list_workspace_members "$root/plugins/$plugin/pnpm-workspace.yaml")
    done
}

# $1=repo root。全 package.json と .npmrc の宣言を確かめる。違反は呼び出し側の fail() で報告する。
check_package_manager_declarations() {
    local root="$1" rel kind pkg line shape name version on_fail extra pm_field expected_pm
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        pkg="$root/$rel"
        kind="$(classify_package_json "$root" "$rel")"
        if [ -z "$kind" ]; then
            fail "package.json の種類を分けられない（npm・pnpm のルート・pnpm のメンバー・宣言しない例外のどれにも当たらない）: $rel"
            continue
        fi
        [ "$kind" != exempt ] || continue
        line="$(read_pm_declaration "$pkg")"
        IFS='|' read -r shape name version on_fail extra pm_field <<<"$line"
        if [ "$shape" = array ]; then
            fail "devEngines.packageManager が配列（corepack は配列を読まずに無視する。オブジェクトにする）: $rel"
            continue
        fi
        if [ "$shape" = none ]; then
            fail "devEngines.packageManager の宣言が無い: $rel"
            continue
        fi
        [ -z "$extra" ] || fail "engines に node 以外のキーがある（$extra）: $rel"
        case "$kind" in
            npm)
                [ "$name" = npm ] && [ "$on_fail" = error ] && [ -z "$version" ] \
                    || fail "devEngines.packageManager が { name: npm, onFail: error } でない: $rel"
                ;;
            pnpm-root)
                [ "$name" = pnpm ] && [ "$on_fail" = download ] \
                    || fail "devEngines.packageManager が { name: pnpm, version, onFail: download } でない: $rel"
                if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
                    fail "devEngines.packageManager の version が完全一致の semver でない（'$version'）: $rel"
                fi
                expected_pm="pnpm@$version"
                [ "${pm_field%%+*}" = "$expected_pm" ] \
                    || fail "packageManager（'${pm_field%%+*}'）が devEngines.packageManager の版（$expected_pm）とずれている: $rel"
                ;;
            pnpm-member)
                [ "$name" = pnpm ] && [ "$on_fail" = error ] && [ -z "$version" ] \
                    || fail "devEngines.packageManager が { name: pnpm, onFail: error } でない: $rel"
                [ -z "$pm_field" ] || fail "packageManager はプラグインのルートだけに置く（メンバーに置くと corepack がそこで上へたどるのをやめる）: $rel"
                ;;
        esac
    done < <(list_package_jsons "$root")
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        [ "$rel" = ".npmrc" ] || fail ".npmrc はルートの 1 本だけに置く（プラグインの下に置かない）: $rel"
    done < <(list_npmrc_files "$root")
}
