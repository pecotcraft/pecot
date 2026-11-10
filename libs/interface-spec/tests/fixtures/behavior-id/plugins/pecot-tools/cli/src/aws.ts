import process from 'node:process'

export const profile = process.env.AWS_PROFILE

// interface-env: AWS_PROFILE
export const pick = (name: string) => process.env[name]
