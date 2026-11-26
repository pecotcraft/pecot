import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearCache, getLayoutProps, loadLayoutReference } from '../lib/reference-loader.ts';

let root: string;
let talk: string;
let theme: string;

beforeEach(() => {
  clearCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-loader-'));
  talk = path.join(root, 'talk');
  theme = path.join(root, 'theme');
  fs.mkdirSync(talk);
  fs.mkdirSync(theme);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (dir: string, name: string, body: string): void => {
  fs.writeFileSync(path.join(dir, `${name}.yaml`), body, 'utf-8');
};

describe('loadLayoutReference（ディレクトリの配列）', () => {
  it('同じ名前の reference が複数のディレクトリにあると、先頭のディレクトリのものを返す', () => {
    write(talk, 'cover', 'layout: talk\n');
    write(theme, 'cover', 'layout: theme\n');
    assert.equal(loadLayoutReference([talk, theme], 'cover')?.layout, 'talk');
    assert.equal(loadLayoutReference([theme, talk], 'cover')?.layout, 'theme');
  });

  it('先のディレクトリに reference が無いと、後のディレクトリで探す', () => {
    write(theme, 'cover', 'layout: theme\n');
    assert.equal(loadLayoutReference([talk, theme], 'cover')?.layout, 'theme');
  });

  it('どのディレクトリにも reference が無いか、ディレクトリの配列が空だと、null を返す', () => {
    assert.equal(loadLayoutReference([talk, theme], 'cover'), null);
    assert.equal(loadLayoutReference([], 'cover'), null);
  });
});

describe('getLayoutProps（includes の解決も配列順）', () => {
  it('同じ名前の共有 YAML が複数のディレクトリにあると、配列の順で最初に見つかったものを includes に使う', () => {
    write(talk, '_common', 'props:\n  fromTalk: {}\n');
    write(theme, '_common', 'props:\n  fromTheme: {}\n');
    const reference = { includes: ['_common'], props: { own: {} } };
    assert.deepEqual(getLayoutProps(reference, [talk, theme]), ['fromTalk', 'own']);
    assert.deepEqual(getLayoutProps(reference, [theme, talk]), ['fromTheme', 'own']);
  });

  it('ディレクトリを渡さないと、includes を無視する', () => {
    assert.deepEqual(getLayoutProps({ includes: ['_common'], props: { own: {} } }), ['own']);
  });
});
