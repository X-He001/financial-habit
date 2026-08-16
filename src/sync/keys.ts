// =====================================================================
// 同步相关 settings key（src/sync/keys.ts）
// 独立小模块：避免 syncHooks ↔ pushSync ↔ crud 之间循环依赖，
// 同时保证各处使用同一个 key 常量。
// =====================================================================

/** 云端服务器地址（settings key） */
export const SYNC_URL_KEY = 'syncServerUrl'

/** 最近同步时间（settings key；同步流程自身写入，不触发推送） */
export const LAST_SYNC_AT_KEY = 'lastSyncAt'
