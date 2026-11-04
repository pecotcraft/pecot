import { afterEach, beforeEach, describe, it } from 'node:test';
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
  it('先頭のディレクトリを優先する', () => {
    write(talk, 'cover', 'layout: talk\n');
    write(theme, 'cover', 'layout: theme\n');
    assert.equal(loadLayoutReference([talk, theme], 'cover')?.layout, 'talk');
    assert.equal(loadLayoutReference([theme, talk], 'cover')?.layout, 'theme');
  });

  it('先のディレクトリに無ければ後のディレクトリで探す', () => {
    write(theme, 'cover', 'layout: theme\n');
    assert.equal(loadLayoutReference([talk, theme], 'cover')?.layout, 'theme');
  });

  it('どこにも無ければ null、配列が空でも null', () => {
    assert.equal(loadLayoutReference([talk, theme], 'cover'), null);
    assert.equal(loadLayoutReference([], 'cover'), null);
  });
});

describe('getLayoutProps（includes の解決も配列順）', () => {
  it('includes は配列の順に探した最初の共有 YAML を使う', () => {
    write(talk, '_common', 'props:\n  fromTalk: {}\n');
    write(theme, '_common', 'props:\n  fromTheme: {}\n');
    const reference = { includes: ['_common'], props: { own: {} } };
    assert.deepEqual(getLayoutProps(reference, [talk, theme]), ['fromTalk', 'own']);
    assert.deepEqual(getLayoutProps(reference, [theme, talk]), ['fromTheme', 'own']);
  });

  it('ディレクトリを渡さなければ includes を無視する', () => {
    assert.deepEqual(getLayoutProps({ includes: ['_common'], props: { own: {} } }), ['own']);
  });
});
