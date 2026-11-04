// domain unit test 用のヘルパ。
// 本番 `src/infra/pptx-ooxml/xml-engine.ts` の XmldomXmlEngine をそのまま使う。
// parse / serialize の薄い関数として再 export する。
// 本ヘルパは infra 層を直接 import するが、これは「テスト時に本物のポート実装を使う」ため。
// domain ソースコード自体の依存方向 (domain → infra への参照禁止) とは、別レイヤの話になる。

import { XmldomXmlEngine } from '../../../../src/infra/pptx-ooxml/xml-engine.js'
import type { XmlDocument } from '../../../../src/domain/_shared/ports.js'

const engine = new XmldomXmlEngine()

export function parseTestXml(xml: string): XmlDocument {
  return engine.parse(Buffer.from(xml, 'utf8'))
}

export function serializeTestXml(document: XmlDocument): string {
  return engine.serialize(document).toString('utf8')
}
