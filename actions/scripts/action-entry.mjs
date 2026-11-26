// src/<処理>.ts は main を export するだけにし、呼ぶのはこの仮の起点にする。テストは main を直接呼ぶ。
const PREFIX = '\0pecot-action-entry:'

export function actionEntry() {
  return {
    name: 'pecot-action-entry',
    resolveId(source) {
      if (source.startsWith(PREFIX)) return source
    },
    load(id) {
      if (id.startsWith(PREFIX)) return `import { main } from ${JSON.stringify(id.slice(PREFIX.length))}\nawait main()\n`
    },
  }
}

export function entryId(file) {
  return `${PREFIX}${file}`
}
