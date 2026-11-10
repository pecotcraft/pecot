export const read = (name: string) => process.env[name]
export const all = { ...process.env }
