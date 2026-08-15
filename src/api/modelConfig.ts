// =====================================================================
// AI 模型配置（src/api/modelConfig.ts）
// 设置页「AI 模型配置」的数据层：厂商表 + 读写 / 迁移 / 视觉判断。
// 所有 AI 调用（对话/报告/批量导入/截图/语音）统一从这里读取当前配置，
// 配置存在 IndexedDB settings 表，key = 'modelConfig'，改动即时生效。
// =====================================================================
import { getSetting, setSetting } from '../db/crud'
import { db } from '../db/database'

/** settings 表 key：旧版 DeepSeek API Key（迁移来源） */
export const DEEPSEEK_API_KEY = 'deepseekApiKey'
/** settings 表 key：当前模型配置（JSON 字符串） */
export const MODEL_CONFIG_KEY = 'modelConfig'

// ==================== 厂商与模型表 ====================

export type ModelProviderId = 'deepseek' | 'volcano' | 'kimi' | 'zhipu' | 'minimax' | 'qwen' | 'custom'

export interface ModelProvider {
  id: ModelProviderId
  label: string
  apiUrl: string
  models: string[]
  /** 该厂商支持视觉输入的模型（截图识别直接传图片） */
  visionModels: string[]
  /** 展示用备注（UI 下拉辅助说明） */
  note?: string
}

export interface ModelConfig {
  provider: ModelProviderId
  modelName: string
  apiUrl: string
  apiKey: string
}

export const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    label: '深度求索 / DeepSeek',
    apiUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    visionModels: [],
    note: '1M 上下文，支持思考/非思考模式',
  },
  {
    id: 'volcano',
    label: '火山引擎 / 豆包（Doubao）',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      'doubao-seed-1-8',
      'doubao-seed-code-preview',
      'ark-code-latest',
      'doubao-seed-1-6-flash-250615',
      'doubao-vision-pro-32k',
    ],
    visionModels: ['doubao-vision-pro-32k'],
    note: '火山引擎还托管了 Kimi、GLM、DeepSeek 等第三方模型',
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot（月之暗面）',
    apiUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
    visionModels: [],
    note: 'Kimi K3 为最新旗舰模型，2.8 万亿参数，1M 上下文',
  },
  {
    id: 'zhipu',
    label: '智谱 AI / Zhipu（GLM）',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['GLM-5.2', 'GLM-5.1', 'GLM-5', 'GLM-4.7', 'GLM-4.7-Flash', 'GLM-4V-Plus'],
    visionModels: ['GLM-4V-Plus'],
    note: 'GLM-4.7-Flash 完全免费',
  },
  {
    id: 'minimax',
    label: 'MiniMax（稀宇科技）',
    apiUrl: 'https://api.minimaxi.com/v1',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'],
    visionModels: ['MiniMax-M3'],
    note: 'MiniMax-M3 为最新旗舰，1M 上下文，原生多模态',
  },
  {
    id: 'qwen',
    label: '千问 / Qwen（阿里云）',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash', 'qwen3-vl-plus'],
    visionModels: ['qwen3-vl-plus'],
    note: '新用户送 7000 万 tokens 免费额度；视觉模型推荐 qwen3-vl-plus',
  },
  {
    id: 'custom',
    label: '自定义 / Custom',
    apiUrl: '',
    models: [],
    visionModels: [],
    note: 'API Base URL、模型 ID、API Key 均需手动输入',
  },
]

export const CUSTOM_PROVIDER_ID: ModelProviderId = 'custom'

export function getProvider(id: ModelProviderId): ModelProvider | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** 默认 DeepSeek 模型（旧配置迁移 / 新用户默认值用） */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/** 收集所有厂商的视觉模型（大小写不敏感比较） */
const VISION_MODELS = new Set(
  PROVIDERS.flatMap((p) => p.visionModels).map((m) => m.toLowerCase())
)

/** 当前模型是否支持视觉输入（截图识别直接传图片） */
export function isVisionModel(modelName: string): boolean {
  return VISION_MODELS.has(String(modelName || '').trim().toLowerCase())
}

// ==================== 读写配置 ====================

/** 保存当前模型配置到 settings 表（立即生效，下次 AI 调用即用新配置） */
export async function saveModelConfig(cfg: ModelConfig): Promise<void> {
  await setSetting(MODEL_CONFIG_KEY, JSON.stringify(cfg))
}

/**
 * 读取当前模型配置；未配置时返回 null。
 * 兼容旧版：若只有旧的 deepseekApiKey，自动迁移为 modelConfig 并写回。
 */
export async function getModelConfig(): Promise<ModelConfig | null> {
  const raw = await getSetting(MODEL_CONFIG_KEY)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const cfg = JSON.parse(raw) as ModelConfig
      if (
        cfg &&
        typeof cfg.modelName === 'string' && cfg.modelName.trim() &&
        typeof cfg.apiUrl === 'string' && cfg.apiUrl.trim() &&
        typeof cfg.apiKey === 'string' && cfg.apiKey.trim()
      ) {
        return {
          provider: cfg.provider ?? 'custom',
          modelName: cfg.modelName.trim(),
          apiUrl: cfg.apiUrl.trim(),
          apiKey: cfg.apiKey.trim(),
        }
      }
    } catch {
      // 数据损坏则忽略，走迁移/未配置
    }
  }

  // 迁移：旧版 DeepSeek API Key → 新 modelConfig
  const old = await getSetting(DEEPSEEK_API_KEY)
  if (typeof old === 'string' && old.trim()) {
    const migrated: ModelConfig = {
      provider: 'deepseek',
      modelName: DEFAULT_MODEL,
      apiUrl: 'https://api.deepseek.com',
      apiKey: old.trim(),
    }
    await saveModelConfig(migrated)
    return migrated
  }
  return null
}

/** 清除模型配置（同时清理旧版 DeepSeek API Key，避免再次自动迁移） */
export async function clearModelConfig(): Promise<void> {
  await db.settings.delete(MODEL_CONFIG_KEY)
  await db.settings.delete(DEEPSEEK_API_KEY)
}
