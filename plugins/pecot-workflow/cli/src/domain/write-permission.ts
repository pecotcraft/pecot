// collaborators の permission。maintain は write で返る
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'write'])

/**
collaborators の permission が、書き込み権限（admin・write）か
*/
export function isWritePermission(permission: string): boolean {
  return WRITE_PERMISSIONS.has(permission)
}
