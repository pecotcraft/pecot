import { RuleTester } from 'eslint';
import * as vueParser from 'vue-eslint-parser';
import requireTableCellBackground from '../lib/rules/require-table-cell-background.ts';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: vueParser,
  },
});

ruleTester.run(
  'require-table-cell-background',
  requireTableCellBackground,
  {
    valid: [
      // インラインstyleでbackground-color指定（祖先trに背景があっても可）
      {
        name: 'セルにインライン style で背景色があると、祖先の tr に背景があっても報告しない',
        code: '<template><table><tr style="background-color: #eee;"><td style="background-color: #eee;">data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // クラスでbackground-color指定
      {
        name: 'セルにクラスで背景色があると、報告しない',
        code: '<template><table><tr class="row"><td class="cell">data</td></tr></table></template><style scoped>.row { background-color: #eee; } .cell { background-color: #eee; }</style>',
        filename: 'test.vue',
      },
      // 動的:styleバインディング（背景色の可能性あり）
      {
        name: 'セルの :style が動的だと、背景色の可能性があるので報告しない',
        code: '<template><table><tr style="background: #eee;"><td :style="cellStyle">data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // テーブルセルがない場合
      {
        name: 'テーブルのセルが無いと、報告しない',
        code: '<template><div>no table</div></template>',
        filename: 'test.vue',
      },
      // 背景がどこにも無いセル: 2.1.1 では透明セルとして出力され、見え方は変わらない（#1178 計測）
      {
        name: '背景がどこにも無いセルは、報告しない',
        code: '<template><table><tr><td>data</td><th>header</th></tr></table></template>',
        filename: 'test.vue',
      },
      // table 自身の背景: 表の背面の図形として出力され、透明セル越しに見える
      {
        name: 'table 自身に背景があると、報告しない',
        code: '<template><table style="background-color: #f0ebf7;"><tr><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // 表を包む外側の要素の背景: 独立図形として背面に出力される
      {
        name: '表を包む外側の要素に背景があると、報告しない',
        code: '<template><div class="wrap"><table><tbody><tr><td>data</td></tr></tbody></table></div></template><style scoped>.wrap { background-color: #fbe9d0; }</style>',
        filename: 'test.vue',
      },
      // 祖先trにクラスはあるが背景ではない
      {
        name: '祖先の tr にクラスがあっても背景でなければ、報告しない',
        code: '<template><table><tr class="row"><td>data</td></tr></table></template><style scoped>.row { color: #333; }</style>',
        filename: 'test.vue',
      },
      // 祖先trのインラインstyleが背景ではない
      {
        name: '祖先の tr のインライン style が背景でなければ、報告しない',
        code: '<template><table><tr style="height: 40px;"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // table の外に置かれたセル（祖先探索がテンプレート直下で止まる）
      {
        name: 'table の外に置かれたセルなら、報告しない',
        code: '<template><div><td>orphan</td></div></template>',
        filename: 'test.vue',
      },
      // 入れ子の表: 内側の table で祖先探索を止める（外側の tr の背景は内側セルの対象外）
      {
        name: '入れ子の表では、外側の tr の背景を内側のセルの対象にせず、報告しない',
        code: '<template><table><tr style="background-color: #eee;"><td style="background-color: #eee;"><table><tr><td>inner</td></tr></table></td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-01: セルのインライン background ショートハンドで同色を明示
      {
        name: 'セルのインライン background ショートハンドで同色を明示すると、報告しない',
        code: '<template><table><tr style="background: #eee;"><td style="background: #eee;">data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-01: セルのクラスの background ショートハンドで同色を明示
      {
        name: 'セルのクラスの background ショートハンドで同色を明示すると、報告しない',
        code: '<template><table><tr class="row"><td class="cell">data</td></tr></table></template><style scoped>.row { background: #eee; } .cell { background: #eee; }</style>',
        filename: 'test.vue',
      },
      // F-02: 子孫セレクタ .head th はセルを塗る書き方で、thead 自身の背景ではない
      {
        name: '子孫セレクタ .head th の背景は thead 自身の背景ではないので、報告しない',
        code: '<template><table><thead class="head"><tr><th>header</th></tr></thead></table></template><style scoped>.head th { background-color: #e0d4ee; }</style>',
        filename: 'test.vue',
      },
      // F-02: .row-x の背景は .row の要素に当たらない（前方一致を除外）
      {
        name: '別のクラス名 .row-x の背景は .row の要素に当たらないので、報告しない',
        code: '<template><table><tr class="row"><td>data</td></tr></table></template><style scoped>.row-x { background: #eee; }</style>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tr の :style が ObjectExpression で背景キーを持たない
      {
        name: '祖先の tr の :style が背景キーを持たないオブジェクトだと、報告しない',
        code: '<template><table><tr :style="{height: h}"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tr の :style が静的に読めない式（識別子）は報告しない
      {
        name: '祖先の tr の :style が識別子で静的に読めないと、報告しない',
        code: '<template><table><tr :style="rowStyle"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tr の :style オブジェクトがスプレッド・計算キー・数値キーだけ（静的に背景キーを読めない）
      {
        name: '祖先の tr の :style がスプレッド・計算キー・数値キーだけだと、報告しない',
        code: '<template><table><tr :style="{ ...base, [key]: v, 1: x }"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tr の静的 style が background-color: `transparent !important`（背景なし）
      {
        name: '祖先の tr の style が important つきの background-color: transparent だと、報告しない',
        code: '<template><table><tr style="background-color: transparent !important"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tr の静的 style が background: none（背景なし）
      {
        name: '祖先の tr の style が background: none だと、報告しない',
        code: '<template><table><tr style="background: none"><td>data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-03: 祖先 tbody のクラスの background-color が transparent（背景なし）
      {
        name: '祖先の tbody のクラスが background-color: transparent だと、報告しない',
        code: '<template><table><tbody class="body"><tr><td>data</td></tr></tbody></table></template><style scoped>.body { background-color: transparent; }</style>',
        filename: 'test.vue',
      },
      // F-03: セルの動的 :class（背景色の可能性あり）
      {
        name: 'セルの :class が動的だと、背景色の可能性があるので報告しない',
        code: '<template><table><tr style="background: #eee;"><td :class="cellClass">data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-10: col に背景があり、セルにも同色を明示
      {
        name: 'col に背景があり、セルに同色を明示すると、報告しない',
        code: '<template><table><colgroup><col style="background: #f0ebf7;"></colgroup><tr><td style="background-color: #f0ebf7;">data</td></tr></table></template>',
        filename: 'test.vue',
      },
      // F-10: colgroup / col はあるが背景ではない
      {
        name: 'colgroup と col があっても背景でなければ、報告しない',
        code: '<template><table><colgroup class="cg"><col style="width: 120px;"></colgroup><tr><td>data</td></tr></table></template><style scoped>.cg { color: #333; }</style>',
        filename: 'test.vue',
      },
      // F-10: 外側の表の col の背景は内側の表のセルの対象外
      {
        name: '外側の表の col の背景は、内側の表のセルの対象にせず、報告しない',
        code: '<template><table><colgroup><col style="background: #eee;"></colgroup><tr><td style="background: #eee;"><table><tr><td>inner</td></tr></table></td></tr></table></template>',
        filename: 'test.vue',
      },
    ],

    invalid: [
      // 祖先trにインラインbackground-color
      {
        name: '祖先の tr にインラインの background-color があり、セルに背景が無いと、報告する',
        code: '<template><table><tr style="background-color: #e0d4ee;"><td>data</td></tr></table></template>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } }],
      },
      // 祖先theadにクラスのbackground-color（th）
      {
        name: '祖先の thead にクラスの background-color があり、th に背景が無いと、報告する',
        code: '<template><table><thead class="head"><tr><th>header</th></tr></thead></table></template><style scoped>.head { background-color: #e0d4ee; }</style>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'th', ancestor: 'thead' } }],
      },
      // 祖先tbodyにクラスのbackground（shorthand）、セルのクラスは背景ではない
      {
        name: '祖先の tbody にクラスの background ショートハンドがあり、セルのクラスが背景でないと、報告する',
        code: '<template><table><tbody class="body"><tr><td class="cell">data</td></tr></tbody></table></template><style scoped>.body { background: #d9f2e6; } .cell { color: #333; }</style>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tbody' } }],
      },
      // 祖先tfootにインラインbackground（shorthand）、セルのstyleは背景ではない
      {
        name: '祖先の tfoot にインラインの background ショートハンドがあり、セルの style が背景でないと、報告する',
        code: '<template><table><tfoot style="background: #eee;"><tr><td style="color: red;">sum</td></tr></tfoot></table></template>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tfoot' } }],
      },
      // 祖先trの動的:style が ObjectExpression で backgroundColor キーを持つ、複数セル
      {
        name: '祖先の tr の :style が backgroundColor キーを持つと、セルごとに報告する',
        code: '<template><table><tr :style="{ backgroundColor: rowColor }"><td>a</td><td>b</td></tr></table></template>',
        filename: 'test.vue',
        errors: [
          { messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } },
          { messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } },
        ],
      },
      // 祖先tbodyの動的:style が文字列キー 'background' を持つ
      {
        name: '祖先の tbody の :style が文字列キー \'background\' を持つと、報告する',
        code: `<template><table><tbody :style="{ 'background': bg, ...rest }"><tr><td>a</td></tr></tbody></table></template>`,
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tbody' } }],
      },
      // F-02: カンマ区切りの後段セレクタ tr.row に背景、クラス名の後に疑似クラスが続く形も境界内
      {
        name: 'カンマ区切りの後段セレクタ tr.row:nth-child(odd) に背景があると、報告する',
        code: '<template><table><tr class="row"><td>data</td></tr></table></template><style scoped>.x, tr.row:nth-child(odd) { background: #eee; }</style>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } }],
      },
      // F-03: セルの静的 style が background: transparent（背景なし）
      {
        name: 'セルの style が background: transparent だと、報告する',
        code: '<template><table><tr style="background-color: #eee;"><td style="background: transparent;">data</td></tr></table></template>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } }],
      },
      // F-04: 外側セル内の内側 table で、内側 tr に背景（外側セルは背景を明示済み）
      {
        name: '内側の表の tr に背景があると、外側のセルが背景を明示していても報告する',
        code: '<template><table><tr><td style="background-color: #fff;"><table><tr style="background: #eee;"><td>inner</td></tr></table></td></tr></table></template>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'tr' } }],
      },
      // F-10: col のインライン背景、セル無指定
      {
        name: 'col のインライン背景があり、セルに背景が無いと、セルごとに報告する',
        code: '<template><table><colgroup><col style="background: #f0ebf7;"><col></colgroup><tr><td>a</td><th>b</th></tr></table></template>',
        filename: 'test.vue',
        errors: [
          { messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'col' } },
          { messageId: 'requireTableCellBackground', data: { tag: 'th', ancestor: 'col' } },
        ],
      },
      // F-10: colgroup のクラス背景、tbody 配下のセル
      {
        name: 'colgroup のクラス背景があり、tbody 配下のセルに背景が無いと、報告する',
        code: '<template><table><colgroup class="cg"><col></colgroup><tbody><tr><td>a</td></tr></tbody></table></template><style scoped>.cg { background-color: #d9f2e6; }</style>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'colgroup' } }],
      },
      // F-10: table 直下の col の :style オブジェクト背景
      {
        name: 'table 直下の col の :style に背景があり、セルに背景が無いと、報告する',
        code: '<template><table><col :style="{ background: c }"><tr><td>a</td></tr></table></template>',
        filename: 'test.vue',
        errors: [{ messageId: 'requireTableCellBackground', data: { tag: 'td', ancestor: 'col' } }],
      },
    ],
  },
);
