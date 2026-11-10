import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEnvironment, isValidEnvironmentName, isListedName, scanEnvironmentReads } from '../src/domain/environment-names.js'
import { validateRepository } from '../src/validate-repository.js'
import { materialize } from './helpers/repository.js'

const PW = 'plugins/pecot-workflow/interface/authored.yaml'
const UNRESOLVED = 'reads an environment variable by a name that is not a literal; write "interface-env: NAME" on the line before it, or "interface-env: none" if it reads no name'

function names(path: string, text: string): string[] {
  return scanEnvironmentReads({ path, text }).reads.map(read => read.name)
}

function unresolved(path: string, text: string): number[] {
  return scanEnvironmentReads({ path, text }).unresolved.map(read => read.line)
}

describe('fixtures', () => {
  it('lists a name that the source reads but the definitions do not', async () => {
    expect(await validateRepository(await materialize('env-unlisted'))).toEqual([
      'error: plugins/pecot-tools/interface/authored.yaml: environment: AWS_REGION is read by cli/src/aws.ts but not listed',
      `error: ${PW}: environment: PECOT_SESSION_PROJECT_DIR is read by cli/core/session.py but not listed`,
    ])
  })

  it('stops reads whose name is hidden and that have no interface-env comment', async () => {
    expect(await validateRepository(await materialize('env-no-comment'))).toEqual([
      `error: plugins/pecot-tools/cli/src/aws.ts:1: environment: ${UNRESOLVED}`,
      `error: plugins/pecot-tools/cli/src/aws.ts:2: environment: ${UNRESOLVED}`,
      `error: plugins/pecot-workflow/cli/core/session.py:7: environment: ${UNRESOLVED}`,
      `error: plugins/pecot-workflow/cli/core/session.py:11: environment: ${UNRESOLVED}`,
    ])
  })

  it('does not run the check for a plugin whose entries are partial', async () => {
    expect(await validateRepository(await materialize('env-partial'))).toEqual([])
  })

  it('reads only files that git tracks', async () => {
    const root = await materialize('valid')
    const file = path.join(root, 'plugins/pecot-workflow/cli/core/unlisted.py')
    await writeFile(file, 'import os\nx = os.environ["UNLISTED"]\n')
    expect(await validateRepository(root)).toEqual([])
    execFileSync('git', ['add', file], { cwd: root })
    expect(await validateRepository(root)).toEqual([`error: ${PW}: environment: UNLISTED is read by cli/core/unlisted.py but not listed`])
  })
})

describe('Python reads', () => {
  it.each([
    ['os.environ["A"]', 'x = os.environ["A"]', ['A']],
    ['os.environ[\'A\']', 'x = os.environ[\'A\']', ['A']],
    ['os.environ.get', 'x = os.environ.get("A", "d")', ['A']],
    ['os.environ.get across lines', 'x = os.environ.get(\n    "A",\n)', ['A']],
    ['os.getenv', 'x = os.getenv("A")', ['A']],
    ['in os.environ', 'if "A" in os.environ:\n    pass', ['A']],
    ['not in os.environ', 'if "A" not in os.environ:\n    pass', ['A']],
    ['setdefault', 'os.environ.setdefault("A", "1")', ['A']],
    ['pop', 'os.environ.pop("A", None)', ['A']],
    ['assignment is not a read', 'os.environ["A"] = "1"', []],
    ['augmented assignment reads first', 'os.environ["A"] += "1"', ['A']],
    ['a docstring is not scanned', 'def f():\n    """Reads os.environ[name]."""\n    pass', []],
    ['a multi-line triple-quoted string is not scanned', 'x = \'\'\'\nos.environ.get(name)\n\'\'\'\ny = os.environ[\'A\']', ['A']],
    ['comparison is a read', 'ok = os.environ["A"] == "1"', ['A']],
    ['del is not a read', 'del os.environ["A"]', []],
    ['update is not a read', 'os.environ.update({"A": "1"})', []],
    ['comment lines are ignored', '# os.environ["A"]', []],
  ] as const)('%s', (_label, source, expected) => {
    expect(names('a.py', source)).toEqual(expected)
    expect(unresolved('a.py', source)).toEqual([])
  })

  it.each([
    ['a variable name in get', 'x = os.environ.get(name)'],
    ['a variable name in an index', 'x = os.environ[name]'],
    ['a variable name in getenv', 'x = os.getenv(name)'],
    ['an f-string name', 'x = os.environ.get(f"A_{host}")'],
    ['a variable in a membership test', 'if name in os.environ:\n    pass'],
    ['iteration over the environment', 'for key in os.environ:\n    pass'],
    ['a copy', 'env = os.environ.copy()'],
    ['dict()', 'env = dict(os.environ)'],
    ['a spread', 'env = {**os.environ}'],
    ['a plain alias', 'env = os.environ'],
    ['a default argument', 'def f(env=os.environ):\n    pass'],
    ['items()', 'for key, value in os.environ.items():\n    pass'],
    ['getenv passed around', 'f = os.getenv'],
    ['an import of environ', 'from os import environ'],
    ['an import of getenv among others', 'from os import path, getenv'],
    ['a parenthesized import', 'from os import (\n    environ,\n)'],
  ] as const)('stops %s', (_label, source) => {
    expect(unresolved('a.py', source)).toHaveLength(1)
    expect(names('a.py', source)).toEqual([])
  })

  it('does not stop an unrelated import from os', () => {
    expect(unresolved('a.py', 'from os import path')).toEqual([])
  })

  it('takes the names from the comment on the line before', () => {
    const source = 'import os\n# interface-env: A, B\nx = os.environ.get(name)\n'
    expect(names('a.py', source)).toEqual(['A', 'B'])
    expect(unresolved('a.py', source)).toEqual([])
  })

  it('accepts interface-env: none', () => {
    const source = 'import os\n# interface-env: none\nx = dict(os.environ)\n'
    expect(names('a.py', source)).toEqual([])
    expect(unresolved('a.py', source)).toEqual([])
  })

  it('does not take a comment that is two lines above', () => {
    expect(unresolved('a.py', '# interface-env: A\n\nx = os.environ.get(name)\n')).toEqual([3])
  })

  it('reports the line where the read starts', () => {
    expect(unresolved('a.py', 'import os\n\nx = os.environ.get(\n    name,\n)\n')).toEqual([3])
  })
})

describe('TypeScript reads', () => {
  it.each([
    ['process.env.A', 'const x = process.env.A', ['A']],
    ['optional chaining', 'const x = process.env?.A', ['A']],
    ['process.env[\'A\']', 'const x = process.env[\'A\']', ['A']],
    ['process.env["A"]', 'const x = process.env["A"]', ['A']],
    ['a template literal without substitutions', 'const x = process.env[`A`]', ['A']],
    ['destructuring', 'const { A, B: renamed, C = 1 } = process.env', ['A', 'B', 'C']],
    ['a read after a space', 'const x = process.env\n  .A', ['A']],
    ['assignment is not a read', 'process.env.A = "1"', []],
    ['comparison is a read', 'const ok = process.env.A === "1"', ['A']],
    ['delete is not a read', 'delete process.env.A', []],
    ['delete of an index is not a read', 'delete process.env[\'A\']', []],
    ['augmented assignment reads first', 'process.env.A += \'x\'', ['A']],
    ['code after a block comment on the same line is read', '/* c */ const x = process.env.D', ['D']],
    ['an index assignment is not a read', 'process.env[\'A\'] = \'1\'', []],
    ['comment lines are ignored', '// process.env.A\n * process.env.B', []],
  ] as const)('%s', (_label, source, expected) => {
    expect(names('a.ts', source)).toEqual(expected)
    expect(unresolved('a.ts', source)).toEqual([])
  })

  it.each([
    ['a variable name', 'const x = process.env[name]'],
    ['a template with substitutions', 'const x = process.env[`A_${host}`]'],
    ['a spread', 'const env = { ...process.env }'],
    ['a plain alias', 'const env = process.env'],
    ['a default argument', 'function f(environment = process.env) {}'],
    ['a call argument', 'Object.keys(process.env)'],
    ['a rest element in destructuring', 'const { A, ...rest } = process.env'],
    ['a computed key in destructuring', 'const { [name]: value } = process.env'],
    ['an import of env', 'import { env } from \'node:process\''],
  ] as const)('stops %s', (_label, source) => {
    expect(unresolved('a.ts', source).length).toBeGreaterThan(0)
  })

  it('reads .mjs, .js and .tsx the same way', () => {
    for (const path of ['a.mjs', 'a.js', 'a.tsx', 'a.cts']) expect(names(path, 'process.env.A')).toEqual(['A'])
  })

  it('takes the names from a // comment on the line before', () => {
    expect(names('a.ts', '// interface-env: A\nconst x = process.env[name]')).toEqual(['A'])
  })

  it('ignores files that are neither Python nor TypeScript', () => {
    expect(scanEnvironmentReads({ path: 'a.sh', text: 'echo $A; os.environ["B"]' })).toEqual({ reads: [], unresolved: [] })
  })
})

describe('listed names', () => {
  it.each([
    ['A', 'A', true],
    ['A', 'B', false],
    ['PECOT_GITHUB_*_TOKEN', 'PECOT_GITHUB_API_TOKEN', true],
    ['PECOT_GITHUB_*_TOKEN', 'PECOT_GITHUB__TOKEN', false],
    ['PECOT_GITHUB_*_TOKEN', 'PECOT_GITHUB_api_TOKEN', false],
    ['PECOT_GITHUB_*_TOKEN', 'PECOT_GITHUB_*_TOKEN', true],
    ['PECOT_GITHUB_*_TOKEN', 'OTHER_X_TOKEN', false],
    ['PECOT_GITHUB_*_TOKEN', 'PECOT_GITHUB_X_KEY', false],
  ] as const)('%s matches %s: %s', (listed, read, expected) => {
    expect(isListedName(listed, read)).toBe(expected)
  })

  it.each([
    ['PECOT_GITHUB_API_URL', true],
    ['PECOT_GITHUB_*_TOKEN', true],
    ['PECOT_*', false],
    ['*_TOKEN', false],
    ['A_*_B_*_C', false],
    ['has space', false],
    ['', false],
  ] as const)('%s is valid: %s', (name, expected) => {
    expect(isValidEnvironmentName(name)).toBe(expected)
  })

  it('names the first file that reads a name and orders the lines by file and line', () => {
    const findings = checkEnvironment({
      pluginDir: 'plugins/p',
      authoredPath: 'plugins/p/interface/authored.yaml',
      listed: ['LISTED'],
      sources: [
        { path: 'plugins/p/cli/b.py', text: 'import os\nos.environ.get("X")\nos.environ.get("LISTED")\n' },
        { path: 'plugins/p/cli/a.py', text: 'import os\nos.environ.get("X")\n' },
      ],
    })
    expect(findings).toEqual([{ file: 'plugins/p/interface/authored.yaml', field: 'environment', reason: 'X is read by cli/a.py but not listed' }])
  })
})
