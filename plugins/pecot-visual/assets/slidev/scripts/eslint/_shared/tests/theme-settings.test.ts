import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readThemeSettings } from '../lib/theme-settings.ts';

describe('readThemeSettings', () => {
  it('settings が無ければ空の値を返す', () => {
    assert.deepEqual(readThemeSettings({}), { referencesDirectories: [], panels: {}, markerLayouts: [] });
  });

  it("settings['slidev-theme'] の 3 項目を読む", () => {
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

  it('形の合わない値は読み飛ばす', () => {
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

  it('凍結された settings を書き換えず、返す値は元の配列と別のものになる', () => {
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

  it('panels が prototype のキーを持たない（layout: constructor を拾わない）', () => {
    const { panels } = readThemeSettings({ settings: { 'slidev-theme': { panels: { panel: { width: 1, height: 1 } } } } });
    assert.equal(Object.hasOwn(panels, 'constructor'), false);
    assert.equal(Object.hasOwn(panels, 'panel'), true);
  });
});
