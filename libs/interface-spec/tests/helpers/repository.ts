import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

const roots: string[] = []

afterEach(async () => {
  const removed = roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all(removed)
})

// fixture をリポジトリの形のまま一時ディレクトリに写し、git に追跡させる。ソースは git ls-files から読むため。
export async function materialize(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'interface-spec-'))
  roots.push(root)
  await cp(path.join(import.meta.dirname, '..', 'fixtures', name), root, { recursive: true })
  // キーが重なる YAML は lint が止めるので、fixture は .dup で置いてある。
  const duplicate = path.join(root, 'plugins', 'pecot-workflow', 'interface', 'authored.yaml.dup')
  if (existsSync(duplicate)) await rename(duplicate, duplicate.slice(0, -'.dup'.length))
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['add', '--all'], { cwd: root })
  return root
}
