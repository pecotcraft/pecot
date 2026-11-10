#!/usr/bin/env node
// devcontainer.json の playwright-deps の version を、pnpm-lock.yaml の playwright の版に書き換える。
// 版の読み方は test_devcontainer_playwright_version.py と同じ。版が 1 つでないとき、該当の行が無いときは exit 1。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const CONFIG = path.join(ROOT, '.devcontainer/devcontainer.json');

// JSONC なので JSON としては読まず、該当の 1 か所だけ置き換える。
const FEATURE = /("\.\/features\/playwright-deps"\s*:\s*\{\s*"version"\s*:\s*")([^"]*)(")/;

function fail(message) {
  console.error(`sync-playwright-deps: ${message}`);
  process.exit(1);
}

// 同じ版は packages と snapshots の 2 か所に出るので、重複を除く。
const locked = [...new Set([...fs.readFileSync(LOCK, 'utf8').matchAll(/^ {2}playwright@(\d[^\s:]*):$/gm)].map((m) => m[1]))];
if (locked.length !== 1) {
  fail(`pnpm-lock.yaml の playwright が 1 版でない: [${locked.join(', ')}]`);
}

const text = fs.readFileSync(CONFIG, 'utf8');
const match = FEATURE.exec(text);
if (!match) {
  fail('.devcontainer/devcontainer.json に ./features/playwright-deps の version が無い');
}

if (match[2] === locked[0]) {
  console.log(`playwright-deps は ${locked[0]} のまま`);
} else {
  fs.writeFileSync(CONFIG, text.replace(FEATURE, `$1${locked[0]}$3`));
  console.log(`playwright-deps: ${match[2]} -> ${locked[0]}`);
}
