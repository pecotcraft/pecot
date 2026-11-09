// @ts-check
"use strict";

/**
 * dependabot の更新から、リリース直前に version plan を作る。
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

const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

/**
 * ファイルが属する release group。tests/ の下と、どの group にも属さない path は null。
 * @param {string} file
 * @returns {string | null}
 */
function groupOf(file) {
  if (/(^|\/)tests\//.test(file)) return null;
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
 * dependabot の commit の件名と本文を読む。#113 の後の squash は、2 commit の本文を連ねた形になる。
 * @param {string} subject
 * @param {string} body
 * @returns {ParsedCommit}
 */
function parseCommit(subject, body) {
  const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
  if (pr === undefined) throw new Error(`件名の末尾に (#N) がありません: ${subject}`);
  const directory =
    /\bin (\/\S*)(?: \(#\d+\))?$/.exec(subject)?.[1] ??
    /\bin the (\/\S*) directory/.exec(body)?.[1] ??
    /^\W*Bumps the .* group in (\/\S*)/m.exec(body)?.[1] ??
    "/";
  const updates = parseUpdatedDependencies(body).map((update) => ({
    ...update,
    from: readFromVersion(body, update.name),
  }));
  return { pr: Number(pr), directory, updates };
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

/**
 * @param {Update} update
 * @param {Context} ctx
 * @returns {Resolution}
 */
function resolveDirect(update, ctx) {
  const all = ctx.declarations[update.name] ?? [];
  const changed = all.filter((declaration) => declaration.changed);
  const targets = (changed.length > 0 ? changed : all).filter((declaration) => groupOf(declaration.path) !== null);
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
    return { groups: [group], reason: null };
  }
  return update.type === "indirect" ? resolveIndirect(update, ctx) : resolveDirect(update, ctx);
}

/**
 * plan の中身。本文は 1 行で、100 字を超えるなら件を減らして「ほか N 件」で締める。
 * @param {string} group
 * @param {Dep[]} deps
 * @param {number} pr
 * @returns {string}
 */
function renderPlan(group, deps, pr) {
  const items = deps.map((dep) => (dep.from ? `${dep.name} ${dep.from} → ${dep.version}` : `${dep.name} → ${dep.version}`));
  /** @param {number} shown */
  const sentence = (shown) => {
    const rest = items.length - shown;
    const parts = shown === 0 ? [`${items.length} 件`] : [...items.slice(0, shown), ...(rest > 0 ? [`ほか ${rest} 件`] : [])];
    return `依存を更新した（${parts.join("、")}）。(#${pr})`;
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
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
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
 * @param {string} cwd
 * @param {string} group
 */
const lastTag = (cwd, group) => git(cwd, ["tag", "--list", `${group}-v*`, "--sort=-v:refname"]).split("\n")[0] ?? "";

/**
 * 範囲の commit を古い順に読む。tag の側と中身が同じ commit は除く（履歴を書き換えた後の重複を防ぐ）。
 * @param {string} cwd
 * @param {string} base 起点の ref。空なら全履歴
 * @returns {{ sha: string, subject: string, body: string }[]}
 */
function readCommits(cwd, base) {
  const format = "--format=%H%x1f%s%x1f%b%x1e";
  const args = base === "" ? ["log", "--reverse", format, "HEAD"] : ["log", "--cherry-pick", "--right-only", "--reverse", format, `${base}...HEAD`];
  return git(cwd, args)
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha, subject, body };
    })
    .filter((commit) => commit.body.includes("updated-dependencies:"));
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
 * @param {string} cwd
 * @param {string} sha
 * @returns {Lock | null}
 */
function readLock(cwd, sha) {
  const text = gitShow(cwd, `${sha}:pnpm-lock.yaml`);
  if (text === null) return null;
  const { parseAllDocuments } = require("yaml");
  const docs = parseAllDocuments(text).map((doc) => doc.toJS());
  const main = docs.find((doc) => doc?.settings) ?? docs[docs.length - 1];
  if (!main?.importers) return null;
  return { importers: main.importers, snapshots: main.snapshots ?? {} };
}

/**
 * @param {string} toolsRoot
 * @returns {Promise<Set<string>>}
 */
async function loadDistDepsDefault(toolsRoot) {
  const url = require("node:url").pathToFileURL(path.join(toolsRoot, "plugins/pecot-visual/scripts/release/dist-manifest.mjs"));
  const { buildDistManifest } = await import(url.href);
  const manifest = buildDistManifest(path.join(toolsRoot, "plugins/pecot-visual"), "0.0.0", toolsRoot);
  return new Set(Object.keys(manifest.dependencies));
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
  let sinceRef = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--since-ref" && argv[i + 1] !== undefined) {
      sinceRef = /** @type {string} */ (argv[i + 1]);
      i += 1;
    } else {
      err(`引数が誤っています: ${arg}\n使い方: dependabot-plans.js [--dry-run] [--since-ref <ref>]`);
      return 2;
    }
  }

  try {
    const repoDir = options.repoDir ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const distDeps = await (options.loadDistDeps ?? loadDistDepsDefault)(toolsRoot);

    /** @type {Map<string, { sha: string, subject: string, body: string }>} */
    const commits = new Map();
    /** @type {Record<string, Set<string>>} */
    const inRange = {};
    for (const group of Object.keys(GROUP_PATHS)) {
      const base = sinceRef === "" ? lastTag(repoDir, group) : sinceRef;
      inRange[group] = new Set();
      for (const commit of readCommits(repoDir, base)) {
        commits.set(commit.sha, commit);
        inRange[group].add(commit.sha);
      }
    }

    const plansDir = path.join(repoDir, PLANS_DIR);
    const outDir = dryRun ? fs.mkdtempSync(path.join(os.tmpdir(), "dependabot-plans-")) : plansDir;
    /** @type {{ file: string, text: string }[]} */
    const written = [];
    const skipped = { dev: 0, none: 0, exists: 0 };

    for (const { sha, subject, body } of commits.values()) {
      const parsed = parseCommit(subject, body);
      const ctx = {
        directory: parsed.directory,
        uv: ["pyproject.toml", "uv.lock"].some((file) => gitShow(repoDir, `${sha}:${path.posix.join(parsed.directory, file).replace(/^\//, "")}`) !== null),
        declarations: readDeclarations(repoDir, sha, parsed),
        lock: parsed.updates.some((update) => update.type === "indirect") ? readLock(repoDir, sha) : null,
        distDeps,
      };
      /** @type {Map<string, Dep[]>} */
      const byGroup = new Map();
      /** @type {SkipReason} */
      let reason = "none";
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
      if (byGroup.size === 0) {
        skipped[reason] += 1;
        continue;
      }
      for (const [group, deps] of byGroup) {
        if (!inRange[group]?.has(sha)) continue;
        const name = `${parsed.pr}-dependabot-deps${byGroup.size >= 2 ? `-${group}` : ""}.md`;
        if (fs.existsSync(path.join(plansDir, name)) || written.some((entry) => path.basename(entry.file) === name)) {
          skipped.exists += 1;
          continue;
        }
        fs.mkdirSync(outDir, { recursive: true });
        const file = path.join(outDir, name);
        const text = renderPlan(group, deps, parsed.pr);
        fs.writeFileSync(file, text);
        written.push({ file, text });
      }
    }

    if (written.length > 0) {
      const files = written.map((entry) => entry.file);
      for (const script of ["check-version-plan-format.sh", "check-text.sh"]) {
        const result = spawnSync("bash", [path.join(toolsRoot, ".githooks/pre-commit", script), ...files], { cwd: toolsRoot, stdio: "inherit" });
        if (result.status !== 0) {
          if (!dryRun) for (const file of files) fs.rmSync(file, { force: true });
          err(`${script} が plan を通しませんでした。書いた plan は消しました`);
          return 1;
        }
      }
    }
    if (dryRun) for (const { file, text } of written) out(`${file}\n${text}`);
    out(`作った plan: ${written.length} 件`);
    out(`作らなかった plan（開発用）: ${skipped.dev} 件`);
    out(`作らなかった plan（どの package にも当たらない）: ${skipped.none} 件`);
    out(`作らなかった plan（既にある）: ${skipped.exists} 件`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

module.exports = { GROUP_PATHS, groupOf, parseCommit, resolveGroups, renderPlan, main };

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}
