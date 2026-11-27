// PR をスタックに登録するときの判断。API を呼ばない純粋な関数で、pr create と actions の処理が共有する。

import type { PullRequestStack } from '../infra/github/pulls.js'

/**
スタックの登録の判断
- create: 親のスタックが無いので、親と子で作る
- add: 親のスタックの一番上が親なので、子を足す
- already: 子が親の直後に入っている
- conflict: 足せない。reason は理由
*/
export type StackRegistrationPlan
  = | { readonly kind: 'create', readonly pullRequests: readonly [number, number] }
    | { readonly kind: 'add', readonly stackNumber: number, readonly pullRequests: readonly [number] }
    | { readonly kind: 'already', readonly stack: PullRequestStack }
    | { readonly kind: 'conflict', readonly reason: string }

/**
親 PR・子 PR とそれぞれの今のスタックから、登録の判断を返す。GitHub は一番上にしか足せない
*/
export function planStackRegistration(parent: number, child: number, parentStack: Readonly<PullRequestStack> | undefined, childStack: Readonly<PullRequestStack> | undefined): StackRegistrationPlan {
  if (childStack !== undefined) {
    const parentIndex = childStack.pullRequests.indexOf(parent)
    return parentIndex !== -1 && childStack.pullRequests[parentIndex + 1] === child
      ? { kind: 'already', stack: childStack }
      : { kind: 'conflict', reason: `PR #${String(child)} is already in stack #${String(childStack.number)}` }
  }
  if (parentStack === undefined) return { kind: 'create', pullRequests: [parent, child] }
  const top = parentStack.pullRequests.at(-1)
  return top === parent
    ? { kind: 'add', stackNumber: parentStack.number, pullRequests: [child] }
    : { kind: 'conflict', reason: `PR #${String(parent)} is not the top of stack #${String(parentStack.number)} (top: PR #${String(top)})` }
}
