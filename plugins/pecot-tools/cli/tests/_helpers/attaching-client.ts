// SDK の Client はメソッドの引数が mutable な型なので、readonly の指定を外す。
/* eslint-disable @typescript-eslint/prefer-readonly-parameter-types */
// callTool・listTools が返した結果の全体を、呼び出し側が確かめる前に Allure へ添付する MCP クライアント。beforeAll の tools/list は、使うテストが添付する。
import { Client } from '@modelcontextprotocol/client'

import { attachJson, attachJsonInTest } from '../../../../../libs/interface-spec/src/vitest/attach.js'

export class AttachingClient extends Client {
  override async callTool(...arguments_: Parameters<Client['callTool']>): ReturnType<Client['callTool']> {
    const result = await super.callTool(...arguments_)
    attachJson(`${arguments_[0].name} の結果`, result)
    return result
  }

  override async listTools(...arguments_: Parameters<Client['listTools']>): ReturnType<Client['listTools']> {
    const result = await super.listTools(...arguments_)
    attachJsonInTest('tools/list の結果', result)
    return result
  }
}
