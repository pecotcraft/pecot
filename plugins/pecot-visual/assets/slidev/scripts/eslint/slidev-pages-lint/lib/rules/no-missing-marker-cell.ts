import type { Rule } from 'eslint';
import fs from 'fs';
import path from 'path';
import { parseFrontmatter, isPlainObject, readThemeSettings, resolveCellRect } from '@v-slidev/eslint-shared';
import type { DrawioModel } from '@v-slidev/eslint-shared';
import { resolveFilename, isReferenceFile } from '../utils/page-file.ts';
import { findSlidesFile } from '../utils/slides-loader.ts';
import { loadModel } from '../utils/drawio-model.ts';
import { PUBLIC_DIR, xmlSrcOf, findLine } from '../utils/diagram-ref.ts';

// 印のレイアウト（テーマの宣言 drawio.markerLayouts）の steps[].marker.cell が、参照する draw.io 図の図形（vertex）を指しているか確認する。
// 座標の解決は _shared の resolveCellRect を使い、レイアウトの実行時と判定を揃える。
// steps[].marker.cell と diagramContent.xmlSrc / steps[].diagram.xmlSrc の形は、印のレイアウトの取り決めとして固定している。

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require annotated-diagram marker.cell to reference a vertex in the draw.io file',
      recommended: true,
    },
    schema: [],
    messages: {
      missingDiagram: 'diagram file not found: {{xmlSrc}} ({{filePath}}) (fix: write xmlSrc as a path from public/ of the talk-dir)',
      noDiagram: 'steps[{{index}}].marker.cell is set, but there is no diagram (diagramContent.xmlSrc or steps[].diagram.xmlSrc)',
      invalidDiagram: 'cannot parse diagram {{xmlSrc}}: {{reason}}',
      invalidCell: 'cannot resolve steps[{{index}}].marker.cell in diagram {{xmlSrc}}: {{cell}} ({{reason}})',
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
      if (
        !isPlainObject(frontmatter) ||
        typeof frontmatter.layout !== 'string' ||
        !readThemeSettings(context).markerLayouts.includes(frontmatter.layout) ||
        !Array.isArray(frontmatter.steps)
      ) {
        return;
      }
      // talk-dir の外（slides.md が無い）では public/ を決められない
      const slidesFile = findSlidesFile(path.resolve(filePath));
      if (!slidesFile) {
        return;
      }
      const publicRoot = path.join(path.dirname(slidesFile), PUBLIC_DIR);
      const defaultSrc = xmlSrcOf(frontmatter.diagramContent);
      const reportedDiagrams = new Set<string>();

      const steps: unknown[] = frontmatter.steps;
      steps.forEach((step, index) => {
        if (!isPlainObject(step) || !isPlainObject(step.marker) || typeof step.marker.cell !== 'string') {
          return;
        }
        const cell = step.marker.cell;
        const loc = { line: findLine(text, cell), column: 0 };
        const xmlSrc = xmlSrcOf(step.diagram) ?? defaultSrc;
        if (!xmlSrc) {
          context.report({ node, loc, messageId: 'noDiagram', data: { index: String(index) } });
          return;
        }

        const xmlPath = path.join(publicRoot, xmlSrc);
        // 図そのものの問題は図ごとに 1 回だけ指摘する
        const diagramLoc = { line: findLine(text, xmlSrc), column: 0 };
        if (!fs.existsSync(xmlPath)) {
          if (!reportedDiagrams.has(xmlSrc)) {
            reportedDiagrams.add(xmlSrc);
            context.report({ node, loc: diagramLoc, messageId: 'missingDiagram', data: { xmlSrc, filePath: xmlPath } });
          }
          return;
        }

        let model: DrawioModel;
        try {
          model = loadModel(xmlPath);
        } catch (err) {
          if (!reportedDiagrams.has(xmlSrc)) {
            reportedDiagrams.add(xmlSrc);
            context.report({ node, loc: diagramLoc, messageId: 'invalidDiagram', data: { xmlSrc, reason: (err as Error).message } });
          }
          return;
        }

        try {
          resolveCellRect(model, cell);
        } catch (err) {
          context.report({
            node,
            loc,
            messageId: 'invalidCell',
            data: { index: String(index), cell, xmlSrc, reason: (err as Error).message },
          });
        }
      });
    }

    return {
      root: check,
      Program: check,
    } as unknown as Rule.RuleListener;
  },
};

export default rule;
