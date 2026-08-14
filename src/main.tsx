import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App'
import { db } from './db/database'
import { initDefaultCategories, addSchedule, getAllSchedules } from './db/crud'

// PWA Service Worker 注册（自动更新）
registerSW({ immediate: true })

// 数据库就绪确认
console.log('✅ 数据库已就绪 financial-habit-db')

/** 业务表（保留 settings 表：DeepSeek Key / 预算 / 防护设置等配置） */
const BUSINESS_TABLES = [
  'transactions', 'categories', 'accounts', 'savingsGoals', 'sinkingFunds',
  'wishlist', 'wishlistChats', 'debts', 'savingsRules', 'notificationLogs',
  'schedules', 'balanceSnapshots', 'commitments', 'moods', 'consumerEvents',
  'decisionRecords', 'behaviorProfiles', 'insights',
  'creditAccounts', 'creditStatements', 'installments',
]

/** 一次性清空全部业务数据（保留 settings），仅首次运行，靠 localStorage 标记控制 */
async function runOneTimeClear(): Promise<void> {
  if (localStorage.getItem('oneTimeClearDone') === 'true') return
  try {
    await db.transaction('readwrite', BUSINESS_TABLES, async () => {
      await Promise.all(BUSINESS_TABLES.map((name) => db.table(name).clear()))
    })
    // 分类清空后重建默认分类，保证记账等功能正常
    await initDefaultCategories()
    localStorage.setItem('oneTimeClearDone', 'true')
    console.log('✅ 已一次性清空所有业务数据')
  } catch (err) {
    console.error('❌ 一次性清空失败：', err)
  }
}

// 挂载到 window 供控制台调试
;(window as unknown as Record<string, unknown>).db = db
;(window as unknown as Record<string, unknown>).addSchedule = addSchedule
;(window as unknown as Record<string, unknown>).getAllSchedules = getAllSchedules

// 先完成一次性清空（仅首次）与默认分类初始化，再渲染应用
runOneTimeClear().then(() => initDefaultCategories()).then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
