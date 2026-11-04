// cli と PostToolUse hook が `--config` で渡す、デッキ lint の設定。
// 環境変数 PECOTV_DECK_LINT に、`slide theme --json` の lint（4 項目）を JSON で受ける。
// 既定 export を関数の module（deck-lint.config.js）から分けるのは、env を渡し忘れた起動が
// rules が空のまま静かに clean を返さないため。env の不在と JSON の破損は throw し、eslint を exit 2 で止める。
// 開発 lint（eslint.config.js）は関数の module だけを import するので、この throw に当たらない。
import { defineDeckLintConfig } from './deck-lint.config.js'

const ENV_NAME = 'PECOTV_DECK_LINT'

function readLintFromEnvironment() {
  const text = process.env[ENV_NAME]
  if (text === undefined || text === '') {
    throw new Error(`${ENV_NAME} が未設定です。slide theme --json の lint を JSON で渡してください`)
  }
  try {
    return JSON.parse(text)
  }
  catch (error) {
    throw new Error(`${ENV_NAME} を JSON として読めません: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export default defineDeckLintConfig(readLintFromEnvironment())
