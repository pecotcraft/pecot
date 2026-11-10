import type { Rule } from 'eslint';
import fs from 'fs';
import path from 'path';
import { parseFrontmatter, isPlainObject, readThemeSettings, fitDiagram, maxDiagramBounds } from '@v-slidev/eslint-shared';
import type { DiagramFit } from '@v-slidev/eslint-shared';
import { resolveFilename, isReferenceFile } from '../utils/page-file.ts';
import { findSlidesFile } from '../utils/slides-loader.ts';
import { loadModel } from '../utils/drawio-model.ts';
import { PUBLIC_DIR, collectXmlSrcs, findLine } from '../utils/diagram-ref.ts';

// 図パネルを持つレイアウトの draw.io 図が、表示枠で縮小されずに収まるかを確かめる。
// 縮小の判定は diagrams.net viewer のフィット規則（_shared の fitDiagram）、パネル寸法はテーマの宣言（settings の panels）を使う。
// xmlSrc（/slides/diagrams/x.drawio）は talk-dir の public/ 配下に解決される。
// 図ファイルが無い・解析できないページは報告しない（slide_page の雛形が example.drawio を書くため。
// 解析不能は no-missing-marker-cell が見る）。

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow draw.io diagrams whose bounding box is scaled down in the layout diagram panel',
      recommended: true,
    },
    schema: [],
    messages: {
      scaled:
        'bounding box of diagram {{xmlSrc}} (including stroke width) is {{width}}×{{height}}px; ' +
        'the limit for {{layout}} is {{maxWidth}}×{{maxHeight}}px, so it is scaled down to {{percent}}% ' +
        '(fix: this cannot be fixed on the page; redraw the diagram with v-diagram-creator)',
    },
  },

  create(context) {
    function check(node: Rule.Node) {
      const filePath = resolveFilename(context);
      if (isReferenceFile(filePath)) {
        return;
      }

      const sourceCode = context.sourceCode;
      let text: string;
      try {
        text = sourceCode.getText();
      } catch {
        return;
      }

      const frontmatter = parseFrontmatter(text);
      if (!isPlainObject(frontmatter) || typeof frontmatter.layout !== 'string') {
        return;
      }
      const layout = frontmatter.layout;
      // layout: constructor のような名前で prototype の値を拾わないよう、own-property だけを見る
      const { panels } = readThemeSettings(context);
      if (!Object.hasOwn(panels, layout)) {
        return;
      }
      const panel = panels[layout];
      if (!panel) {
        return;
      }
      const slidesFile = findSlidesFile(path.resolve(filePath));
      if (!slidesFile) {
        return;
      }
      const max = maxDiagramBounds(panel);
      const publicRoot = path.join(path.dirname(slidesFile), PUBLIC_DIR);
      const reported = new Set<string>();

      for (const xmlSrc of collectXmlSrcs(frontmatter)) {
        if (reported.has(xmlSrc)) {
          continue;
        }
        const xmlPath = path.join(publicRoot, xmlSrc);
        if (!fs.existsSync(xmlPath)) {
          continue;
        }
        let bounds: { width: number; height: number };
        let fit: DiagramFit;
        try {
          const visual = loadModel(xmlPath).visualBounds;
          if (!visual) {
            continue;
          }
          bounds = visual;
          fit = fitDiagram(visual, panel);
        } catch {
          continue;
        }
        if (fit.scale >= 1) {
          continue;
        }
        reported.add(xmlSrc);
        context.report({
          node,
          loc: { line: findLine(text, xmlSrc), column: 0 },
          messageId: 'scaled',
          data: {
            xmlSrc,
            layout,
            width: String(Math.ceil(bounds.width)),
            height: String(Math.ceil(bounds.height)),
            maxWidth: String(max.width),
            maxHeight: String(max.height),
            percent: String(Math.floor(fit.scale * 100)),
          },
        });
      }
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
