// page.evaluate の中で、`new Function('return ' + fn)()` 経由で使う browser-injected JS の文字列定数。
// infra/slidev-to-pptx/ の Playwright 触り部分から参照される。

/* eslint-disable unicorn/name-replacements -- 旧 sub-package と同名で外部からの参照名を維持 */
export const slideVisibleFunctionSource = `(el) => {
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.children.length > 0;
}`

export const slidevReadyFunctionSource = `() => {
  const pages = document.querySelectorAll('.slidev-page');
  if (pages.length === 0) return false;
  for (const p of pages) {
    const s = getComputedStyle(p);
    if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && p.children.length > 0) return true;
  }
  return false;
}`

// build 済み Slidev アプリの nav 状態を読む。
// Vue 3 は production build でも `app.__vue_app__` を無条件に代入する。
// そのため `$$slidev-context` の provide 経由で `nav.hasNext` に届く（`window.__slidev__` は `__DEV__` 限定で使えない）。
// 最終ステップで false になるので、scanner はこれを見て ArrowRight を押さずに終われる。
// context に届かない場合は null を返し、呼び出し側を従来の終端判定へ倒す。
export const readSlidevHasNextFn = `() => {
  const app = document.getElementById('app');
  const provides = app && app.__vue_app__ && app.__vue_app__._context
    ? app.__vue_app__._context.provides
    : null;
  const context = provides ? provides['$$slidev-context'] : null;
  const nav = context ? context.nav : null;
  if (!nav || typeof nav.hasNext !== 'boolean') return null;
  return nav.hasNext;
}`
/* eslint-enable unicorn/name-replacements */
