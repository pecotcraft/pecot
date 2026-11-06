#!/usr/bin/env node
// 配布する単位ごとの runtime-workspace.yaml と runtime-lock.yaml を作る (#113)。入力は root の pnpm-workspace.yaml と pnpm-lock.yaml。
// --write で書き、--check でずれを見て非 0 で止める。--check は pnpm を呼ばず、ネットワークにも触れない。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const rootWorkspace = () => parse(readText('pnpm-workspace.yaml'));
const rootLockDocs = () => parseAllDocuments(readText('pnpm-lock.yaml')).map((doc) => doc.toJS());
const mainDoc = (docs) => docs.find((doc) => doc.settings) ?? docs.at(-1);

// 元の path を、対象の中の path にする。対象の外なら null。
function mapPath(target, original) {
  if (original in target.vendor) return target.vendor[original];
  if (original === target.dir) return '.';
  if (original.startsWith(`${target.dir}/`)) return original.slice(target.dir.length + 1);
  return null;
}

function membersOf(target) {
  const members = Object.values(target.vendor);
  for (const original of rootWorkspace().packages) {
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

function workspaceText(target) {
  const text = readText('pnpm-workspace.yaml');
  const members = membersOf(target);
  const block = `packages:\n${members.map((member) => `  - ${member}`).join('\n')}\n`;
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === 'packages:');
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith('  - ') || lines[end] === '')) end += 1;
  const head = lines.slice(0, start).join('\n');
  const tail = lines.slice(end).join('\n');
  const rendered = members.length === 0 ? 'packages: []\n' : block;
  return `${head}${head ? '\n' : ''}${rendered}\n${tail}`;
}

function convertImporters(target, rootMain) {
  const importers = {};
  for (const [key, importer] of Object.entries(rootMain.importers)) {
    const mapped = mapPath(target, key);
    if (mapped === null) continue;
    importers[mapped] = importer;
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
  return importers;
}

function generate(target, tmpBase) {
  const docs = rootLockDocs();
  const rootMain = mainDoc(docs);
  const seed = docs.map((doc) => (doc === rootMain ? { ...doc, importers: convertImporters(target, doc) } : doc));
  const work = fs.mkdtempSync(path.join(tmpBase, 'gen-'));
  try {
    const packageJsons = ['.', ...membersOf(target)];
    for (const mapped of packageJsons) {
      const from = path.join(ROOT, originalPath(target, mapped), 'package.json');
      const to = path.join(work, mapped, 'package.json');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    fs.writeFileSync(path.join(work, 'pnpm-workspace.yaml'), workspaceText(target));
    fs.writeFileSync(path.join(work, 'pnpm-lock.yaml'), seed.map((doc) => `---\n${stringify(doc)}`).join(''));
    execFileSync('pnpm', ['install', '--lockfile-only', '--fix-lockfile', '--ignore-scripts', '--prefer-offline'], {
      cwd: work,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CI: 'true' },
    });
    return fs.readFileSync(path.join(work, 'pnpm-lock.yaml'), 'utf8');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function write() {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lock-'));
  try {
    for (const target of TARGETS) {
      fs.writeFileSync(path.join(ROOT, target.dir, 'runtime-workspace.yaml'), workspaceText(target));
      const lock = generate(target, tmpBase);
      fs.writeFileSync(path.join(ROOT, target.dir, 'runtime-lock.yaml'), lock);
      const count = Object.keys(mainDoc(parseAllDocuments(lock).map((doc) => doc.toJS())).packages).length;
      console.log(`${target.dir}: packages ${count}`);
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

function declared(packageJson) {
  const result = {};
  for (const section of SECTIONS) {
    if (packageJson[section]) result[section] = packageJson[section];
  }
  return result;
}

function checkTarget(target, rootMain) {
  const errors = [];
  const workspaceFile = `${target.dir}/runtime-workspace.yaml`;
  const lockFile = `${target.dir}/runtime-lock.yaml`;
  if (!fs.existsSync(path.join(ROOT, workspaceFile)) || !fs.existsSync(path.join(ROOT, lockFile))) {
    return [`${target.dir}: runtime-workspace.yaml か runtime-lock.yaml がありません`];
  }
  if (readText(workspaceFile) !== workspaceText(target)) {
    errors.push(`${workspaceFile}: root の pnpm-workspace.yaml と一致しません (packages 以外の設定かメンバー)`);
  }
  const lock = mainDoc(parseAllDocuments(readText(lockFile)).map((doc) => doc.toJS()));
  for (const key of ['settings', 'overrides']) {
    if (JSON.stringify(lock[key] ?? null) !== JSON.stringify(rootMain[key] ?? null)) {
      errors.push(`${lockFile}: ${key} が root の pnpm-lock.yaml と一致しません`);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages)) {
    const rootEntry = rootMain.packages[name];
    if (!rootEntry) errors.push(`${lockFile}: ${name} が root の pnpm-lock.yaml にありません`);
    else if (JSON.stringify(rootEntry.resolution) !== JSON.stringify(entry.resolution)) {
      errors.push(`${lockFile}: ${name} の integrity が root の pnpm-lock.yaml と一致しません`);
    }
  }
  const expected = ['.', ...membersOf(target)];
  const actual = Object.keys(lock.importers);
  if ([...expected].sort().join('\n') !== [...actual].sort().join('\n')) {
    errors.push(`${lockFile}: importers (${actual.join(', ')}) がメンバー (${expected.join(', ')}) と一致しません`);
  }
  for (const mapped of expected) {
    const importer = lock.importers[mapped];
    if (!importer) continue;
    const manifest = declared(readJson(`${originalPath(target, mapped)}/package.json`));
    for (const section of SECTIONS) {
      // override は lock の specifier を書き換える。
      const want = Object.fromEntries(
        Object.entries(manifest[section] ?? {})
          .map(([name, range]) => [name, rootMain.overrides?.[name] ?? range])
          .sort(),
      );
      const have = Object.fromEntries(
        Object.entries(importer[section] ?? {})
          .map(([name, dep]) => [name, dep.specifier])
          .sort(),
      );
      if (JSON.stringify(want) !== JSON.stringify(have)) {
        errors.push(`${lockFile}: ${mapped} の ${section} が package.json と一致しません`);
      }
    }
  }
  return errors;
}

function check() {
  const rootMain = mainDoc(rootLockDocs());
  const errors = TARGETS.flatMap((target) => checkTarget(target, rootMain));
  if (errors.length === 0) return;
  console.error(errors.join('\n'));
  console.error('node scripts/gen-runtime-lock.mjs --write で作り直してください。');
  process.exit(1);
}

const mode = process.argv[2];
if (mode === '--write') write();
else if (mode === '--check') check();
else {
  console.error('usage: gen-runtime-lock.mjs --write | --check');
  process.exit(2);
}
