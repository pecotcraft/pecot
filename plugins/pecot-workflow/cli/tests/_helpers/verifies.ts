/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- vitest の TestContext は mutable */
import type { TestContext } from 'vitest'

export async function verifies(context: TestContext, id: string): Promise<void> {
  await context.annotate(id, 'verifies')
}
