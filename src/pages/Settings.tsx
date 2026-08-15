import { useState, useEffect, useRef } from 'react'
import { getSetting, setSetting, initDefaultCategories } from '../db/crud'
import { db } from '../db/database'
import { testModelConnection } from '../api/deepseek'
import {
  PROVIDERS, getProvider, CUSTOM_PROVIDER_ID, DEFAULT_MODEL,
  getModelConfig, saveModelConfig, clearModelConfig,
} from '../api/modelConfig'
import type { ModelProviderId, ModelConfig } from '../api/modelConfig'
import { getAiMonthCount } from '../utils/aiUsage'
import {
  buildSummaryJson, buildFullBackup, importFullBackup, downloadJson,
  type BackupFile, type ImportStats,
} from '../utils/exporter'
import {
  getSyncServerUrl, setSyncServerUrl, testServerConnection, pushSync,
} from '../sync/pushSync'
import { pullSync } from '../sync/pullSync'

// 表名 → 中文（导入统计展示用）
const TABLE_LABEL: Record<string, string> = {
  transactions: '交易', accounts: '账户', savingsGoals: '储蓄目标', sinkingFunds: '偿债基金',
  wishlist: '欲望清单', wishlistChats: '清单对话', debts: '债务', savingsRules: '储蓄规则',
  notificationLogs: '通知日志', categories: '分类', schedules: '日程', settings: '设置',
  balanceSnapshots: '净资产快照', commitments: '承诺', moods: '心情',
  consumerEvents: '消费事件', decisionRecords: '决策记录', behaviorProfiles: '行为画像',
  insights: '洞察', creditAccounts: '负债账户', creditStatements: '账单', installments: '分期',
}

// 平台每日限额可选平台
const PLATFORM_OPTIONS = ['拼多多', '京东', '淘宝', '抖音', '美团', '淘宝闪购']

function importStatsText(stats: ImportStats): string {
  const parts: string[] = []
  for (const key of Object.keys(stats)) {
    if ((stats[key] ?? 0) > 0) {
      parts.push(`${TABLE_LABEL[key] ?? key}${stats[key]}条`)
    }
  }
  return parts.length > 0 ? `成功导入 ${parts.join(' / ')}` : '导入完成（无新增记录）'
}

/** 开关（复用蓝白规范） */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick}
      style={{
        width: 44, height: 24, borderRadius: 999, cursor: 'pointer', position: 'relative', flexShrink: 0,
        background: on ? '#0040FF' : '#C0C4C4', transition: 'background 0.2s',
      }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: '50%',
        background: '#D8DADA', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  )
}

export default function Settings() {
  // AI 模型配置
  const [provider, setProvider] = useState<ModelProviderId>('deepseek')
  const [modelName, setModelName] = useState(DEFAULT_MODEL)
  const [apiUrl, setApiUrl] = useState('https://api.deepseek.com')
  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelConfigured, setModelConfigured] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [aiCount, setAiCount] = useState(0)
  // 防护设置
  const [nightLock, setNightLock] = useState(false)
  const [fragileReminder, setFragileReminder] = useState(true)
  const [feedbackReminder, setFeedbackReminder] = useState(true)
  const [platformLimit, setPlatformLimit] = useState<{ platform: string; amountMinor: number }[]>([])
  const [platformSel, setPlatformSel] = useState(PLATFORM_OPTIONS[0])
  const [platformAmt, setPlatformAmt] = useState('')
  const [editingPlatform, setEditingPlatform] = useState<string | null>(null)
  // 桌宠 / 备份
  const [petBusy, setPetBusy] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  // 数据同步
  const [syncUrl, setSyncUrl] = useState('')
  const [syncStatus, setSyncStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncResult, setSyncResult] = useState<string | null>(null)
  // PWA 安装提示
  const [installEvt, setInstallEvt] = useState<Event | null>(null)
  // 响应式：<900px 降单栏
  const [isWide, setIsWide] = useState(window.innerWidth >= 900)

  useEffect(() => { load() }, [])

  // 监听 PWA beforeinstallprompt（浏览器支持时弹出安装提示）
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setInstallEvt(e) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])

  // 响应式：监听窗口宽度
  useEffect(() => {
    const h = () => setIsWide(window.innerWidth >= 900)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  async function handleInstall() {
    if (!installEvt) return
    const evt = installEvt as Event & { prompt: () => Promise<void> }
    await evt.prompt()
    setInstallEvt(null)
  }

  async function load() {
    // AI 模型配置（兼容旧版 deepseekApiKey 自动迁移）
    const cfg = await getModelConfig()
    if (cfg) {
      setProvider(cfg.provider)
      setModelName(cfg.modelName)
      setApiUrl(cfg.apiUrl)
      setApiKey(cfg.apiKey)
      setModelConfigured(true)
    } else {
      const p = PROVIDERS[0]
      setProvider(p.id)
      setModelName(p.models[0])
      setApiUrl(p.apiUrl)
    }
    setAiCount(await getAiMonthCount())
    const [nl, fr, pl, frEnabled] = await Promise.all([
      getSetting('nightLock'), getSetting('fragileReminder'), getSetting('platformLimit'), getSetting('feedbackReminderEnabled'),
    ])
    setNightLock(nl === 'true')
    setFragileReminder(fr !== 'false')
    setFeedbackReminder(frEnabled !== 'false')
    // 平台限额：数组（多平台），兼容旧版单对象 {platform, amountMinor}
    if (typeof pl === 'string') {
      try {
        const p = JSON.parse(pl)
        if (Array.isArray(p)) {
          setPlatformLimit(p.filter((x: unknown): x is { platform: string; amountMinor: number } =>
            !!x && typeof (x as { platform?: unknown }).platform === 'string' && typeof (x as { amountMinor?: unknown }).amountMinor === 'number'))
        } else if (p && typeof (p as { platform?: unknown }).platform === 'string' && typeof (p as { amountMinor?: unknown }).amountMinor === 'number') {
          setPlatformLimit([{ platform: (p as { platform: string }).platform, amountMinor: (p as { amountMinor: number }).amountMinor }])
        }
      } catch { /* ignore */ }
    }
    setSyncUrl(await getSyncServerUrl())
  }

  // ==================== AI 模型配置 ====================

  /** 选择厂商：自动加载该厂商第一个模型并填充 API Base URL（自定义模式保留手动输入） */
  function handleProviderChange(id: ModelProviderId) {
    setProvider(id)
    setTestResult(null)
    if (id === CUSTOM_PROVIDER_ID) return
    const p = getProvider(id)
    if (p && p.models.length > 0) {
      setModelName(p.models[0])
      setApiUrl(p.apiUrl)
    }
  }

  /** 选择模型：自动填充 API Base URL（按厂商表） */
  function handleModelChange(m: string) {
    setModelName(m)
    setTestResult(null)
    const p = getProvider(provider)
    if (p && p.id !== CUSTOM_PROVIDER_ID) setApiUrl(p.apiUrl)
  }

  async function handleSaveModel() {
    const p = provider
    const m = modelName.trim()
    const u = apiUrl.trim()
    const k = apiKey.trim()
    if (p === CUSTOM_PROVIDER_ID) {
      if (!u) {
        setToast('请填写 API Base URL')
        setTimeout(() => setToast(null), 2000)
        return
      }
      if (!m) {
        setToast('请填写模型 ID')
        setTimeout(() => setToast(null), 2000)
        return
      }
    }
    if (!k) {
      setToast('请填写 API Key')
      setTimeout(() => setToast(null), 2000)
      return
    }
    const cfg: ModelConfig = { provider: p, modelName: m, apiUrl: u, apiKey: k }
    await saveModelConfig(cfg)
    setModelConfigured(true)
    setToast('✅ 配置已保存，立即生效')
    setTimeout(() => setToast(null), 2500)
  }

  /** 测试连接：用当前表单里的配置（未保存也测）调用 /chat/completions */
  async function handleTestModel() {
    if (testBusy) return
    if (!apiKey.trim()) {
      setToast('请先填写 API Key')
      setTimeout(() => setToast(null), 2000)
      return
    }
    setTestBusy(true)
    setTestResult(null)
    const r = await testModelConnection({
      provider, modelName: modelName.trim(), apiUrl: apiUrl.trim(), apiKey: apiKey.trim(),
    })
    setTestResult(r)
    setTestBusy(false)
    setToast(r.ok ? '✅ 连接成功' : '❌ 连接失败')
    setTimeout(() => setToast(null), 2500)
  }

  async function handleClearModel() {
    await clearModelConfig()
    setApiKey('')
    setModelConfigured(false)
    setTestResult(null)
    setToast('已清除 AI 模型配置')
    setTimeout(() => setToast(null), 2000)
  }

  // ==================== 平台每日限额 ====================

  /** 设置/更新某平台每日限额（读现有列表 → 同平台更新或追加 → 写回 settings） */
  async function handleSetPlatform() {
    const amt = parseFloat(platformAmt)
    if (isNaN(amt) || amt <= 0) {
      setToast('请输入大于 0 的限额金额')
      setTimeout(() => setToast(null), 2000)
      return
    }
    const amountMinor = Math.round(amt * 100)
    const raw = await getSetting('platformLimit')
    let list: { platform: string; amountMinor: number }[] = []
    if (typeof raw === 'string' && raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          list = parsed.filter((x: unknown): x is { platform: string; amountMinor: number } =>
            !!x && typeof (x as { platform?: unknown }).platform === 'string' && typeof (x as { amountMinor?: unknown }).amountMinor === 'number')
        } else if (parsed && typeof (parsed as { platform?: unknown }).platform === 'string' && typeof (parsed as { amountMinor?: unknown }).amountMinor === 'number') {
          list = [{ platform: (parsed as { platform: string }).platform, amountMinor: (parsed as { amountMinor: number }).amountMinor }]
        }
      } catch { /* 数据损坏则忽略 */ }
    }
    const target = editingPlatform ?? platformSel
    const exist = list.findIndex(x => x.platform === target)
    if (exist >= 0) list[exist] = { platform: target, amountMinor }
    else list.push({ platform: target, amountMinor })
    await setSetting('platformLimit', JSON.stringify(list))
    setPlatformLimit(list)
    setPlatformAmt('')
    setEditingPlatform(null)
    setToast(`✅ 已设置${target}每日限额 ¥${(amountMinor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`)
    setTimeout(() => setToast(null), 2500)
  }

  /** 修改：把该平台限额填入输入框，进入编辑态 */
  function handleEditPlatform(p: { platform: string; amountMinor: number }) {
    setPlatformSel(p.platform)
    setPlatformAmt(String(p.amountMinor / 100))
    setEditingPlatform(p.platform)
  }

  /** 删除某平台限额 */
  async function handleDeletePlatform(p: string) {
    const list = platformLimit.filter(x => x.platform !== p)
    await setSetting('platformLimit', JSON.stringify(list))
    setPlatformLimit(list)
    if (editingPlatform === p) { setEditingPlatform(null); setPlatformAmt('') }
    setToast(`已解除${p}的每日限额`)
    setTimeout(() => setToast(null), 2000)
  }

  // ==================== 桌宠数据 ====================

  async function handlePetExport() {
    if (petBusy) return
    setPetBusy(true)
    try {
      const json = await buildSummaryJson()
      downloadJson('summary.json', json)
      setToast('✅ summary.json 已下载')
    } catch (err) {
      setToast('❌ 生成失败：' + String(err))
    } finally {
      setPetBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  async function handlePetCopy() {
    if (petBusy) return
    setPetBusy(true)
    try {
      const json = await buildSummaryJson()
      await navigator.clipboard.writeText(JSON.stringify(json, null, 2))
      setToast('✅ 已复制到剪贴板')
    } catch {
      setToast('❌ 复制失败（浏览器限制，可用下载按钮）')
    } finally {
      setPetBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  // ==================== 数据备份 ====================

  async function handleBackupExport() {
    if (backupBusy) return
    setBackupBusy(true)
    try {
      const backup = await buildFullBackup()
      const d = new Date()
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      downloadJson(`financial-habit-backup-${ds}.json`, backup)
      // 记录最近备份时间（首页据此提醒"该备份了"）
      await setSetting('lastBackupAt', Date.now())
      setToast('✅ 备份文件已下载')
    } catch (err) {
      setToast('❌ 导出失败：' + String(err))
    } finally {
      setBackupBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  function handleImportClick() {
    importInputRef.current?.click()
  }

  /** 解析选择的备份文件 → 二次确认 → 导入 */
  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as BackupFile
      if (parsed?.app !== 'financial-habit' || !parsed?.data) {
        setToast('❌ 不是有效的备份文件')
        setTimeout(() => setToast(null), 2500)
        return
      }
      const confirmMsg = '导入将覆盖当前全部数据，确定？\n\n建议先点「📤 导出全部数据」备份。'
      if (!window.confirm(confirmMsg)) return
      setImportBusy(true)
      const stats = await importFullBackup(parsed, 'overwrite')
      setToast('✅ ' + importStatsText(stats))
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      setToast('❌ 导入失败：' + String(err))
      setTimeout(() => setToast(null), 3000)
    } finally {
      setImportBusy(false)
    }
  }

  // ==================== 清空业务数据（保留设置） ====================

  /** 业务表（不包含 settings；categories 清空后重建默认分类） */
  const BUSINESS_TABLES = [
    'transactions', 'categories', 'accounts', 'savingsGoals', 'sinkingFunds',
    'wishlist', 'wishlistChats', 'debts', 'savingsRules', 'notificationLogs',
    'schedules', 'balanceSnapshots', 'commitments', 'moods', 'consumerEvents',
    'decisionRecords', 'behaviorProfiles', 'insights',
    'creditAccounts', 'creditStatements', 'installments',
  ]

  /** 清空全部业务数据，保留 settings（API Key / 预算 / 防护设置等配置），不可恢复，需二次确认 */
  async function handleClearBusinessData() {
    const confirmMsg =
      '此操作将永久删除所有交易/储蓄/债务/欲望清单/日程/承诺/快照/心情/画像数据，且不可恢复。\n\n' +
      '建议先导出备份。确定要清空吗？'
    if (!window.confirm(confirmMsg)) return
    try {
      await db.transaction('readwrite', BUSINESS_TABLES, async () => {
        await Promise.all(BUSINESS_TABLES.map(name => db.table(name).clear()))
      })
      // 分类清空后重建默认分类，保证记账等功能正常
      await initDefaultCategories()
      setToast('✅ 业务数据已清空，设置已保留')
      setTimeout(() => window.location.reload(), 1200)
    } catch (err) {
      setToast('❌ 清空失败：' + String(err))
      setTimeout(() => setToast(null), 3000)
    }
  }

  // ==================== 数据同步（本地 → 云端） ====================

  /** 保存云端地址 + 测连接 */
  async function handleSyncConnect() {
    const url = syncUrl.trim()
    if (!url) {
      setToast('请输入云端地址')
      setTimeout(() => setToast(null), 2000)
      return
    }
    setSyncBusy(true)
    setSyncStatus(null)
    try {
      await setSyncServerUrl(url)
      const r = await testServerConnection(url)
      setSyncStatus(r)
      setToast(r.ok ? '✅ ' + r.message : '❌ ' + r.message)
    } catch (e) {
      setSyncStatus({ ok: false, message: String(e) })
      setToast('❌ 连接失败')
    } finally {
      setSyncBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  /** 全量推送：所有核心表逐条 POST/PUT 到云端 */
  async function handleSyncPush() {
    if (syncBusy) return
    setSyncBusy(true)
    setSyncResult(null)
    try {
      const r = await pushSync()
      if (!r.ok) {
        setSyncResult('推送失败：' + (r.error ?? '未知错误'))
        setToast('推送失败，请确认云端地址可用')
        return
      }
      const lines: string[] = []
      for (const [table, stats] of Object.entries(r.byTable)) {
        const name = TABLE_LABEL[table] ?? table
        const parts: string[] = []
        if (stats.pushed > 0) parts.push(`${stats.pushed}条新增`)
        if (stats.updated > 0) parts.push(`${stats.updated}条更新`)
        if (stats.failed > 0) parts.push(`${stats.failed}条失败`)
        if (parts.length > 0) lines.push(`${name}：${parts.join(' / ')}`)
      }
      const msg = lines.length > 0
        ? `成功推送 ${r.total} 条（${lines.join('；')}）`
        : '推送完成（本地暂无待推数据）'
      setSyncResult(msg)
      setToast('已推送本地数据到云端')
    } catch (e) {
      setSyncResult('推送失败：' + String(e))
    } finally {
      setSyncBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  /** 从云端拉取：用云端数据覆盖本地全部业务表（云端为准），需二次确认 */
  async function handleSyncPull() {
    if (syncBusy) return
    const confirmMsg =
      '从云端拉取将用云端数据覆盖本地全部数据（交易/储蓄/债务/清单/日程/设置等 21 张表），' +
      '本地未推送过云端的数据会丢失。\n\n' +
      '建议先「推送本地数据到云端」再拉取，保证云端是最新数据。确定继续？'
    if (!window.confirm(confirmMsg)) return
    setSyncBusy(true)
    setSyncResult(null)
    try {
      const r = await pullSync()
      if (!r.ok) {
        setSyncResult('拉取失败：' + (r.error ?? '未知错误'))
        setToast('拉取失败，请确认云端地址可用')
        return
      }
      const lines: string[] = []
      for (const [table, stats] of Object.entries(r.byTable)) {
        if (stats.pushed > 0) {
          lines.push(`${TABLE_LABEL[table] ?? table}${stats.pushed}条`)
        }
      }
      const msg = lines.length > 0
        ? `✅ 已从云端拉取 ${r.total} 条数据（${lines.join(' / ')}）`
        : '✅ 拉取完成（云端暂无数据）'
      setSyncResult(msg)
      setToast('已从云端拉取数据，即将刷新生效')
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) {
      setSyncResult('拉取失败：' + String(e))
    } finally {
      setSyncBusy(false)
      setTimeout(() => setToast(null), 2500)
    }
  }

  const maskKey = (k: string) => {
    if (k.length <= 4) return '****'
    return '••••••••' + k.slice(-4)
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
    fontSize: 14, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)',
    boxSizing: 'border-box', background: '#E8EAEA',
  }

  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #C0C4C4',
    fontSize: 14, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)',
    boxSizing: 'border-box', background: '#E8EAEA',
  }

  return (
    <div style={{ maxWidth: 1100, width: '100%' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)',
          background: '#111111', color: '#FFFFFF', padding: '10px 24px', borderRadius: 12,
          fontSize: 14, fontWeight: 500, zIndex: 100, boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        }}>
          {toast}
        </div>
      )}

      <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>设置</h1>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 24 }}>配置 AI 能力（模型厂商 / 对话 / 报告 / 截图识别 / 语音记账）</p>

      {/* 两栏布局：左 2/3 主要设置 · 右 1/3 说明/用量/关于 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isWide ? '2fr 1fr' : '1fr',
        gap: 24,
        alignItems: 'start',
      }}>
        {/* ========== 左栏：主要设置 ========== */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* AI 模型配置 */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)' }}>🤖 AI 模型配置</span>
              <span style={{
                fontSize: 12, padding: '3px 10px', borderRadius: 20, fontWeight: 600,
                background: modelConfigured ? 'rgba(34,211,238,0.08)' : '#E4E6E6',
                color: modelConfigured ? '#22D3EE' : '#888888',
              }}>
                {modelConfigured
                  ? `已配置 · ${modelName}${apiKey ? ` · 尾号 ${maskKey(apiKey)}` : ''}`
                  : '未配置'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16, lineHeight: 1.7 }}>
              AI 对话、AI 报告、截图识别、批量导入账单都会使用这里选择的模型（OpenAI 兼容格式）。
              Key 保存在浏览器本地，也会随数据同步上传到你自己的服务器，供后端代理调用。
            </div>

            {/* 厂商（一级下拉） */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>模型厂商</div>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value as ModelProviderId)}
              style={{ ...selectStyle, marginBottom: 14 }}
            >
              {PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>
                  {p.label}{p.note ? `（${p.note}）` : ''}
                </option>
              ))}
            </select>

            {/* 模型（二级下拉，联动加载；自定义模式为手动输入） */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>
              {provider === CUSTOM_PROVIDER_ID ? '模型 ID' : '具体模型'}
            </div>
            {provider === CUSTOM_PROVIDER_ID ? (
              <input
                value={modelName}
                onChange={(e) => { setModelName(e.target.value); setTestResult(null) }}
                placeholder="如 my-custom-model"
                style={{ ...inputStyle, marginBottom: 14 }}
              />
            ) : (
              <select
                value={modelName}
                onChange={(e) => handleModelChange(e.target.value)}
                style={{ ...selectStyle, marginBottom: 14 }}
              >
                {(getProvider(provider)?.models ?? []).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            )}

            {/* API Base URL（预设自动填充，可手动改；自定义必须手填） */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>API Base URL</div>
            <input
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setTestResult(null) }}
              placeholder="https://api.example.com/v1"
              style={{ ...inputStyle, marginBottom: 14 }}
            />

            {/* API Key */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>API Key</div>
            <div style={{ position: 'relative', marginBottom: 14 }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setTestResult(null) }}
                placeholder="sk-..."
                style={inputStyle}
              />
              <button
                onClick={() => setShowApiKey(v => !v)}
                title={showApiKey ? '隐藏' : '显示'}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: '#888888', fontSize: 14, cursor: 'pointer',
                }}>
                {showApiKey ? '🙈' : '👁'}
              </button>
            </div>

            {/* 测试连接结果 */}
            {testResult && (
              <div style={{
                padding: '9px 12px', borderRadius: 10, marginBottom: 14, fontSize: 12.5, lineHeight: 1.6,
                background: testResult.ok ? 'rgba(34,197,94,0.08)' : '#FEF2F2',
                color: testResult.ok ? '#16A34A' : '#D73333', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
              }}>
                {testResult.ok ? '✅ 连接成功' : '❌ ' + testResult.message}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => void handleTestModel()}
                disabled={testBusy}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                  fontSize: 14, cursor: testBusy ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-stack)',
                  opacity: testBusy ? 0.6 : 1,
                }}>
                {testBusy ? '测试中…' : '🔄 测试连接'}
              </button>
              <button onClick={() => void handleSaveModel()} className="btn-primary" style={{ padding: '9px 24px' }}>保存</button>
              {modelConfigured && (
                <button onClick={() => void handleClearModel()}
                  style={{
                    padding: '9px 18px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
                    background: '#D8DADA', border: '1px solid #C0C4C4', color: '#888888', fontFamily: 'var(--font-stack)',
                  }}>
                  清除
                </button>
              )}
            </div>
          </div>

          {/* 防护设置 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>🛡️ 防护设置</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16 }}>记账时的主动拦截与确认规则</div>

            {/* 深夜二次确认 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #C0C4C4' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>🌙 深夜购物二次确认</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>22:00-06:00 的购物类记账先弹一次确认</div>
              </div>
              <Toggle on={nightLock} onClick={() => { setNightLock(v => !v); void setSetting('nightLock', nightLock ? 'false' : 'true') }} />
            </div>

            {/* 高频窗口提醒 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #C0C4C4' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>⏰ 高频冲动窗口提醒</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>在易冲动时段记账时，顶部显示温和提醒条</div>
              </div>
              <Toggle on={fragileReminder} onClick={() => { setFragileReminder(v => !v); void setSetting('fragileReminder', fragileReminder ? 'false' : 'true') }} />
            </div>

            {/* 购买反馈提醒（30 天购买反馈） */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #C0C4C4' }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>🕐 购买反馈提醒</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>买满 30 天时，首页顶部提醒你"用上了吗"</div>
              </div>
              <Toggle on={feedbackReminder} onClick={() => { setFeedbackReminder(v => !v); void setSetting('feedbackReminderEnabled', feedbackReminder ? 'false' : 'true') }} />
            </div>

            {/* 平台限额管理（手动输入） */}
            <div style={{ padding: '14px 0' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>🎯 平台每日限额</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2, marginBottom: 12 }}>
                平台当日购物类支出超限时，记账会弹确认提醒
              </div>

              {/* 已设置列表 */}
              {platformLimit.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                  {platformLimit.map(x => (
                    <div key={x.platform} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 12px', background: '#E4E6E6', borderRadius: 10, border: '1px solid #C0C4C4',
                    }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: '#111111' }}>{x.platform}</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#0040FF', fontVariantNumeric: 'tabular-nums' }}>
                        每日 ¥{(x.amountMinor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
                      </span>
                      <button onClick={() => handleEditPlatform(x)}
                        style={{
                          padding: '5px 12px', borderRadius: 8, border: '1px solid #C0C4C4', background: '#D8DADA',
                          color: '#0040FF', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                        }}>
                        修改
                      </button>
                      <button onClick={() => void handleDeletePlatform(x.platform)}
                        style={{
                          padding: '5px 12px', borderRadius: 8, border: '1px solid rgba(0,64,255,0.2)', background: '#D8DADA',
                          color: '#0040FF', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                        }}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 新增 / 编辑 */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={platformSel} onChange={e => setPlatformSel(e.target.value)}
                  style={{
                    padding: '9px 10px', borderRadius: 10, border: '1px solid #C0C4C4',
                    fontSize: 13, color: 'var(--color-text)', outline: 'none', background: '#D8DADA',
                    fontFamily: 'var(--font-stack)',
                  }}>
                  {PLATFORM_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <div style={{ position: 'relative', flex: 1, minWidth: 140 }}>
                  <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: '#888888' }}>¥</span>
                  <input
                    value={platformAmt}
                    onChange={e => setPlatformAmt(e.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="每日限额（元）"
                    inputMode="decimal"
                    style={{ ...inputStyle, paddingLeft: 26 }}
                  />
                </div>
                <button onClick={() => void handleSetPlatform()} className="btn-primary" style={{ padding: '9px 20px', fontSize: 13 }}>
                  {editingPlatform ? '更新' : '设置'}
                </button>
                {editingPlatform && (
                  <button onClick={() => { setEditingPlatform(null); setPlatformAmt('') }}
                    style={{
                      padding: '9px 16px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                      color: '#888888', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                    }}>
                    取消
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 桌宠数据 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>🐾 桌宠数据</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16, lineHeight: 1.7 }}>
              把生成的 summary.json 放进你的同步文件夹（iCloud/Dropbox），桌宠读取它就知道你本月还剩多少钱、存了多少、负债多少。
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => void handlePetExport()} disabled={petBusy} className="btn-primary" style={{ padding: '9px 20px', fontSize: 13.5, opacity: petBusy ? 0.6 : 1 }}>
                {petBusy ? '生成中…' : '⬇️ 生成 summary.json'}
              </button>
              <button onClick={() => void handlePetCopy()} disabled={petBusy}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                  color: '#888888', fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-stack)', opacity: petBusy ? 0.6 : 1,
                }}>
                📋 复制 JSON
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#888888', marginTop: 12, lineHeight: 1.8 }}>
              集成方式：桌宠读取 summary.json 的 <b style={{ color: '#888888' }}>deskPetMessage / alerts</b> 做气泡提醒，
              读 <b style={{ color: '#888888' }}>summary</b> 里的数字做小看板。建议每次记账后重新生成一次，替换同步文件夹里的旧文件即可。
            </div>
          </div>

          {/* 数据备份 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>💾 数据备份</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
              导出全部数据（交易/分类/储蓄/债务/清单/日程/承诺/快照/心情/设置/画像/洞察等全部 22 张表）到 JSON 文件，可在新设备或恢复后完整还原
            </div>
            {/* 手机清理风险醒目提醒 */}
            <div style={{
              marginBottom: 14, padding: '10px 12px', borderRadius: 10,
              background: '#E4E6E6', border: '1px solid rgba(249,115,22,0.2)',
              fontSize: 12.5, color: '#f59e0b', lineHeight: 1.7,
            }}>
              ⚠️ <b>手机浏览器可能自动清理数据</b>（清除缓存/卸载网页数据时 IndexedDB 会一起被清掉）。
              请<b>定期导出备份</b>，或把本应用<b>安装为 PWA（添加到主屏幕）</b>，可大幅降低被清理的风险。
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => void handleBackupExport()} disabled={backupBusy} className="btn-primary" style={{ padding: '9px 20px', fontSize: 13.5, opacity: backupBusy ? 0.6 : 1 }}>
                {backupBusy ? '导出中…' : '📤 导出全部数据'}
              </button>
              <button onClick={handleImportClick} disabled={importBusy}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                  color: '#888888', fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-stack)', opacity: importBusy ? 0.6 : 1,
                }}>
                {importBusy ? '导入中…' : '📥 导入数据'}
              </button>
              <input
                ref={importInputRef} type="file" accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => void handleImportFile(e)}
              />
            </div>
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #C0C4C4' }}>
              <button onClick={() => void handleClearBusinessData()}
                style={{
                  padding: '9px 18px', borderRadius: 10, fontSize: 13.5, fontWeight: 600, cursor: 'pointer',
                  fontFamily: 'var(--font-stack)',
                  background: '#FEF2F2', border: '1px solid #D73333', color: '#D73333',
                  transition: 'all 0.15s ease',
                }}>
                🗑 清空所有业务数据
              </button>
              <div style={{ fontSize: 11, color: '#888888', marginTop: 8 }}>
                永久删除交易/储蓄/债务/欲望清单/日程/承诺/快照/心情/画像等全部业务数据（分类将重置为默认），
                保留设置、API Key 与预算/防护配置。不可恢复，建议先「📤 导出全部数据」备份。
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#888888', marginTop: 12 }}>
              导入将覆盖当前全部数据（建议先导出备份）；支持恢复同名应用导出的备份文件
            </div>
          </div>

          {/* 数据同步 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>☁️ 数据同步</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 16, lineHeight: 1.7 }}>
              把本地数据推送到你的服务器（云端）。推送后可跨设备访问同一份数据。
            </div>

            {/* 云端地址 */}
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>云端地址</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                value={syncUrl}
                onChange={e => setSyncUrl(e.target.value)}
                placeholder="http://localhost:3001 或 http://服务器IP:3001"
                style={inputStyle}
              />
            </div>

            {/* 操作按钮 */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <button onClick={() => void handleSyncConnect()} disabled={syncBusy} className="btn-primary" style={{ padding: '9px 20px', fontSize: 13.5, opacity: syncBusy ? 0.6 : 1 }}>
                {syncBusy ? '连接中…' : '测试连接'}
              </button>
              <button onClick={() => void handleSyncPush()} disabled={syncBusy}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                  color: '#0040FF', fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-stack)', opacity: syncBusy ? 0.6 : 1,
                }}>
                推送本地数据到云端
              </button>
              <button onClick={() => void handleSyncPull()} disabled={syncBusy}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                  color: '#0040FF', fontSize: 13.5, cursor: 'pointer', fontFamily: 'var(--font-stack)', opacity: syncBusy ? 0.6 : 1,
                }}>
                📥 从云端拉取
              </button>
            </div>

            {/* 连接状态 */}
            {syncStatus && (
              <div style={{
                padding: '9px 12px', borderRadius: 10, marginBottom: 10, fontSize: 12.5,
                background: syncStatus.ok ? 'rgba(34,197,94,0.08)' : '#FEF2F2',
                color: syncStatus.ok ? '#16A34A' : '#D73333', lineHeight: 1.6,
              }}>
                {syncStatus.ok ? '✅' : '❌'} {syncStatus.message}
              </div>
            )}

            {/* 推送结果 */}
            {syncResult && (
              <div style={{
                padding: '9px 12px', borderRadius: 10, marginBottom: 10, fontSize: 12.5,
                background: syncResult.startsWith('✅') ? 'rgba(34,197,94,0.08)' : '#FEF2F2',
                color: syncResult.startsWith('✅') ? '#16A34A' : '#D73333', lineHeight: 1.7,
              }}>
                {syncResult}
              </div>
            )}

            <div style={{ fontSize: 11, color: '#888888', lineHeight: 1.8 }}>
              推送的数据：交易、储蓄目标、债务、日程、设置（共 5 张核心表）。
              全量推送会检查每条记录在云端是否存在，自动选择新增或更新。<br />
              「从云端拉取」会用云端数据覆盖本地全部业务表（21 张，含设置），操作前请先推送以备份本地数据。
            </div>
          </div>
        </div>

        {/* ========== 右栏：使用说明 / AI 用量 / 关于 ========== */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* AI 使用情况 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>📊 AI 使用情况</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <span style={{
                fontSize: 13, padding: '6px 14px', borderRadius: 20, fontWeight: 600,
                background: aiCount > 0 ? '#E4E6E6' : '#E4E6E6',
                color: aiCount > 0 ? '#0040FF' : '#888888',
              }}>
                🤖 本月已调用 AI {aiCount} 次
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 10, lineHeight: 1.8 }}>
              包含：报告生成、AI 财务助手问答、截图/语音记账解析、冲动消费解读。每次调用都会消耗所选模型厂商的账户额度。
            </div>
          </div>

          {/* 安装到设备（PWA） */}
          {installEvt && (
            <div className="card" style={{ padding: 20, background: '#E4E6E6', border: '1px solid #C0C4C4' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#0040FF' }}>📱 安装 Financial Habit 到设备</div>
                  <div style={{ fontSize: 12.5, color: '#888888', marginTop: 4 }}>
                    安装后可全屏运行，离线也能查看 Financial Habit
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => void handleInstall()} className="btn-primary" style={{ padding: '8px 18px', fontSize: 13 }}>
                    立即安装
                  </button>
                  <button onClick={() => setInstallEvt(null)}
                    style={{
                      padding: '8px 14px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA',
                      color: '#888888', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                    }}>
                    暂不
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 使用说明 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 10 }}>💡 使用说明</div>
            <ul style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.9, paddingLeft: 18 }}>
              <li>「截图识别」：上传支付截图，AI 自动识别金额/商家/分类</li>
              <li>「语音记账」：用浏览器语音识别转文字，AI 解析成记账数据</li>
              <li>未配置 Key 时，AI 功能会提示你先来设置</li>
              <li>Key 仅保存在本机浏览器 IndexedDB，随时可改</li>
            </ul>
          </div>

          {/* 关于 */}
          <div className="card" style={{ padding: 20 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', marginBottom: 10 }}>ℹ️ 关于</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.9 }}>
              <div><b style={{ color: '#111111' }}>Financial Habit</b> · AI 个人财务 OS</div>
              <div style={{ marginTop: 4 }}>本地优先：数据只存在你的浏览器（IndexedDB），不上传任何服务器。</div>
              <div style={{ marginTop: 4 }}>版本 v1.0.0</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
