// ESLint の共有 settings['slidev-theme'] から、テーマが宣言した値を受ける。
// 値の組み立ては deck-lint.config.js の defineDeckLintConfig が 1 か所で行う。
// context.settings は凍結されているため、ここで受けた配列や object を書き換えない。

export const THEME_SETTINGS_KEY = 'slidev-theme';

export interface ThemeLintSettings {
  /** references/ を探すディレクトリ。先頭が優先（talk-dir 側が先） */
  referencesDirectories: readonly string[];
  /** レイアウト名 -> 図の枠寸法 (px) */
  panels: Readonly<Record<string, { width: number; height: number }>>;
  /** steps[].marker.cell を持つ図のレイアウト名 */
  markerLayouts: readonly string[];
}

export interface SettingsContext {
  settings?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isPanel(value: unknown): value is { width: number; height: number } {
  return (
    isRecord(value) &&
    typeof value.width === 'number' &&
    Number.isFinite(value.width) &&
    typeof value.height === 'number' &&
    Number.isFinite(value.height)
  );
}

export function readThemeSettings(context: SettingsContext): ThemeLintSettings {
  const raw = context.settings?.[THEME_SETTINGS_KEY];
  const source = isRecord(raw) ? raw : {};

  const referencesDirectories = Array.isArray(source.referencesDirectories)
    ? source.referencesDirectories.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const panels: Record<string, { width: number; height: number }> = {};
  if (isRecord(source.panels)) {
    for (const [layout, panel] of Object.entries(source.panels)) {
      if (isPanel(panel)) {
        Object.defineProperty(panels, layout, {
          value: { width: panel.width, height: panel.height },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }

  const markerLayouts = Array.isArray(source.markerLayouts)
    ? source.markerLayouts.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return { referencesDirectories, panels, markerLayouts };
}
