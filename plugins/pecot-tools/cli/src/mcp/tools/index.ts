// 公開するツールの集約。serve.ts が createMcpServer() へ渡す。
//
// 並びは contracts/mcp-tools.md の表の順で、そのまま tools/list の並びになる。SSO の 2 件は
// 契約書で許可リストの表より前に置かれているため先頭に来る（許可リストには入らない）。
// 系統別の関数へ分けているのは、1 系統を足すときに触るファイルを閉じるため。

import type { ToolDefinition } from '../server.js'
import type { ToolOptions } from './_shared.js'
import { athenaTools } from './athena.js'
import { cloudwatchTools } from './cloudwatch.js'
import { ec2Tools } from './ec2.js'
import { ecrTools } from './ecr.js'
import { lambdaTools } from './lambda.js'
import { logsTools } from './logs.js'
import { rdsTools } from './rds.js'
import { s3Tools } from './s3.js'
import { schedulerTools } from './scheduler.js'
import { sqsTools } from './sqs.js'
import { ssoTools } from './sso.js'
import { stsTools } from './sts.js'

/**
tools/list に公開するツール。並びはそのまま tools/list の並びになる。
*/
export function allTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    ...ssoTools(options),
    ...stsTools(options),
    ...lambdaTools(options),
    ...logsTools(options),
    ...cloudwatchTools(options),
    ...sqsTools(options),
    ...athenaTools(options),
    ...s3Tools(options),
    ...rdsTools(options),
    ...schedulerTools(options),
    ...ecrTools(options),
    ...ec2Tools(options),
  ]
}
