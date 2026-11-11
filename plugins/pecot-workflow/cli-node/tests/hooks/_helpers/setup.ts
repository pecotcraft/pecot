// hooks project の setupFiles。素の git や子プロセスが、親の GIT_* やプラグインのデータ置き場を継承しないようにする。
import { GIT_ENV_LEAK_KEYS, PLUGIN_ENV_LEAK_KEYS } from './environment.js'

for (const name of [...GIT_ENV_LEAK_KEYS, ...PLUGIN_ENV_LEAK_KEYS]) Reflect.deleteProperty(process.env, name)
