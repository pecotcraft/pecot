// hooks のテストが使うパス。conftest.py の project_root・core_dir・adapter_dir・hooks_dir に当たる。
import path from 'node:path'

// このファイルは plugins/pecot-workflow/cli-node/tests/hooks/_helpers/ にある。
export const projectRoot = path.resolve(import.meta.dirname, '../../../../../..')
export const pluginRoot = path.join(projectRoot, 'plugins', 'pecot-workflow')
export const hooksDirectory = path.join(pluginRoot, 'hooks')
export const coreDirectory = path.join(hooksDirectory, 'lib', 'core')
export const adapterDirectory = path.join(hooksDirectory, 'lib', 'adapters')
