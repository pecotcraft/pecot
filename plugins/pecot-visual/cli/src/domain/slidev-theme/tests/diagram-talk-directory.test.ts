import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findDiagramTalkDirectory } from '../diagram-talk-directory.js'
import type { ThemeFiles } from '../ports.js'
import { explains } from '../../../../tests/_helpers/explains.js'

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
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。`slides.md` を持つ祖先の `public/` の下にある図を渡した場合に、その祖先のパスを返すことを確認します。')
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/slides/diagrams/a.drawio')).toBe('/work/talk')
  })

  it('public/ の直下にある図でも、その祖先の talk-dir を返す', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。`public/` の直下に置いた図を渡した場合にも、`slides.md` を持つ祖先のパスを返すことを確認します。')
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/a.drawio')).toBe('/work/talk')
  })

  it('public/ の外にある図は、祖先が slides.md を持っていても talk-dir として見つからない', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。`.pecotv/work`・`pages`・talk-dir の直下のように `public/` の外にある図を渡した場合に、`undefined` を返すことを確認します。')
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/.pecotv/work/a.drawio')).toBeUndefined()
    expect(await findDiagramTalkDirectory(files, '/work/talk/pages/a.drawio')).toBeUndefined()
    expect(await findDiagramTalkDirectory(files, '/work/talk/a.drawio')).toBeUndefined()
  })

  it('slides.md を持つ祖先が存在しない場合は、talk-dir として見つからない', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。どの祖先にも `slides.md` が存在しない場合に、`undefined` を返すことを確認します。')
    expect(await findDiagramTalkDirectory(filesWithSlides(), '/work/talk/public/a.drawio')).toBeUndefined()
  })

  it('public が slides.md を持つ dir の直下でない階層にある場合は、talk-dir として見つからない', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。`/work/talk/docs/public/a.drawio` のように、`public` が talk-dir の直下にない図を渡した場合に、`undefined` を返すことを確認します。')
    const files = filesWithSlides('/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/docs/public/a.drawio')).toBeUndefined()
  })

  it('talk-dir が入れ子になっている場合は、図に最も近い talk-dir を返す', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。`/work` と `/work/talk` の両方が `slides.md` を持つ場合に、図に近い `/work/talk` を返すことを確認します。')
    const files = filesWithSlides('/work', '/work/talk')
    expect(await findDiagramTalkDirectory(files, '/work/talk/public/a.drawio')).toBe('/work/talk')
  })

  it('ルートディレクトリ直下の図は、talk-dir として見つからない', async () => {
    await explains('図のファイルから、それを使う talk-dir を探す `findDiagramTalkDirectory` のテストです。ルートディレクトリが `slides.md` を持つ場合でも、その直下の `/a.drawio` を渡したときに `undefined` を返すことを確認します。')
    const files = filesWithSlides('/')
    expect(await findDiagramTalkDirectory(files, '/a.drawio')).toBeUndefined()
  })
})
