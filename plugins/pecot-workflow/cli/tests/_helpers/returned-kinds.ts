// コマンドが stopWith・CommandExit に渡す失敗の原因の名前を、ソースから集める。
// 各コマンドの run から、src/commands の中の関数への参照をたどる。例外のクラスから決まる名前（kindOfFailure など）は集めない。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- コンパイラ API の型は readonly にできない */
import path from 'node:path'

import ts from 'typescript'

import { FAILURE_KINDS } from '../../src/commands/failure-kind.js'
import { interfaceIdOf } from '../../src/commands/command-definition.js'

const CLI_ROOT = path.resolve(import.meta.dirname, '../..')
const COMMANDS_DIRECTORY = path.join(CLI_ROOT, 'src', 'commands') + path.sep
const KNOWN_KINDS: ReadonlySet<string> = new Set(FAILURE_KINDS)

/**
名前と終了コード。終了コードが型から決まらないときは undefined
*/
export interface ReturnedKind {
  readonly kind: string
  readonly code: number | undefined
  /**
  stopWith・CommandExit を呼ぶ所（src/commands からの相対パスと行）
  */
  readonly at: string
}

function createProgram(): ts.Program {
  const configFile = ts.readConfigFile(path.join(CLI_ROOT, 'tsconfig.json'), ts.sys.readFile.bind(ts.sys))
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, CLI_ROOT)
  const roots = parsed.fileNames.filter(file => file.startsWith(COMMANDS_DIRECTORY) && !file.includes(`${path.sep}tests${path.sep}`))
  return ts.createProgram(roots, parsed.options)
}

function isInCommands(node: ts.Node): boolean {
  const file = node.getSourceFile().fileName
  return path.resolve(file).startsWith(COMMANDS_DIRECTORY)
}

// 括弧・as・satisfies を外した式（ts.skipOuterExpressions は公開の型に無い）
function unwrap(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) ? unwrap(expression.expression) : expression
}

// たどる先の本体。関数と、関数を値に持つオブジェクトの表（キーで選ぶ操作の表など）
function bodyOf(declaration: ts.Declaration): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body !== undefined) return declaration.body
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return undefined
  const initializer = unwrap(declaration.initializer)
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer.body
  return ts.isObjectLiteralExpression(initializer) ? initializer : undefined
}

// 文字列のリテラルの型の並び。名前の全体（FailureKind）や string は、例外から決まるので undefined
function literalStrings(type: ts.Type): readonly string[] | undefined {
  const parts = type.isUnion() ? type.types : [type]
  const literals = parts.filter(part => part.isStringLiteral())
  if (literals.length !== parts.length) return undefined
  const values = literals.map(part => part.value)
  return values.length === KNOWN_KINDS.size ? undefined : values
}

function literalNumber(type: ts.Type): number | undefined {
  return type.isNumberLiteral() ? type.value : undefined
}

class Collector {
  private readonly checker: ts.TypeChecker
  private readonly cache = new Map<ts.Node, readonly ReturnedKind[]>()

  constructor(private readonly program: ts.Program) {
    this.checker = program.getTypeChecker()
  }

  // 呼び出しの先が stopWith・CommandExit なら、渡した名前と終了コード
  private kindsAt(node: ts.CallExpression | ts.NewExpression): readonly ReturnedKind[] {
    const callee = ts.isIdentifier(node.expression) ? node.expression.text : undefined
    const arguments_ = node.arguments ?? ts.factory.createNodeArray()
    let kindArgument: ts.Expression | undefined
    let code: number | undefined
    if (callee === 'stopWith' && ts.isCallExpression(node)) {
      kindArgument = arguments_[2]
      const codeArgument = arguments_[3]
      code = codeArgument === undefined ? 1 : literalNumber(this.checker.getTypeAtLocation(codeArgument))
    }
    else if (callee === 'CommandExit' && ts.isNewExpression(node)) {
      kindArgument = arguments_[1]
      const codeArgument = arguments_[0]
      code = codeArgument === undefined ? undefined : literalNumber(this.checker.getTypeAtLocation(codeArgument))
    }
    if (kindArgument === undefined) return []
    const kinds = literalStrings(this.checker.getTypeAtLocation(kindArgument)) ?? []
    const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart())
    const at = `${path.relative(COMMANDS_DIRECTORY, node.getSourceFile().fileName)}:${String(line + 1)}`
    return kinds.map(kind => ({ kind, code, at }))
  }

  // path に定数を渡したときは、その宣言の配列のリテラルを読む
  private arrayLiteralOf(expression: ts.Expression): ts.ArrayLiteralExpression | undefined {
    const node = unwrap(expression)
    if (ts.isArrayLiteralExpression(node)) return node
    if (!ts.isIdentifier(node)) return undefined
    const declaration = this.checker.getSymbolAtLocation(node)?.declarations?.at(0)
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      ? this.arrayLiteralOf(declaration.initializer)
      : undefined
  }

  private declarationOf(identifier: ts.Identifier): ts.Node | undefined {
    const symbol = this.checker.getSymbolAtLocation(identifier)
    if (symbol === undefined) return undefined
    const resolved = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol)
    const declaration = resolved.declarations?.at(0)
    return declaration === undefined || !isInCommands(declaration) ? undefined : bodyOf(declaration)
  }

  /**
  node の中と、そこから参照する src/commands の関数の中で、stopWith・CommandExit に渡す名前
  */
  collect(root: ts.Node): readonly ReturnedKind[] {
    const cached = this.cache.get(root)
    if (cached !== undefined) return cached
    const found: ReturnedKind[] = []
    this.cache.set(root, found)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) found.push(...this.kindsAt(node))
      if (ts.isIdentifier(node)) {
        const target = this.declarationOf(node)
        if (target !== undefined) found.push(...this.collect(target))
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }

  /**
  defineCommand に渡したオブジェクトの path と run
  */
  definitions(): readonly { readonly id: string, readonly run: ts.Node }[] {
    const result: { id: string, run: ts.Node }[] = []
    for (const file of this.program.getSourceFiles()) {
      if (!path.resolve(file.fileName).startsWith(COMMANDS_DIRECTORY)) continue
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineCommand') {
          const spec = node.arguments[0]
          if (spec !== undefined && ts.isObjectLiteralExpression(spec)) {
            const property = (name: string): ts.Expression | undefined => {
              const found = spec.properties.find(item => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name)
              return found !== undefined && ts.isPropertyAssignment(found) ? found.initializer : undefined
            }
            const pathExpression = property('path')
            const pathNode = pathExpression === undefined ? undefined : this.arrayLiteralOf(pathExpression)
            const run = property('run')
            if (pathNode !== undefined && run !== undefined) {
              const words = pathNode.elements.filter(element => ts.isStringLiteral(element)).map(element => element.text)
              result.push({ id: interfaceIdOf(words), run })
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    return result
  }
}

/**
項目の ID ごとに、コマンドが stopWith・CommandExit に渡す名前と終了コード
*/
export function collectReturnedKinds(): ReadonlyMap<string, readonly ReturnedKind[]> {
  const collector = new Collector(createProgram())
  return new Map(collector.definitions().map(({ id, run }) => [id, collector.collect(run)]))
}
