// ==================== DeepSeek 调用（已有，保留） ====================
// 统一入口：agent 各模块从 src/agent/deepseek 引用，实际实现在 src/api/deepseek。
export {
  chatCompletion,
  agentCompletion,
  hasApiKey,
  aiErrorMessage,
  DEEPSEEK_API_KEY,
} from '../api/deepseek'
export type { ChatMessage, ChatTool, ChatCompletionOptions, ToolCall, AgentTurnResult } from '../api/deepseek'
