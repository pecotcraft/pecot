// chromium-preflight.sh の本体。OS のライブラリを確かめて足りなければ入れ、Chromium を起動できなければ落とす。
// 判定と導入は cli/dist の infra/playwright/host-dependencies.js を使う。
import {
  ensureChromiumHostDependencies,
  hostDependenciesDefaultDependencies,
} from '../../cli/dist/infra/playwright/host-dependencies.js'

const dependencies = {
  ...hostDependenciesDefaultDependencies(),
  notify: (message) => { process.stderr.write(`${message}\n`) },
}
const outcome = await ensureChromiumHostDependencies(dependencies)
switch (outcome.status) {
  case 'ok':
  case 'installed': {
    if (outcome.status === 'installed') process.stderr.write(`added: ${outcome.packages.join(' ')}\n`)
    dependencies.record('ok')
    break
  }
  case 'missing': {
    process.stderr.write(`error: ${outcome.detail}\n`)
    dependencies.record('missing')
    process.exitCode = 2
    break
  }
  case 'launch-failed': {
    process.stderr.write(`error: Chromium failed to launch (cause other than OS libraries): ${outcome.detail}\n`)
    dependencies.record('launch-failed')
    process.exitCode = 3
    break
  }
}
