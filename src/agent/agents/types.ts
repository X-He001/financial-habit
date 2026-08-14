// ==================== Agent 接口定义 ====================

import type { Domain } from '../router'

export interface FollowUpQuestion {
  question: string
  basis: string // 生成依据：为什么问这个（必须引用实时数据）
}

export interface AgentContext {
  domain: Domain
  title: string
  text: string
  data: Record<string, unknown>
}

export interface Agent {
  id: Domain
  name: string
  description: string
  /** 基础系统提示（agent 专属角色与输出约束） */
  systemPrompt: string
  /** 从数据库实时算出该领域关键数据（纯代码） */
  computeContext(input?: { message?: string }): Promise<AgentContext>
}
