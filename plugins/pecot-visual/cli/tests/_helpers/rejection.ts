/**
promise が reject した理由を返す。resolve した場合は undefined を返す。
reject の理由そのものを検証するテストで、try/catch の記述を省くために使う。
*/
export async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  }
  catch (error: unknown) {
    return error
  }
}
