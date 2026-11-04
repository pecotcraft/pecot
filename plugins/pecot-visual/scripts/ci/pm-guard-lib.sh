#!/usr/bin/env bash
# パッケージマネージャガード (#806 / #1217) の確認関数。source して使う（単体では何もしない）。
# pecotv の check-pm-guard.sh と pecot-tools の install.sh が共有する。
# 確認の処理は本ファイルだけに置き、複製しない。呼び出し側は失敗の集計（fail）を自分で持つ。

# package.json の engines.<key> を読む。存在しなければ空文字。
read_engine() {
    node -e 'const fs=require("fs");const e=(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).engines)||{};process.stdout.write(String(e[process.argv[2]]??""))' "$1" "$2"
}

# package.json の devEngines.packageManager を「<name>:<onFail>」で返す。宣言が無ければ ":"。
# 仕様上、単体オブジェクトと配列のどちらも有効。配列は npm の要素を採る。
# npm 以外の要素を含む配列は、pnpm 等も許容してしまい止められないため、混在を示す "mixed:" を返す。
read_dev_engine_pm() {
    node -e '
const fs=require("fs");
const d=(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).devEngines)||{};
const pm=d.packageManager;
let p={};
if(Array.isArray(pm)){
  const npm=pm.find((e)=>e&&e.name==="npm");
  p=pm.some((e)=>!e||e.name!=="npm")?{name:"mixed"}:(npm||{});
}else if(pm&&typeof pm==="object"){p=pm}
process.stdout.write(`${p.name??""}:${p.onFail??""}`)' "$1"
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

# 同 dir の .npmrc に engine-strict=true 行があるか。
has_engine_strict() {
    [ -f "$1/.npmrc" ] && grep -qx 'engine-strict=true' "$1/.npmrc"
}

# 同 dir の .npmrc に書かれた pnpm 固有の設定行を返す (#1217)。pnpm 11 以降は .npmrc から
# これらを読まず警告も出さないため、書いても何も起きない。pnpm の設定は pnpm-workspace.yaml に置く。
list_pnpm_only_npmrc_keys() {
    [ -f "$1/.npmrc" ] || return 0
    grep -E '^[[:space:]]*(node-linker|shared-workspace-lockfile|shamefully-hoist|hoist|hoist-pattern|public-hoist-pattern|auto-install-peers|strict-peer-dependencies|only-built-dependencies|enable-pre-post-scripts|link-workspace-packages|store-dir|virtual-store-dir|package-import-method)(\[\])?[[:space:]]*=' "$1/.npmrc" || true
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
