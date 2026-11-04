// 文章規則に渡す文言 1 件。図のラベルとエビデンスの項目が同じ形で返す。

export interface TextItem {
  /**
  契約の item。図なら `mxCell id="<id>"`、エビデンスなら `title` / `items[i].caption` / `items[i].annotations[j].text`
  */
  readonly item: string
  readonly text: string
}
