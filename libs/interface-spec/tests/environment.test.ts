import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEnvironment, isValidEnvironmentName, isListedName, scanEnvironmentReads } from '../src/domain/environment-names.js'
import { validateRepository } from '../src/validate-repository.js'
import { materialize } from './helpers/repository.js'
import { step, stepSync } from '../src/vitest/step.js'
import { explains } from '../src/vitest/explains.js'

const PW = 'plugins/pecot-workflow/interface/authored.yaml'
const UNRESOLVED = 'reads an environment variable by a name that is not a literal; write "interface-env: NAME" on the line before it, or "interface-env: none" if it reads no name'

function names(path: string, text: string): string[] {
  return scanEnvironmentReads({ path, text }).reads.map(read => read.name)
}

function unresolved(path: string, text: string): number[] {
  return scanEnvironmentReads({ path, text }).unresolved.map(read => read.line)
}

describe('fixtures', () => {
  it('ソースが読む環境変数の名前を定義書が挙げていないと、その名前を含む検証エラーを返す', async () => {
    await explains('ソースが読む環境変数と、定義書の `environment` の整合を検証するテストです。定義書に載っていない名前をソースが読んでいる場合、その名前と読んでいるファイルを含む検証エラーを返すことを確認します。')
    await step('環境変数の読みを調べて比べる', async () => {
      expect(await validateRepository(await materialize('env-unlisted'))).toEqual([
        'error: plugins/pecot-tools/interface/authored.yaml: environment: AWS_REGION is read by cli/src/aws.ts but not listed',
        `error: ${PW}: environment: PECOT_SESSION_PROJECT_DIR is read by cli/core/session.py but not listed`,
      ])
    })
  })

  it('名前が分からない環境変数の読み取りに interface-env のコメントが存在しないと、検証エラーにする', async () => {
    await explains('ソースが読む環境変数と、定義書の `environment` の整合を検証するテストです。名前を文字列で書かない読み取りに `interface-env` のコメントが付いていない場合に、ファイルと行を含む検証エラーを返すことを確認します。')
    await step('環境変数の読みを調べて比べる', async () => {
      expect(await validateRepository(await materialize('env-no-comment'))).toEqual([
        `error: plugins/pecot-tools/cli/src/aws.ts:1: environment: ${UNRESOLVED}`,
        `error: plugins/pecot-tools/cli/src/aws.ts:2: environment: ${UNRESOLVED}`,
        `error: plugins/pecot-workflow/cli/core/session.py:7: environment: ${UNRESOLVED}`,
        `error: plugins/pecot-workflow/cli/core/session.py:11: environment: ${UNRESOLVED}`,
      ])
    })
  })

  it('項目が部分的な plugin では、環境変数を検証しない', async () => {
    await explains('ソースが読む環境変数と、定義書の `environment` の整合を検証するテストです。定義書が一部の項目だけを持つ plugin の場合に、検証エラーが出ないことを確認します。')
    await step('環境変数の読みを調べて比べる', async () => {
      expect(await validateRepository(await materialize('env-partial'))).toEqual([])
    })
  })

  it('git が追跡するファイルだけを、環境変数の読み取りの検証の対象にする', async () => {
    await explains('ソースが読む環境変数と、定義書の `environment` の整合を検証するテストです。追跡されていないファイルの読み取りは検証エラーにならず、`git add` した後はエラーになることを確認します。')
    const root = await materialize('valid')
    const file = path.join(root, 'plugins/pecot-workflow/cli/core/unlisted.py')
    await step('追跡されないファイルを書く', async () => {
      await writeFile(file, 'import os\nx = os.environ["UNLISTED"]\n')
    })
    await step('検証を動かし、結果を比べる', async () => {
      expect(await validateRepository(root)).toEqual([])
    })
    stepSync('追跡に加える', () => {
      execFileSync('git', ['add', file], { cwd: root })
    })
    await step('検証を動かし、結果を比べる', async () => {
      expect(await validateRepository(root)).toEqual([`error: ${PW}: environment: UNLISTED is read by cli/core/unlisted.py but not listed`])
    })
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
  ] as const)('Python のソースに %s（%j）があると、読んだ名前として %j を返し、解決できない行は返さない', async (label, source, expected) => {
    await explains(`Python のソースから環境変数の読み取りを探す \`scanEnvironmentReads\` のテストです。\`${JSON.stringify(source)}\`（${label}）を渡した場合に、名前 \`${JSON.stringify(expected)}\` を返し、名前を解決できない行がないことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(names('a.py', source)).toEqual(expected)
      expect(unresolved('a.py', source)).toEqual([])
    })
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
  ] as const)('Python のソースに %s があると、名前を解決できない行を 1 件返し、名前は返さない', async (label, source) => {
    await explains(`Python のソースから環境変数の読み取りを探す \`scanEnvironmentReads\` のテストです。\`${JSON.stringify(source)}\`（${label}）を渡した場合に、名前を解決できない行を 1 件だけ返し、読んだ名前は返さないことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(unresolved('a.py', source)).toHaveLength(1)
      expect(names('a.py', source)).toEqual([])
    })
  })

  it('os 以外のモジュールの import は、名前を解決できない行として返さない', async () => {
    await explains('Python のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。`from os import path` のように環境変数を扱わない import を渡した場合に、名前を解決できない行がないことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(unresolved('a.py', 'from os import path')).toEqual([])
    })
  })

  it('直前の行の interface-env のコメントから、環境変数の名前を取得する', async () => {
    await explains('Python のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。直前の行に `# interface-env: A, B` のコメントがある場合、名前 `A` と `B` を返し、解決できない行がないことを確認します。')
    const source = 'import os\n# interface-env: A, B\nx = os.environ.get(name)\n'
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(names('a.py', source)).toEqual(['A', 'B'])
      expect(unresolved('a.py', source)).toEqual([])
    })
  })

  it('interface-env: none と書くと、環境変数を読まないものとして扱う', async () => {
    await explains('Python のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。直前の行に `# interface-env: none` がある場合に、名前と解決できない行のどちらも返さないことを確認します。')
    const source = 'import os\n# interface-env: none\nx = dict(os.environ)\n'
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(names('a.py', source)).toEqual([])
      expect(unresolved('a.py', source)).toEqual([])
    })
  })

  it('2 行上の interface-env のコメントは、名前として取得しない', async () => {
    await explains('Python のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。`interface-env` のコメントと読み取りの間に空行がある場合に、コメントを使わず、読み取りの行を解決できない行として返すことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(unresolved('a.py', '# interface-env: A\n\nx = os.environ.get(name)\n')).toEqual([3])
    })
  })

  it('複数の行にまたがる読み取りは、読み取りが始まる行を返す', async () => {
    await explains('Python のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。引数が次の行に続く `os.environ.get(` の場合に、名前を解決できない行として開始行の番号を返すことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(unresolved('a.py', 'import os\n\nx = os.environ.get(\n    name,\n)\n')).toEqual([3])
    })
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
  ] as const)('TypeScript のソースに %s（%j）があると、読んだ名前として %j を返し、解決できない行は返さない', async (label, source, expected) => {
    await explains(`TypeScript のソースから環境変数の読み取りを探す \`scanEnvironmentReads\` のテストです。\`${JSON.stringify(source)}\`（${label}）を渡した場合に、名前 \`${JSON.stringify(expected)}\` を返し、名前を解決できない行がないことを確認します。`)
    stepSync('結果を比べる', () => {
      expect(names('a.ts', source)).toEqual(expected)
      expect(unresolved('a.ts', source)).toEqual([])
    })
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
  ] as const)('TypeScript のソースに %s があると、名前を解決できない行を返す', async (label, source) => {
    await explains(`TypeScript のソースから環境変数の読み取りを探す \`scanEnvironmentReads\` のテストです。\`${JSON.stringify(source)}\`（${label}）を渡した場合に、名前を解決できない行を 1 件以上返すことを確認します。`)
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(unresolved('a.ts', source).length).toBeGreaterThan(0)
    })
  })

  it('拡張子が .mjs・.js・.tsx・.cts のファイルも、TypeScript と同じ規則で環境変数の読み取りを探す', async () => {
    await explains('TypeScript のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。`.mjs`・`.js`・`.tsx`・`.cts` のファイルでも、`process.env.A` から名前 `A` を返すことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      for (const path of ['a.mjs', 'a.js', 'a.tsx', 'a.cts']) expect(names(path, 'process.env.A')).toEqual(['A'])
    })
  })

  it('直前の行の // で始まる interface-env のコメントから、環境変数の名前を取得する', async () => {
    await explains('TypeScript のソースから環境変数の読み取りを探す `scanEnvironmentReads` のテストです。直前の行に `// interface-env: A` のコメントがある場合、名前 `A` を返すことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(names('a.ts', '// interface-env: A\nconst x = process.env[name]')).toEqual(['A'])
    })
  })

  it('Python でも TypeScript でもないファイルは、環境変数の読み取りの検証の対象にしない', async () => {
    await explains('環境変数の読み取りを探す `scanEnvironmentReads` のテストです。拡張子が `.sh` のファイルを渡した場合に、読んだ名前と解決できない行のどちらも返さないことを確認します。')
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(scanEnvironmentReads({ path: 'a.sh', text: 'echo $A; os.environ["B"]' })).toEqual({ reads: [], unresolved: [] })
    })
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
  ] as const)('定義書の名前 %s とソースが読んだ名前 %s の組を渡すと、%s を返す', async (listed, read, expected) => {
    await explains(`定義書に挙げた名前が、ソースの読んだ名前に当たるかを判定する \`isListedName\` のテストです。定義書の名前 \`${listed}\` と読んだ名前 \`${read}\` の組を渡した場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(isListedName(listed, read)).toBe(expected)
    })
  })

  it.each([
    ['PECOT_GITHUB_API_URL', true],
    ['PECOT_GITHUB_*_TOKEN', true],
    ['PECOT_*', false],
    ['*_TOKEN', false],
    ['A_*_B_*_C', false],
    ['has space', false],
    ['', false],
  ] as const)('環境変数の名前 %j を検証すると、%s を返す', async (name, expected) => {
    await explains(`環境変数の名前の形式を検証する \`isValidEnvironmentName\` のテストです。名前 \`${JSON.stringify(name)}\` を渡した場合に、\`${String(expected)}\` を返すことを確認します。`)
    stepSync('環境変数の読みを調べて比べる', () => {
      expect(isValidEnvironmentName(name)).toBe(expected)
    })
  })

  it('定義書に無い名前は、最初に読むファイルを含む検証エラーにする', async () => {
    await explains('ソースが読む環境変数と、定義書の `environment` の整合を検証する `checkEnvironment` のテストです。定義書に無い名前を複数のファイルが読む場合に、ファイル名の順で最初のファイルを含む検証エラーを 1 件だけ返すことを確認します。')
    const findings = stepSync('環境変数の読みを調べる', () => checkEnvironment({
      pluginDir: 'plugins/p',
      authoredPath: 'plugins/p/interface/authored.yaml',
      listed: ['LISTED'],
      sources: [
        { path: 'plugins/p/cli/b.py', text: 'import os\nos.environ.get("X")\nos.environ.get("LISTED")\n' },
        { path: 'plugins/p/cli/a.py', text: 'import os\nos.environ.get("X")\n' },
      ],
    }))
    stepSync('結果を比べる', () => {
      expect(findings).toEqual([{ file: 'plugins/p/interface/authored.yaml', field: 'environment', reason: 'X is read by cli/a.py but not listed' }])
    })
  })
})
