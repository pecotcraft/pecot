// callTool・listTools の結果を、返す前に Allure の添付として残す MCP クライアントの包み。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types -- SDK の Client は mutable なクラス型 */

import type { Client } from '@modelcontextprotocol/client'

import { attachJson, attachJsonInTest } from '../../../../../libs/interface-spec/src/vitest/attach.js'

/**
渡したクライアントの callTool・listTools を、結果の全体を添付してから返す形に差し替える。同じクライアントを返す。beforeAll の tools/list は、使うテストが添付する。
*/
export function attachingClient(client: Client): Client {
  const callTool = client.callTool.bind(client)
  const listTools = client.listTools.bind(client)
  client.callTool = async (...parameters: Parameters<Client['callTool']>) => {
    const result = await callTool(...parameters)
    attachJson(`${parameters[0].name} の結果`, result)
    return result
  }
  client.listTools = async (...parameters: Parameters<Client['listTools']>) => {
    const result = await listTools(...parameters)
    attachJsonInTest('tools/list の結果', result)
    return result
  }
  return client
}
