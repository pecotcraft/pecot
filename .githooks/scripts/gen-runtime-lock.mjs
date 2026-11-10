#!/usr/bin/env node
// 配布する単位ごとの runtime-workspace.yaml と runtime-lock.yaml を作る (#113)。入力は root の pnpm-workspace.yaml と pnpm-lock.yaml。
// --write で書き、--check でずれを見て非 0 で止める。どちらも pnpm を呼ばず、ネットワークにも触れない。
// 解決は root の lock のものを写し、importer から届く snapshots と packages だけを残す。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// vendor は、利用者側のミラーで libs/text-rules を指す symlink の置き場所。
const TARGETS = [
  { dir: 'plugins/pecot-visual', vendor: { 'libs/text-rules': 'vendor/text-rules' } },
  { dir: 'plugins/pecot-tools', vendor: {} },
  { dir: 'plugins/pecot-workflow', vendor: {} },
  { dir: 'libs/text-rules', vendor: {} },
];

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const readText = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readJson = (file) => JSON.parse(readText(file));

const mainDoc = (docs) => docs.find((doc) => doc.settings) ?? docs.at(-1);

// root の入力は 1 回だけ読む。
function loadRoot() {
  const workspaceSource = readText('pnpm-workspace.yaml');
  const docs = parseAllDocuments(readText('pnpm-lock.yaml')).map((doc) => doc.toJS());
  return { workspaceSource, workspace: parse(workspaceSource), docs, main: mainDoc(docs) };
}

// 元の path を、対象の中の path にする。対象の外なら null。
function mapPath(target, original) {
  if (original in target.vendor) return target.vendor[original];
  if (original === target.dir) return '.';
  if (original.startsWith(`${target.dir}/`)) return original.slice(target.dir.length + 1);
  return null;
}

function membersOf(root, target) {
  const members = Object.values(target.vendor);
  for (const original of root.workspace.packages) {
    const mapped = mapPath(target, original);
    if (mapped !== null && mapped !== '.' && !(original in target.vendor)) members.push(mapped);
  }
  return members;
}

// 元の path に戻す。vendor のメンバーは libs 側の package.json を読む。
function originalPath(target, mapped) {
  for (const [original, vendored] of Object.entries(target.vendor)) {
    if (vendored === mapped) return original;
  }
  return mapped === '.' ? target.dir : `${target.dir}/${mapped}`;
}

function workspaceText(root, target) {
  const members = membersOf(root, target);
  const lines = root.workspaceSource.split('\n');
  const start = lines.findIndex((line) => line === 'packages:');
  if (start === -1) throw new Error('root の pnpm-workspace.yaml に packages: の塊がありません');
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith('  - ') || lines[end] === '')) end += 1;
  const head = lines.slice(0, start).join('\n');
  const tail = lines.slice(end).join('\n');
  const block = `packages:\n${members.map((member) => `  - ${member}`).join('\n')}\n`;
  const rendered = members.length === 0 ? 'packages: []\n' : block;
  return `${head}${head ? '\n' : ''}${rendered}\n${tail}`;
}

function convertImporters(root, target) {
  const importers = {};
  for (const [key, importer] of Object.entries(root.main.importers)) {
    const mapped = mapPath(target, key);
    if (mapped === null) continue;
    importers[mapped] = structuredClone(importer);
  }
  for (const [mapped, importer] of Object.entries(importers)) {
    const original = originalPath(target, mapped);
    for (const section of SECTIONS) {
      for (const dep of Object.values(importer[section] ?? {})) {
        if (!dep.version.startsWith('link:')) continue;
        const linked = path.posix.normalize(path.posix.join(original, dep.version.slice(5)));
        const inside = mapPath(target, linked);
        if (inside === null) throw new Error(`${original} の ${dep.version} が ${target.dir} の外を指しています`);
        dep.version = `link:${path.posix.relative(mapped, inside) || '.'}`;
      }
    }
  }
  return Object.fromEntries(Object.entries(importers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// 依存 (name, version) が指す snapshot のキー。別名は version に `実名@版` が入る。
function snapshotKey(snapshots, name, version) {
  for (const key of [`${name}@${version}`, version]) {
    if (key in snapshots) return key;
  }
  throw new Error(`${name}@${version} が root の pnpm-lock.yaml の snapshots にありません`);
}

// importer から届く snapshots と、対応する packages だけを残す。
function prune(rootMain, importers) {
  const rootSnapshots = rootMain.snapshots ?? {};
  const rootPackages = rootMain.packages ?? {};
  const reached = new Set();
  const queue = [];
  const visit = (deps) => {
    for (const [name, version] of Object.entries(deps ?? {})) {
      if (version.startsWith('link:')) continue;
      const key = snapshotKey(rootSnapshots, name, version);
      if (!reached.has(key)) {
        reached.add(key);
        queue.push(key);
      }
    }
  };
  for (const importer of Object.values(importers)) {
    for (const section of SECTIONS) {
      visit(Object.fromEntries(Object.entries(importer[section] ?? {}).map(([name, dep]) => [name, dep.version])));
    }
  }
  while (queue.length > 0) {
    const snapshot = rootSnapshots[queue.pop()];
    visit(snapshot.dependencies);
    visit(snapshot.optionalDependencies);
  }
  const snapshots = {};
  const packages = {};
  for (const [key, value] of Object.entries(rootSnapshots)) {
    if (!reached.has(key)) continue;
    snapshots[key] = value;
    // peer の接尾辞 (...) は packages のキーに含まれない。
    const packageKey = key.split('(')[0];
    if (!(packageKey in rootPackages)) throw new Error(`${packageKey} が root の pnpm-lock.yaml にありません`);
    packages[packageKey] = rootPackages[packageKey];
  }
  const ordered = Object.fromEntries(Object.entries(rootPackages).filter(([key]) => key in packages));
  return { packages: ordered, snapshots };
}

const KNOWN_KEYS = new Set(['lockfileVersion', 'settings', 'catalogs', 'overrides', 'importers', 'packages', 'snapshots']);

// importer が `catalog:` で参照する名前だけを root の catalogs から残す。参照が無ければ null。
function pruneCatalogs(rootMain, importers) {
  const result = {};
  for (const importer of Object.values(importers)) {
    for (const section of SECTIONS) {
      for (const [name, dep] of Object.entries(importer[section] ?? {})) {
        if (!dep.specifier.startsWith('catalog:')) continue;
        const catalogName = dep.specifier.slice('catalog:'.length) || 'default';
        const entry = rootMain.catalogs?.[catalogName]?.[name];
        if (!entry) throw new Error(`${name} の ${dep.specifier} が root の pnpm-lock.yaml の catalogs にありません`);
        result[catalogName] = { ...result[catalogName], [name]: entry };
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

// 対象の lock の文書の並び。main 以外の文書 (pnpm 自身の lock) は root のものを写す。
function generate(root, target) {
  for (const key of Object.keys(root.main)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`root の pnpm-lock.yaml の ${key} は、この生成が扱えません`);
  }
  const importers = convertImporters(root, target);
  const { packages, snapshots } = prune(root.main, importers);
  const catalogs = pruneCatalogs(root.main, importers);
  const main = {
    lockfileVersion: root.main.lockfileVersion,
    settings: root.main.settings,
    ...(catalogs ? { catalogs } : {}),
    ...(root.main.overrides ? { overrides: root.main.overrides } : {}),
    importers,
    packages,
    snapshots,
  };
  return root.docs.map((doc) => (doc === root.main ? main : doc));
}

const lockText = (docs) => docs.map((doc) => `---\n${stringify(doc, { singleQuote: true, lineWidth: 0 })}`).join('');

function write() {
  const root = loadRoot();
  // 全対象をメモリ上で作ってから書く。途中で失敗しても、一部だけ書き換えた状態を残さない。
  const outputs = TARGETS.map((target) => {
    const docs = generate(root, target);
    return {
      target,
      workspace: workspaceText(root, target),
      lock: lockText(docs),
      count: Object.keys(mainDoc(docs).packages).length,
    };
  });
  const staged = [];
  try {
    for (const { target, workspace, lock } of outputs) {
      for (const [name, text] of [['runtime-workspace.yaml', workspace], ['runtime-lock.yaml', lock]]) {
        const file = path.join(ROOT, target.dir, name);
        fs.writeFileSync(`${file}.tmp`, text);
        staged.push(file);
      }
    }
  } catch (error) {
    for (const file of staged) fs.rmSync(`${file}.tmp`, { force: true });
    throw error;
  }
  for (const file of staged) fs.renameSync(`${file}.tmp`, file);
  for (const { target, count } of outputs) console.log(`${target.dir}: packages ${count}`);
}

function declared(packageJson) {
  const result = {};
  for (const section of SECTIONS) {
    if (packageJson[section]) result[section] = packageJson[section];
  }
  return result;
}

const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

function diffKeys(label, want, have, errors, lockFile, describe) {
  for (const key of new Set([...Object.keys(want), ...Object.keys(have)])) {
    if (!(key in have)) errors.push(`${lockFile}: ${label} ${key} がありません`);
    else if (!(key in want)) errors.push(`${lockFile}: ${label} ${key} は root の pnpm-lock.yaml から届きません`);
    else if (canonical(want[key]) !== canonical(have[key])) errors.push(`${lockFile}: ${describe(key, want[key], have[key])}`);
  }
}

function checkTarget(root, target) {
  const errors = [];
  const workspaceFile = `${target.dir}/runtime-workspace.yaml`;
  const lockFile = `${target.dir}/runtime-lock.yaml`;
  if (!fs.existsSync(path.join(ROOT, workspaceFile)) || !fs.existsSync(path.join(ROOT, lockFile))) {
    return [`${target.dir}: runtime-workspace.yaml か runtime-lock.yaml がありません`];
  }
  if (readText(workspaceFile) !== workspaceText(root, target)) {
    errors.push(`${workspaceFile}: root の pnpm-workspace.yaml と一致しません (packages 以外の設定かメンバー)`);
  }
  const docs = parseAllDocuments(readText(lockFile)).map((doc) => doc.toJS());
  const lock = mainDoc(docs);
  let expectedDocs;
  try {
    expectedDocs = generate(root, target);
  } catch (error) {
    return [...errors, `${lockFile}: ${error.message}`];
  }
  const want = mainDoc(expectedDocs);
  if (docs.length !== expectedDocs.length || canonical(docs.filter((d) => d !== lock)) !== canonical(expectedDocs.filter((d) => d !== want))) {
    errors.push(`${lockFile}: pnpm 自身の lock の文書が root の pnpm-lock.yaml と一致しません`);
  }
  for (const key of ['lockfileVersion', 'settings', 'catalogs', 'overrides']) {
    if (canonical(lock[key] ?? null) !== canonical(want[key] ?? null)) {
      errors.push(`${lockFile}: ${key} が root の pnpm-lock.yaml と一致しません`);
    }
  }
  diffKeys('packages', want.packages, lock.packages ?? {}, errors, lockFile, (key, a, b) =>
    canonical(a.resolution) === canonical(b.resolution)
      ? `${key} の内容が root の pnpm-lock.yaml と一致しません`
      : `${key} の integrity が root の pnpm-lock.yaml と一致しません`,
  );
  diffKeys('snapshots', want.snapshots, lock.snapshots ?? {}, errors, lockFile, (key) => `snapshots ${key} が root の pnpm-lock.yaml と一致しません`);
  const expected = ['.', ...membersOf(root, target)];
  const actual = Object.keys(lock.importers);
  if ([...expected].sort().join('\n') !== [...actual].sort().join('\n')) {
    errors.push(`${lockFile}: importers (${actual.join(', ')}) がメンバー (${expected.join(', ')}) と一致しません`);
  }
  for (const mapped of expected) {
    const importer = lock.importers[mapped];
    if (!importer) continue;
    if (want.importers[mapped] && canonical(want.importers[mapped]) !== canonical(importer)) {
      errors.push(`${lockFile}: ${mapped} の importer の版が root の pnpm-lock.yaml と一致しません`);
    }
    const manifest = declared(readJson(`${originalPath(target, mapped)}/package.json`));
    for (const section of SECTIONS) {
      // override は lock の specifier を書き換える。
      const wanted = Object.fromEntries(
        Object.entries(manifest[section] ?? {})
          .map(([name, range]) => [name, root.main.overrides?.[name] ?? range])
          .sort(),
      );
      const have = Object.fromEntries(
        Object.entries(importer[section] ?? {})
          .map(([name, dep]) => [name, dep.specifier])
          .sort(),
      );
      if (JSON.stringify(wanted) !== JSON.stringify(have)) {
        errors.push(`${lockFile}: ${mapped} の ${section} が package.json と一致しません`);
      }
    }
  }
  return errors;
}

function check() {
  const root = loadRoot();
  const errors = TARGETS.flatMap((target) => checkTarget(root, target));
  if (errors.length === 0) return;
  console.error(errors.join('\n'));
  console.error('node .githooks/scripts/gen-runtime-lock.mjs --write で作り直してください。');
  process.exit(1);
}

const mode = process.argv[2];
if (mode === '--write') write();
else if (mode === '--check') check();
else {
  console.error('usage: gen-runtime-lock.mjs --write | --check');
  process.exit(2);
}
