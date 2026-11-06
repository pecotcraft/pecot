#!/usr/bin/env bash
# パッケージマネージャガード (#806 / #1217 / #52) の確認関数。source して使う。違反は呼び出し側の fail() で報告する。

# package.json の宣言を「<形>|<name>|<version>|<onFail>|<engines の node 以外のキー（,区切り）>|<packageManager>」の 1 行で返す。
# <形> は none / object / array。配列は corepack が無視するため、array のまま返して呼び出し側で fail にする。
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
# 自己呼び出し（$npm_execpath、pnpm / npm など、npm-run-all 系、`npm:` 指定）を語単位で拾う (#414)。
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
# release/release-groups.mjs の workspaceMembers と同じ規則。変えるときは両方をそろえる。
list_workspace_members() {
    awk '
        /^[^[:space:]#]/ { in_pkgs = ($1 == "packages:") ? 1 : 0; next }
        in_pkgs && /^[[:space:]]*-[[:space:]]*/ {
            sub(/^[[:space:]]*-[[:space:]]*/, ""); print
        }
    ' "$1"
}

# pnpm-workspace.yaml のトップレベルキーの値を YAML として読んで返す（文字列化。無ければ空）。
# $1=パス $2=キー。yaml は対象ファイルの dir、次に本ファイルの dir から解決する（fixture 用）。
PM_GUARD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
read_workspace_setting() {
    node -e '
const fs=require("fs"),path=require("path");
const file=path.resolve(process.argv[1]);
const {parse}=require(require.resolve("yaml",{paths:[path.dirname(file),process.argv[3]]}));
const v=(parse(fs.readFileSync(file,"utf8"))||{})[process.argv[2]];
process.stdout.write(v==null?"":String(v))' "$1" "$2" "$PM_GUARD_LIB_DIR"
}

# $1=repo root $2=ラベル $3...=パス（repo root からの相対）。
# root の pnpm-workspace.yaml のメンバーのうち、各パス以下の package.json の scripts を確認する。
check_scripts_pm_free_under() {
    local root="$1" label="$2" rel pkg violation prefix member found
    shift 2
    local -a members
    mapfile -t members < <(list_workspace_members "$root/pnpm-workspace.yaml")
    for prefix in "$@"; do
        found=0
        for member in "${members[@]}"; do
            case "$member" in
                "$prefix" | "$prefix"/*) ;;
                *) continue ;;
            esac
            found=1
            rel="$member"
            pkg="$root/$rel/package.json"
            if [ ! -f "$pkg" ]; then
                fail "$label メンバーの package.json が不在: $pkg"
                continue
            fi
            while IFS= read -r violation; do
                fail "scripts が package manager を呼んでいる（node / bin だけで完結させる）: $pkg の $violation"
            done < <(list_pm_invoking_scripts "$pkg")
        done
        [ "$found" -eq 1 ] || fail "$label のメンバーが root の pnpm-workspace.yaml に無い: $prefix"
    done
}

# $1=plugin ルート $2=ラベル。その plugin 以下のメンバーの scripts を確認する。
check_plugin_scripts_pm_free() {
    local plugin_root="$1" label="$2" repo_root
    repo_root="$(cd "$plugin_root/../.." && pwd)"
    check_scripts_pm_free_under "$repo_root" "$label" "plugins/$(basename "$plugin_root")"
}

# ---- package.json の宣言の確認 (#52) ----
# pnpm-root: repo root と 3 プラグインのルート。onFail: download と packageManager を置く。
# pnpm-member: それ以外のメンバー。onFail: error を置く。
# exempt: audit の canary と fixture。
# engines は node だけにする。

PM_GUARD_PNPM_PLUGINS=(pecot-visual pecot-tools pecot-workflow)

# hook が渡す GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE を外して git を呼ぶ。
pm_guard_git() {
    (unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE; git "$@")
}

# $1=repo root。追跡している package.json を、repo root からの相対パスで返す。
# git の作業ツリーなら git ls-files、そうでなければ（fixture）find で拾う。
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

# $1=repo root $2=package.json の相対パス。種類（pnpm-root / pnpm-member / exempt）を返す。分けられなければ空。
classify_package_json() {
    local root="$1" rel="$2" plugin sub member
    case "$rel" in
        plugins/pecot-visual/scripts/release/audit-canary/package.json | \
        plugins/pecot-visual/scripts/release/tests/fixtures/*/package.json | \
        plugins/pecot-visual/cli/tests/fixtures/themes/*/package.json)
            echo exempt; return ;;
        package.json)
            echo pnpm-root; return ;;
    esac
    for plugin in "${PM_GUARD_PNPM_PLUGINS[@]}"; do
        [ "$rel" != "plugins/$plugin/package.json" ] || { echo pnpm-root; return; }
    done
    [ -f "$root/pnpm-workspace.yaml" ] || return 0
    sub="${rel%/package.json}"
    while IFS= read -r member; do
        [ "$member" != "$sub" ] || { echo pnpm-member; return; }
    done < <(list_workspace_members "$root/pnpm-workspace.yaml")
}

# $1=repo root。全 package.json と .npmrc の宣言を確かめる。違反は呼び出し側の fail() で報告する。
check_package_manager_declarations() {
    local root="$1" rel kind pkg line shape name version on_fail extra pm_field expected_pm
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        pkg="$root/$rel"
        kind="$(classify_package_json "$root" "$rel")"
        if [ -z "$kind" ]; then
            fail "package.json の種類を分けられない（pnpm のルート・pnpm のメンバー・宣言しない例外のどれにも当たらない）: $rel"
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
