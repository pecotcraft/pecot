import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { readThemeSettings } from '../lib/theme-settings.ts';
import { explains } from '../../../../../../../../libs/interface-spec/src/vitest/explains.js';

describe('readThemeSettings', () => {
  it('settings が無いと、空の値を返す', async () => {
    await explains('テーマの設定を読み出す、`readThemeSettings` のテストです。settings が存在しない場合に、`referencesDirectories`・`panels`・`markerLayouts` がすべて空の値で返ることを確認します。');
    assert.deepEqual(readThemeSettings({}), { referencesDirectories: [], panels: {}, markerLayouts: [] });
  });

  it("settings['slidev-theme'] に 3 項目があると、3 項目とも読む", async () => {
    await explains('テーマの設定を読み出す、`readThemeSettings` のテストです。`slidev-theme` の設定に 3 項目が指定されている場合に、3 項目とも読み出すことを確認します。');
    const settings = readThemeSettings({
      settings: {
        'slidev-theme': {
          referencesDirectories: ['/talk/references', '/theme/references'],
          panels: { panel: { width: 400, height: 300 } },
          markerLayouts: ['marked'],
        },
      },
    });
    assert.deepEqual(settings.referencesDirectories, ['/talk/references', '/theme/references']);
    assert.deepEqual(settings.panels, { panel: { width: 400, height: 300 } });
    assert.deepEqual(settings.markerLayouts, ['marked']);
  });

  it('形の合わない値があると、読み飛ばす', async () => {
    await explains('テーマの設定を読み出す、`readThemeSettings` のテストです。形の合わない値が含まれる場合に、その値だけを読み飛ばし、残りを読み出すことを確認します。');
    const settings = readThemeSettings({
      settings: {
        'slidev-theme': {
          referencesDirectories: ['/ok', 1, null],
          panels: { good: { width: 1, height: 2 }, bad: { width: '1', height: 2 }, worse: 3 },
          markerLayouts: ['ok', 2],
        },
      },
    });
    assert.deepEqual(settings.referencesDirectories, ['/ok']);
    assert.deepEqual(settings.panels, { good: { width: 1, height: 2 } });
    assert.deepEqual(settings.markerLayouts, ['ok']);
  });

  it('凍結された settings を渡すと、書き換えず、元の配列とは別の配列を返す', async () => {
    await explains('テーマの設定を読み出す、`readThemeSettings` のテストです。凍結された settings の場合に、元の値を書き換えず、元の配列とは別の配列を返すことを確認します。');
    const referencesDirectories = Object.freeze(['/a', '/b']);
    const context = {
      settings: Object.freeze({
        'slidev-theme': Object.freeze({ referencesDirectories, markerLayouts: Object.freeze(['m']) }),
      }),
    };
    const settings = readThemeSettings(context);
    assert.deepEqual(settings.referencesDirectories, ['/a', '/b']);
    assert.notStrictEqual(settings.referencesDirectories, referencesDirectories);
  });

  it('panels を読むと、prototype のキーを持たない値を返す', async () => {
    await explains('`panels` の戻り値のテストです。`constructor` のような prototype のキーを持たず、指定したキーだけを持つことを確認します。');
    const { panels } = readThemeSettings({ settings: { 'slidev-theme': { panels: { panel: { width: 1, height: 1 } } } } });
    assert.equal(Object.hasOwn(panels, 'constructor'), false);
    assert.equal(Object.hasOwn(panels, 'panel'), true);
  });
});
