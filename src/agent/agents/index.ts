// ==================== 多 Agent 注册表 ====================

import type { Domain } from '../router'
import type { Agent } from './types'
import { financeAgent } from './financeAgent'
import { psychologyAgent } from './psychologyAgent'
import { decisionAgent } from './decisionAgent'
import { debtAgent } from './debtAgent'
import { savingsAgent } from './savingsAgent'
import { educationAgent } from './educationAgent'
import { growthAgent } from './growthAgent'

export type { Agent, AgentContext, FollowUpQuestion } from './types'
export { suggestQuestions } from './suggest'

export const AGENTS: Record<Domain, Agent> = {
  finance: financeAgent,
  psychology: psychologyAgent,
  decision: decisionAgent,
  debt: debtAgent,
  savings: savingsAgent,
  education: educationAgent,
  growth: growthAgent,
}

export const AGENT_LIST: Agent[] = Object.values(AGENTS)
