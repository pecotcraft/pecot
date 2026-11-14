// MCP ツール名の語彙。名前は `aws_<サービス>_<awscli の操作>` で、定義書の書き出しが names に写す。

/**
ツール名の語と、その意味
*/
export interface ToolNameWord {
  readonly word: string
  readonly meaning: string
}

export const TOOL_NAME_SEPARATOR = '_'

/**
ツール名の 1 語目
*/
export const TOOL_PREFIXES: readonly ToolNameWord[] = [
  { word: 'aws', meaning: 'a command of the AWS CLI' },
]

/**
ツール名の 2 語目。awscli のサービス名。3 語目からは awscli の操作名を `_` でつなぐ
*/
export const TOOL_SERVICES: readonly ToolNameWord[] = [
  { word: 'athena', meaning: 'Amazon Athena' },
  { word: 'cloudwatch', meaning: 'Amazon CloudWatch metrics' },
  { word: 'ec2', meaning: 'Amazon EC2' },
  { word: 'ecr', meaning: 'Amazon ECR' },
  { word: 'lambda', meaning: 'AWS Lambda' },
  { word: 'logs', meaning: 'Amazon CloudWatch Logs' },
  { word: 'rds', meaning: 'Amazon RDS' },
  { word: 's3', meaning: 'Amazon S3 (high-level commands)' },
  { word: 's3api', meaning: 'Amazon S3 (API commands)' },
  { word: 'scheduler', meaning: 'Amazon EventBridge Scheduler' },
  { word: 'sqs', meaning: 'Amazon SQS' },
  { word: 'sso', meaning: 'AWS IAM Identity Center sign-in' },
  { word: 'sts', meaning: 'AWS STS' },
]
