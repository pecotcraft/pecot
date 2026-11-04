#!/usr/bin/env node
import { main, REAL_DEPS } from '../lib/main.js'

// `process.exit` は使わず `exitCode` に積み、標準出力を書き切ってから終わらせる。
process.exitCode = await main(process.argv.slice(2), REAL_DEPS)
