// Lambda 系のツール定義。

import { z } from 'zod'

import {
  LAMBDA_GET_FUNCTION_CONFIGURATION,
  LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
  LAMBDA_LIST_FUNCTIONS,
} from '../../domain/allowlist.js'
import type { ToolDefinition } from '../server.js'
import {
  allowlistedTool,
  awsObject,
  awsObjects,
  COMMON_INPUT_SHAPE,
  MAX_ITEMS_PAGINATION_SHAPE,
  type ResponseShape,
  type ToolOptions,
} from './_shared.js'

function describeConfig(description: string): string {
  return `${description} (Lambda GetFunctionConfiguration response)`
}

/**
GetFunctionConfiguration の応答（FunctionConfiguration）の最上位のキー。
*/
const FUNCTION_CONFIGURATION_RESPONSE: ResponseShape = {
  FunctionName: z.string().describe(describeConfig('Function name')),
  FunctionArn: z.string().describe(describeConfig('Function ARN')),
  Runtime: z.string().describe(describeConfig('Runtime identifier')),
  Role: z.string().describe(describeConfig('Execution role ARN')),
  Handler: z.string().describe(describeConfig('Handler that Lambda calls')),
  CodeSize: z.number().describe(describeConfig('Deployment package size in bytes')),
  Description: z.string().describe(describeConfig('Function description')),
  Timeout: z.number().describe(describeConfig('Timeout in seconds')),
  MemorySize: z.number().describe(describeConfig('Memory in MB')),
  LastModified: z.string().describe(describeConfig('Last update time (ISO 8601)')),
  CodeSha256: z.string().describe(describeConfig('SHA256 hash of the deployment package')),
  Version: z.string().describe(describeConfig('Function version')),
  VpcConfig: awsObject(describeConfig('VpcConfigResponse object')),
  DeadLetterConfig: awsObject(describeConfig('DeadLetterConfig object')),
  Environment: awsObject(describeConfig('EnvironmentResponse object with the environment variables')),
  KMSKeyArn: z.string().describe(describeConfig('KMS key ARN')),
  TracingConfig: awsObject(describeConfig('TracingConfigResponse object')),
  MasterArn: z.string().describe(describeConfig('ARN of the main function of a Lambda@Edge function')),
  RevisionId: z.string().describe(describeConfig('Latest revision ID')),
  Layers: awsObjects(describeConfig('Layer objects')),
  State: z.string().describe(describeConfig('Current state of the function')),
  StateReason: z.string().describe(describeConfig('Reason for the current state')),
  StateReasonCode: z.string().describe(describeConfig('Reason code for the current state')),
  LastUpdateStatus: z.string().describe(describeConfig('Status of the last update')),
  LastUpdateStatusReason: z.string().describe(describeConfig('Reason for the last update status')),
  LastUpdateStatusReasonCode: z.string().describe(describeConfig('Reason code for the last update status')),
  FileSystemConfigs: awsObjects(describeConfig('FileSystemConfig objects')),
  SigningProfileVersionArn: z.string().describe(describeConfig('Signing profile version ARN')),
  SigningJobArn: z.string().describe(describeConfig('Signing job ARN')),
  PackageType: z.string().describe(describeConfig('Deployment package type (Zip or Image)')),
  ImageConfigResponse: awsObject(describeConfig('ImageConfigResponse object')),
  Architectures: z.array(z.string()).describe(describeConfig('Instruction set architectures')),
  EphemeralStorage: awsObject(describeConfig('EphemeralStorage object')),
  SnapStart: awsObject(describeConfig('SnapStartResponse object')),
  RuntimeVersionConfig: awsObject(describeConfig('RuntimeVersionConfig object')),
  LoggingConfig: awsObject(describeConfig('LoggingConfig object')),
  TenancyConfig: awsObject(describeConfig('TenancyConfig object')),
  CapacityProviderConfig: awsObject(describeConfig('CapacityProviderConfig object')),
  ConfigSha256: z.string().describe(describeConfig('SHA256 hash of the function configuration')),
  DurableConfig: awsObject(describeConfig('DurableConfig object')),
  RuntimeConfig: awsObject(describeConfig('FunctionRuntimeConfig object')),
}

export function lambdaTools(options: Readonly<ToolOptions> = {}): readonly ToolDefinition[] {
  return [
    allowlistedTool({
      entry: LAMBDA_LIST_FUNCTIONS,
      title: 'List Lambda functions',
      description: 'Lists Lambda functions in the region. For many functions, split with max_items and starting_token',
      inputSchema: z.object({ ...MAX_ITEMS_PAGINATION_SHAPE, ...COMMON_INPUT_SHAPE }),
      responseShape: {
        Functions: awsObjects('FunctionConfiguration objects of the Lambda ListFunctions response'),
      },
    }, options),
    allowlistedTool({
      entry: LAMBDA_GET_FUNCTION_CONFIGURATION,
      title: 'Get Lambda function configuration',
      description: 'Returns the configuration of one function (runtime, handler, environment variables, timeout, etc.)',
      inputSchema: z.object({
        function_name: z.string().describe('Function name, partial ARN, or full ARN'),
        qualifier: z.string().optional().describe('Version number or alias name. If omitted, $LATEST'),
        ...COMMON_INPUT_SHAPE,
      }),
      responseShape: FUNCTION_CONFIGURATION_RESPONSE,
    }, options),
    allowlistedTool({
      entry: LAMBDA_LIST_EVENT_SOURCE_MAPPINGS,
      title: 'List event source mappings',
      description: 'Lists the mappings between functions and event sources (SQS queues, DynamoDB streams, etc.). Filter by event_source_arn or function_name',
      inputSchema: z.object({
        event_source_arn: z.string().optional().describe('ARN of the event source (starts with arn:)'),
        function_name: z.string().optional().describe('Function name, partial ARN, or full ARN'),
        ...MAX_ITEMS_PAGINATION_SHAPE,
        ...COMMON_INPUT_SHAPE,
      }),
      responseShape: {
        EventSourceMappings: awsObjects('EventSourceMappingConfiguration objects of the Lambda ListEventSourceMappings response'),
      },
    }, options),
  ]
}
