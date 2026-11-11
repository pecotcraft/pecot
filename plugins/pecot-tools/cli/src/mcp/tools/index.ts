// 公開するツールの集約。並びがそのまま tools/list の並びになる（SSO の 2 件が先頭）。

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
