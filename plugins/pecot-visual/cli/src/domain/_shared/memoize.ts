/**
最初の呼び出しで `create` を実行し、以降は同じ結果を返す。
*/
export function memoize<T>(create: () => T): () => T {
  let value: T | undefined
  return () => {
    value ??= create()
    return value
  }
}

/**
`memoize` の非同期版。進行中の Promise を保持するので、並行に呼んでも `create` は 1 回しか動かない。
`create` が reject した場合は結果を持たず、次の呼び出しでやり直す。
*/
export function memoizeAsync<T>(create: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  const run = async (): Promise<T> => {
    // pending の代入より先に create が同期で throw しても、後始末が代入を追い越さないようにする
    await Promise.resolve()
    try {
      return await create()
    }
    catch (error: unknown) {
      pending = undefined
      throw error
    }
  }
  return () => {
    pending ??= run()
    return pending
  }
}
