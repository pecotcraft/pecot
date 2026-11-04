import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findDiagramTalkDirectory } from '../diagram-talk-directory.js'
import type { ThemeFiles } from '../ports.js'

// I/O 境界の port だけを差し替える。slides.md を持つ dir を渡す。
function filesWithSlides(...directories: readonly string[]): ThemeFiles {
  const present = new Set(directories.map(directory => path.join(directory, 'slides.md')))
  return {
    readText: file => Promise.resolve(present.has(file) ? '---\ntheme: x\n---\n' : undefined),
    listFiles: () => Promise.resolve([]),
  }
}

describe('findDiagramTalkDirectory', () => {
  it('slides.md を持つ祖先の public/ の下の図は、その祖先を返す', async () => {
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/slides/diagrams/a.drawio')).toBe('/work/talk')
  })

  it('public/ の直下の図も当たる', async () => {
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/a.drawio')).toBe('/work/talk')
  })

  it('public/ の外の図は、祖先が slides.md を持っていても当たらない', async () => {
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/.pecotv/work/a.drawio')).toBeUndefined()
    expect(await findDiagramTalkDirectory(files, '/work/talk/pages/a.drawio')).toBeUndefined()
    expect(await findDiagramTalkDirectory(files, '/work/talk/a.drawio')).toBeUndefined()
  })

  it('slides.md を持つ祖先が無ければ当たらない', async () => {
    expect(await findDiagramTalkDirectory(filesWithSlides(), '/work/talk/public/a.drawio')).toBeUndefined()
  })

  it('public という名前が別の階層にあっても、slides.md を持つ dir の直下でなければ当たらない', async () => {
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/docs/public/a.drawio')).toBeUndefined()
  })

  it('入れ子では、図に最も近い talk-dir を返す', async () => {
    const files = filesWithSlides('/work', '/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/a.drawio')).toBe('/work/talk')
  })

  it('リポジトリ root 直下の図は当たらない', async () => {
    const files = filesWithSlides('/')
    expect(await findDiagramTalkDirectory(files, '/a.drawio')).toBeUndefined()
  })
})
