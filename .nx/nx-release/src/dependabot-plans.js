// @ts-check
"use strict";

/**
 * dependabot の PR の commit から version plan を作る（--check は足りているかの確認だけ）。
 * 入力は commit の本文と、その時点の package.json・root の pnpm-lock.yaml を使う。
 * 契約は specs/019-ci-pr-tests/contracts/dependabot-plans.md を参照。
 */

/** @typedef {import("./types").Update} Update */
/** @typedef {import("./types").ParsedCommit} ParsedCommit */
/** @typedef {import("./types").Declaration} Declaration */
/** @typedef {import("./types").Lock} Lock */
/** @typedef {import("./types").Context} Context */
/** @typedef {import("./types").SkipReason} SkipReason */
/** @typedef {import("./types").Resolution} Resolution */
/** @typedef {import("./types").Dep} Dep */
/** @typedef {import("./types").MainOptions} MainOptions */
/** @typedef {import("./types").RootFilter} RootFilter */
/** @typedef {import("./types").Declarations} Declarations */
/** @typedef {import("./types").UvLock} UvLock */
/** @typedef {import("./types").UvDep} UvDep */
/** @typedef {import("./types").UvPackage} UvPackage */
/** @typedef {import("./types").Commit} Commit */
/** @typedef {import("./types").Analysis} Analysis */

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseAllDocuments } = require("yaml");

const GROUP_PATHS = {
  "pecot-workflow": "plugins/pecot-workflow/",
  "pecot-visual": "plugins/pecot-visual/",
  "pecot-tools": "plugins/pecot-tools/",
  "text-rules": "libs/text-rules/",
};
const MAX_LINE_CHARS = 100;
const PLANS_DIR = ".nx/version-plans";
const SHIPPED_SECTIONS = ["dependencies", "optionalDependencies"];
const SECTIONS = [...SHIPPED_SECTIONS, "devDependencies"];
const AUDIT_CANARY = "plugins/pecot-visual/scripts/release/audit-canary/";
const UV_DEV_EXTRAS = /^(dev|test|tests|lint|docs|typing)$/;

/**
 * ファイルが属する release group。tests/ の下と、どの group にも属さない path は null。
 * @param {string} file
 * @returns {string | null}
 */
function groupOf(file) {
  if (/(^|\/)tests\//.test(file) || file.startsWith(AUDIT_CANARY)) return null;
  for (const [group, prefix] of Object.entries(GROUP_PATHS)) {
    if (file.startsWith(prefix)) return group;
  }
  return null;
}

/** @param {string} value */
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * updated-dependencies の塊を、行ごとに読む。行頭の空白があっても読める。
 * @param {string} body
 * @returns {{ name: string, version: string, type: string }[]}
 */
function parseUpdatedDependencies(body) {
  const lines = body.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line === "updated-dependencies:");
  if (start === -1) throw new Error("本文に updated-dependencies: がありません");
  /** @type {Record<string, string>[]} */
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "" || line === "..." || line === "---") break;
    const item = /^- (\S+?): (.*)$/.exec(line);
    const field = /^(\S+?): (.*)$/.exec(line);
    if (item?.[1] !== undefined && item[2] !== undefined) entries.push({ [item[1]]: unquote(item[2]) });
    else if (field?.[1] !== undefined && field[2] !== undefined && entries.length > 0) {
      /** @type {Record<string, string>} */ (entries[entries.length - 1])[field[1]] = unquote(field[2]);
    } else break;
  }
  const updates = entries.map((entry) => {
    const name = entry["dependency-name"];
    const version = entry["dependency-version"];
    const type = entry["dependency-type"];
    if (!name || !version || !type) {
      throw new Error(`updated-dependencies の項目が読めません: ${JSON.stringify(entry)}`);
    }
    return { name, version, type };
  });
  if (updates.length === 0) throw new Error("updated-dependencies に項目がありません");
  return updates;
}

/**
 * @param {string} body
 * @param {string} name
 * @returns {string | null}
 */
function readFromVersion(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`Bumps \\[${escaped}\\]\\([^)]*\\) from (\\S+) to `),
    new RegExp(`Updates \`${escaped}\` from (\\S+) to `),
  ];
  for (const pattern of patterns) {
    const found = pattern.exec(body)?.[1];
    if (found) return found;
  }
  return null;
}

/**
 * dependabot の commit の件名と本文を読む。
 * @param {string} subject
 * @param {string} body
 * @returns {ParsedCommit}
 */
function parseCommit(subject, body) {
  const directory =
    /\bin (\/\S*)(?: \(#\d+\))?$/.exec(subject)?.[1] ??
    /\bin the (\/\S*) directory/.exec(body)?.[1] ??
    /^\W*Bumps the .* group in (\/\S*)/m.exec(body)?.[1] ??
    "/";
  const updates = parseUpdatedDependencies(body).map((update) => ({
    ...update,
    from: readFromVersion(body, update.name),
  }));
  return { directory, updates };
}

/** @type {WeakMap<Lock, Map<string, Set<string>>>} */
const reachMemo = new WeakMap();

/**
 * lock の中で、roots から辿って届く `name@version` の集まり。peer の接尾辞は外す。
 * @param {Lock} lock
 * @param {[string, string][]} roots
 * @returns {Set<string>}
 */
function reachable(lock, roots) {
  const memoKey = JSON.stringify(roots);
  const memo = reachMemo.get(lock) ?? new Map();
  reachMemo.set(lock, memo);
  const cached = memo.get(memoKey);
  if (cached) return cached;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const queue = [];
  /** @param {Record<string, string> | undefined} deps */
  const visit = (deps) => {
    for (const [name, version] of Object.entries(deps ?? {})) {
      // link: は text-rules の group が自分で持ち、pecot-visual へは nx の updateDependents: always で bump が届く
      if (version.startsWith("link:")) continue;
      const key = [`${name}@${version}`, version].find((candidate) => candidate in lock.snapshots);
      if (key !== undefined && !seen.has(key)) {
        seen.add(key);
        queue.push(key);
      }
    }
  };
  visit(Object.fromEntries(roots));
  for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
    const snapshot = lock.snapshots[key];
    visit(snapshot?.dependencies);
    visit(snapshot?.optionalDependencies);
  }
  const result = new Set([...seen].map((key) => key.split("(")[0] ?? key));
  memo.set(memoKey, result);
  return result;
}

/**
 * group の importer の依存を、名前と版の組で返す。
 * @param {Lock} lock
 * @param {string} group
 * @param {RootFilter} pick
 * @returns {[string, string][]}
 */
function lockRoots(lock, group, pick) {
  /** @type {[string, string][]} */
  const roots = [];
  for (const [key, importer] of Object.entries(lock.importers)) {
    if (groupOf(`${key}/`) !== group) continue;
    for (const section of SECTIONS) {
      for (const [name, dep] of Object.entries(importer[section] ?? {})) {
        if (pick(section, name)) roots.push([name, dep.version]);
      }
    }
  }
  return roots;
}

/** @param {string} name */
const normalizeName = (name) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * uv.lock の `[[package]]` から、名前・版・依存だけを読む。TOML の全体は読まない。
 * @param {string} text
 * @returns {UvLock}
 */
function parseUvLock(text) {
  /** @type {UvPackage[]} */
  const packages = [];
  /** @type {UvPackage | null} */
  let pkg = null;
  let section = "other";
  /** @type {UvDep[] | null} */
  let target = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "[[package]]") {
      pkg = { name: "", version: "", project: false, dependencies: [], dev: [], optional: {} };
      packages.push(pkg);
      section = "top";
      target = null;
    } else if (/^\[.*\]$/.test(line)) {
      section = { "[package.dev-dependencies]": "dev", "[package.optional-dependencies]": "optional" }[line] ?? "other";
      target = null;
    } else if (pkg !== null) {
      const array = /^([\w-]+) = \[$/.exec(line);
      const scalar = /^(name|version) = "(.*)"$/.exec(line);
      if (array?.[1] !== undefined) {
        if (section === "top" && array[1] === "dependencies") target = pkg.dependencies;
        else if (section === "dev") target = pkg.dev;
        else if (section === "optional") target = pkg.optional[array[1]] = [];
        else target = null;
      } else if (line === "]") target = null;
      else if (line.startsWith("{") && target !== null) target.push(parseUvDep(line));
      else if (section === "top" && target === null && scalar?.[1] !== undefined) {
        if (scalar[1] === "name") pkg.name = scalar[2] ?? "";
        else pkg.version = scalar[2] ?? "";
      } else if (section === "top" && /^source = \{ (editable|virtual) =/.test(line)) pkg.project = true;
    }
  }
  return { packages };
}

/**
 * @param {string} line uv.lock の依存の 1 行（例: `{ name = "x", version = "1" }`）
 * @returns {UvDep}
 */
function parseUvDep(line) {
  const text = line.replace(/marker = "[^"]*"/, "");
  const extras = /extra = \[([^\]]*)\]/.exec(text)?.[1] ?? "";
  return {
    name: /name = "([^"]+)"/.exec(text)?.[1] ?? "",
    version: /version = "([^"]+)"/.exec(text)?.[1] ?? null,
    extras: [...extras.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""),
  };
}

/**
 * uv.lock の中で、roots から辿って届く `name@version` の集まり。依存先の extra の辺も辿る。
 * @param {UvLock} lock
 * @param {UvDep[]} roots
 * @returns {Set<string>}
 */
function uvReachable(lock, roots) {
  /** @type {Map<string, UvPackage[]>} */
  const byName = new Map();
  for (const pkg of lock.packages) {
    const key = normalizeName(pkg.name);
    byName.set(key, [...(byName.get(key) ?? []), pkg]);
  }
  /** @type {Set<string>} */
  const reached = new Set();
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {[UvPackage, string | null][]} */
  const queue = [];
  /** @param {UvDep[]} deps */
  const visit = (deps) => {
    for (const dep of deps) {
      for (const pkg of byName.get(normalizeName(dep.name)) ?? []) {
        if (dep.version !== null && pkg.version !== dep.version) continue;
        reached.add(`${normalizeName(pkg.name)}@${pkg.version}`);
        for (const extra of [null, ...dep.extras]) {
          const key = `${pkg.name}@${pkg.version}#${extra}`;
          if (!visited.has(key)) {
            visited.add(key);
            queue.push([pkg, extra]);
          }
        }
      }
    }
  };
  visit(roots);
  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const [pkg, extra] = item;
    visit(extra === null ? pkg.dependencies : (pkg.optional[extra] ?? []));
  }
  return reached;
}

/**
 * uv の indirect。プロジェクト自身の本番の依存から届けば対象、dev からだけ届けば「開発用」。
 * @param {Update} update
 * @param {Context} ctx
 * @param {string} group
 * @returns {Resolution}
 */
function resolveUvIndirect(update, ctx, group) {
  if (ctx.uvLock === null) throw new Error(`${ctx.directory}/uv.lock を読めません`);
  const projects = ctx.uvLock.packages.filter((pkg) => pkg.project);
  const extras = projects.flatMap((pkg) => Object.entries(pkg.optional));
  const production = [
    ...projects.flatMap((pkg) => pkg.dependencies),
    ...extras.filter(([name]) => !UV_DEV_EXTRAS.test(name)).flatMap(([, deps]) => deps),
  ];
  const development = [
    ...projects.flatMap((pkg) => pkg.dev),
    ...extras.filter(([name]) => UV_DEV_EXTRAS.test(name)).flatMap(([, deps]) => deps),
  ];
  const target = `${normalizeName(update.name)}@${update.version}`;
  if (uvReachable(ctx.uvLock, production).has(target)) return { groups: [group], reason: null };
  return { groups: [], reason: uvReachable(ctx.uvLock, development).has(target) ? "dev" : "none" };
}

/**
 * @param {Update} update
 * @param {Context} ctx
 * @returns {Resolution}
 */
function resolveDirect(update, ctx) {
  const all = ctx.declarations[update.name] ?? [];
  const changed = all.filter((declaration) => declaration.changed);
  const targets = (changed.length > 0 ? changed : all).filter(
    (declaration) => groupOf(declaration.path) !== null,
  );
  /** @type {Set<string>} */
  const groups = new Set();
  for (const { path: file, section } of targets) {
    const group = groupOf(file);
    if (group === null) continue;
    const shipped =
      SHIPPED_SECTIONS.includes(section) ||
      (group === "pecot-visual" && section === "devDependencies" && ctx.distDeps.has(update.name));
    if (shipped) groups.add(group);
  }
  if (groups.size > 0) return { groups: [...groups], reason: null };
  return { groups: [], reason: targets.length > 0 ? "dev" : "none" };
}

/**
 * @param {Update} update
 * @param {Context} ctx
 * @returns {Resolution}
 */
function resolveIndirect(update, ctx) {
  const { lock } = ctx;
  if (lock === null) return { groups: [], reason: "none" };
  const target = `${update.name}@${update.version}`;
  /** @type {string[]} */
  const groups = [];
  let devOnly = false;
  for (const group of Object.keys(GROUP_PATHS)) {
    const shipped = lockRoots(
      lock,
      group,
      (section, name) =>
        SHIPPED_SECTIONS.includes(section) ||
        (group === "pecot-visual" && section === "devDependencies" && ctx.distDeps.has(name)),
    );
    if (reachable(lock, shipped).has(target)) groups.push(group);
    else if (reachable(lock, lockRoots(lock, group, () => true)).has(target)) devOnly = true;
  }
  if (groups.length > 0) return { groups, reason: null };
  return { groups: [], reason: devOnly ? "dev" : "none" };
}

/**
 * 更新が届く release group を決める。git は呼ばない。
 * @param {Update} update
 * @param {Context} ctx
 * @returns {Resolution}
 */
function resolveGroups(update, ctx) {
  if (ctx.uv) {
    const group = groupOf(`${ctx.directory.replace(/^\//, "")}/`);
    if (group === null) return { groups: [], reason: "none" };
    if (update.type === "direct:development") return { groups: [], reason: "dev" };
    if (update.type === "indirect") return resolveUvIndirect(update, ctx, group);
    return { groups: [group], reason: null };
  }
  return update.type === "indirect" ? resolveIndirect(update, ctx) : resolveDirect(update, ctx);
}

/**
 * plan の中身。本文は 1 行で、100 字を超えるなら件を減らして「ほか N 件」で締める。
 * @param {string} group
 * @param {Dep[]} deps
 * @returns {string}
 */
function renderPlan(group, deps) {
  const items = deps.map((dep) =>
    dep.from ? `${dep.name} ${dep.from} → ${dep.version}` : `${dep.name} → ${dep.version}`,
  );
  /** @param {number} shown */
  const sentence = (shown) => {
    const rest = items.length - shown;
    const parts =
      shown === 0 ? [`${items.length} 件`] : [...items.slice(0, shown), ...(rest > 0 ? [`ほか ${rest} 件`] : [])];
    return `依存を更新した（${parts.join("、")}）。`;
  };
  let shown = items.length;
  while (shown > 0 && [...sentence(shown)].length > MAX_LINE_CHARS) shown -= 1;
  return `---\n${group}: patch\n---\n\n${sentence(shown)}\n`;
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * その commit で変わったファイルの path。root の uv.lock は ruff 用なので、uv は directory 側の uv.lock で判定する。
 * @param {string} cwd
 * @param {string} sha
 * @returns {string[]}
 */
function changedFiles(cwd, sha) {
  return git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha]).split("\n").filter(Boolean);
}

/**
 * @param {string} cwd
 * @param {string} spec
 * @returns {string | null}
 */
function gitShow(cwd, spec) {
  try {
    return git(cwd, ["show", spec]);
  } catch {
    return null;
  }
}

/**
 * base..head の dependabot の commit を古い順に読む。
 * @param {string} cwd
 * @param {string} base 起点の ref
 * @param {string} head 終点の ref
 * @returns {Commit[]}
 */
function readCommits(cwd, base, head) {
  const args = ["log", "--reverse", "--format=%H%x1f%s%x1f%b%x1e", `${base}..${head}`];
  return git(cwd, args)
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha, subject, body };
    })
    .filter((commit) => /^\s*updated-dependencies:\s*$/m.test(commit.body));
}

/**
 * 更新された依存の宣言を、その時点の package.json から集める。
 * @param {string} cwd
 * @param {string} sha
 * @param {ParsedCommit} parsed
 * @returns {Declarations}
 */
function readDeclarations(cwd, sha, parsed) {
  /** @type {Record<string, Declaration[]>} */
  const declarations = {};
  const files = git(cwd, ["ls-tree", "-r", "--name-only", sha])
    .split("\n")
    .filter((file) => /(^|\/)package\.json$/.test(file) && groupOf(file) !== null);
  for (const file of files) {
    const after = JSON.parse(gitShow(cwd, `${sha}:${file}`) ?? "{}");
    const beforeText = gitShow(cwd, `${sha}^:${file}`);
    const before = beforeText === null ? {} : JSON.parse(beforeText);
    for (const { name } of parsed.updates) {
      for (const section of SECTIONS) {
        const spec = after[section]?.[name];
        if (typeof spec !== "string") continue;
        (declarations[name] ??= []).push({ path: file, section, changed: before[section]?.[name] !== spec });
      }
    }
  }
  return declarations;
}

/**
 * indirect の判定に使う lock。読めないときは、plan から抜かずに throw する。
 * @param {string} cwd
 * @param {string} sha
 * @returns {Lock}
 */
function readLock(cwd, sha) {
  const text = gitShow(cwd, `${sha}:pnpm-lock.yaml`);
  if (text === null) throw new Error("pnpm-lock.yaml がありません");
  const parsed = parseAllDocuments(text);
  const error = parsed.flatMap((doc) => doc.errors)[0];
  if (error !== undefined) throw new Error(`pnpm-lock.yaml を parse できません: ${error.message}`);
  const docs = parsed.map((doc) => doc.toJS());
  const main = docs.find((doc) => doc?.settings) ?? docs[docs.length - 1];
  if (!main?.importers) throw new Error("pnpm-lock.yaml に importers がありません");
  return { importers: main.importers, snapshots: main.snapshots ?? {} };
}

/**
 * @param {string} cwd
 * @param {string} sha
 * @param {string} directory
 * @returns {UvLock}
 */
function readUvLock(cwd, sha, directory) {
  const file = path.posix.join(directory, "uv.lock").replace(/^\//, "");
  const text = gitShow(cwd, `${sha}:${file}`);
  if (text === null) throw new Error(`${file} がありません`);
  return parseUvLock(text);
}

/**
 * @param {string} toolsRoot
 * @returns {Promise<Set<string>>}
 */
async function loadDistDepsDefault(toolsRoot) {
  const manifestPath = path.join(toolsRoot, "plugins/pecot-visual/scripts/release/dist-manifest.mjs");
  const url = require("node:url").pathToFileURL(manifestPath);
  const { buildDistManifest } = await import(url.href);
  const manifest = buildDistManifest(path.join(toolsRoot, "plugins/pecot-visual"), "0.0.0", toolsRoot);
  return new Set(Object.keys(manifest.dependencies));
}

/**
 * commit 1 件が届く group と、届かない理由を調べる。
 * @param {string} cwd
 * @param {Commit} commit
 * @param {Set<string>} distDeps
 * @returns {Analysis}
 */
function analyze(cwd, { sha, subject, body }, distDeps) {
  try {
    const parsed = parseCommit(subject, body);
    /** @type {Map<string, Dep[]>} */
    const byGroup = new Map();
    /** @type {SkipReason} */
    let reason = "none";
    const hasIndirect = parsed.updates.some((update) => update.type === "indirect");
    const uv = changedFiles(cwd, sha).includes(path.posix.join(parsed.directory, "uv.lock").replace(/^\//, ""));
    const ctx = {
      directory: parsed.directory,
      uv,
      declarations: readDeclarations(cwd, sha, parsed),
      uvLock: uv && hasIndirect ? readUvLock(cwd, sha, parsed.directory) : null,
      lock: !uv && hasIndirect ? readLock(cwd, sha) : null,
      distDeps,
    };
    for (const update of parsed.updates) {
      const resolution = resolveGroups(update, ctx);
      if (resolution.reason === "dev") reason = "dev";
      for (const group of resolution.groups) {
        const deps = byGroup.get(group) ?? [];
        if (!deps.some((dep) => dep.name === update.name && dep.version === update.version)) {
          deps.push({ name: update.name, from: update.from, version: update.version });
        }
        byGroup.set(group, deps);
      }
    }
    return { parsed, byGroup, reason };
  } catch (error) {
    throw new Error(`${sha.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

const USAGE =
  "使い方: dependabot-plans.js --pr <N> --base <ref> [--head <ref>] [--dry-run] | " +
  "dependabot-plans.js --check --base <ref> [--head <ref>]";

/**
 * base..head で足された dependabot の plan が覆う group。plan の中身は head の commit から読む。
 * @param {string} repoDir
 * @param {string} base
 * @param {string} head
 * @returns {Set<string>}
 */
function coveredGroups(repoDir, base, head) {
  const added = git(repoDir, ["diff", "--name-only", "--diff-filter=A", `${base}..${head}`, "--", `${PLANS_DIR}/`])
    .split("\n")
    .filter((file) => /-dependabot-deps[^/]*\.md$/.test(file));
  const headSha = git(repoDir, ["rev-parse", head]).trim();
  /** @type {Set<string>} */
  const covered = new Set();
  for (const file of added) {
    const text = gitShow(repoDir, `${headSha}:${file}`);
    if (text === null) throw new Error(`${headSha.slice(0, 7)}:${file} を git show で読めません`);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    for (const line of front.split(/\r?\n/)) {
      const group = /^["']?([^:"'\s]+)["']?\s*:\s*\S+\s*$/.exec(line)?.[1];
      if (group !== undefined) covered.add(group);
    }
  }
  return covered;
}

/**
 * オプションの値を返す。無いか、次のオプションなら undefined。
 * @param {string[]} argv
 * @param {number} i オプションの位置
 * @returns {string | undefined}
 */
function optionValue(argv, i) {
  const value = argv[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * @param {MainOptions} [options]
 * @returns {Promise<number>} 終了コード
 */
async function main(options = {}) {
  const toolsRoot = options.toolsRoot ?? path.resolve(__dirname, "../../..");
  const out = options.stdout ?? ((line) => console.log(line));
  const err = options.stderr ?? ((line) => console.error(line));
  const argv = options.argv ?? process.argv.slice(2);
  let dryRun = false;
  let check = false;
  let base = "";
  let head = "HEAD";
  /** @type {string | undefined} */
  let prArg;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = optionValue(argv, i);
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--check") check = true;
    else if ((arg === "--pr" || arg === "--base" || arg === "--head") && value !== undefined) {
      if (arg === "--pr") prArg = value;
      else if (arg === "--base") base = value;
      else head = value;
      i += 1;
    } else {
      err(`引数が誤っています: ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const invalid = () => {
    err(`引数が誤っています: ${argv.join(" ")}\n${USAGE}`);
    return 2;
  };
  if (base === "") return invalid();
  if (check && (prArg !== undefined || dryRun)) return invalid();
  if (!check && (prArg === undefined || !/^\d+$/.test(prArg))) return invalid();
  const pr = Number(prArg ?? 0);

  /** @type {{ file: string, text: string }[]} */
  const written = [];
  try {
    const repoDir = options.repoDir ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const distDeps = await (options.loadDistDeps ?? loadDistDepsDefault)(toolsRoot);
    const commits = readCommits(repoDir, base, head);

    if (check) {
      const covered = coveredGroups(repoDir, base, head);
      let missing = 0;
      for (const commit of commits) {
        for (const group of analyze(repoDir, commit, distDeps).byGroup.keys()) {
          if (covered.has(group)) continue;
          missing += 1;
          err(`${commit.sha.slice(0, 7)}: ${group} の version plan がありません`);
        }
      }
      return missing === 0 ? 0 : 1;
    }

    const plansDir = path.join(repoDir, PLANS_DIR);
    const outDir = dryRun ? path.join(repoDir, ".pecot/tmp/dependabot-plans") : plansDir;
    if (dryRun) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
    }
    // dev・none は commit 単位、exists は plan ファイル単位
    const skipped = { dev: 0, none: 0, exists: 0 };
    /** @type {Map<string, Dep[]>} */
    const merged = new Map();
    for (const commit of commits) {
      const { byGroup, reason } = analyze(repoDir, commit, distDeps);
      if (byGroup.size === 0) skipped[reason] += 1;
      for (const [group, deps] of byGroup) {
        const all = merged.get(group) ?? [];
        for (const dep of deps) {
          if (!all.some((entry) => entry.name === dep.name && entry.version === dep.version)) all.push(dep);
        }
        merged.set(group, all);
      }
    }

    for (const [group, deps] of merged) {
      const name = `${pr}-dependabot-deps${merged.size >= 2 ? `-${group}` : ""}.md`;
      if (fs.existsSync(path.join(plansDir, name))) {
        skipped.exists += 1;
        continue;
      }
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, name);
      const text = renderPlan(group, deps);
      fs.writeFileSync(file, text);
      written.push({ file, text });
    }

    if (written.length > 0) {
      const files = written.map((entry) => entry.file);
      for (const script of ["check-version-plan-format.sh", "check-text.sh"]) {
        const result = spawnSync("bash", [path.join(toolsRoot, ".githooks/pre-commit", script), ...files], {
          cwd: toolsRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.stdout) out(result.stdout.trimEnd());
        if (result.stderr) err(result.stderr.trimEnd());
        if (result.status !== 0) {
          if (!dryRun) for (const file of files) fs.rmSync(file, { force: true });
          err(
            `${script} が plan を通しませんでした。` +
              (dryRun ? `書いた plan は ${outDir} に残しました` : "書いた plan は消しました"),
          );
          return 1;
        }
      }
    }
    if (dryRun) for (const { file, text } of written) out(`${file}\n${text}`);
    out(`作った plan ファイル: ${written.length} 件`);
    out(`作らなかった dependabot の PR（開発用）: ${skipped.dev} 件`);
    out(`作らなかった dependabot の PR（どの package にも当たらない）: ${skipped.none} 件`);
    out(`作らなかった plan ファイル（既にある）: ${skipped.exists} 件`);
    return 0;
  } catch (error) {
    if (!dryRun) for (const { file } of written) fs.rmSync(file, { force: true });
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

module.exports = { GROUP_PATHS, groupOf, parseCommit, parseUvLock, resolveGroups, renderPlan, main };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
