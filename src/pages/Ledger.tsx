import { useState, useEffect, useRef } from 'react'
import {
  addTransaction, getAllTransactions,
  getAllCategories, addCategory, deleteCategory, getSetting,
} from '../db/crud'
import type { Transaction, Category, CreditAccount } from '../types'
import OcrTab from '../components/ledger/OcrTab'
import VoiceTab from '../components/ledger/VoiceTab'
import ImportTab from '../components/ledger/ImportTab'
import { runSaveFlow } from '../utils/saveFlow'
import { SHOP_CATEGORIES, isImpulsive } from '../utils/impulseEngine'
import { computeFragileWindows, getFragileWindowNow } from '../agent/metrics'
import { loadCreditAccounts, createCreditAccount, recordCreditPurchase, PLATFORM_TO_FUNDING, PLATFORM_DEFAULT } from '../debt/operations'

// 冲动等级文案
const IMPULSE_LABEL: Record<Transaction['impulseLevel'], string> = {
  low: '理智', medium: '轻度冲动', high: '中度冲动', veryHigh: '高度冲动',
}

// ===== 常量 =====

const LEDGER_TABS = [
  { key: 'manual', label: '✏️ 手动' },
  { key: 'ocr', label: '📷 截图识别' },
  { key: 'voice', label: '🎤 语音记账' },
  { key: 'import', label: '📥 导入' },
] as const
type LedgerTab = typeof LEDGER_TABS[number]['key']

const MERCHANT_PLATFORMS = ['拼多多', '京东', '淘宝', '抖音', '美团', '淘宝闪购', '其他']

// 支付方式分两组：现金支付 / 负债支付（负债支付需选择具体负债账户）
const PAY_GROUPS: { group: string; items: Transaction['paymentMethod'][] }[] = [
  { group: '现金支付', items: ['微信', '支付宝', '银行卡', '现金'] },
  { group: '负债支付', items: ['花呗', '京东白条', '抖音月付', '拼多多先用后付', '信用卡'] },
]

const quickAmounts = [10, 20, 30, 50, 100]

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// 收入分类（固定）
const INCOME_CATEGORIES = [
  { name: '工资', icon: '💼' },
  { name: '奖金', icon: '🏆' },
  { name: '红包', icon: '🧧' },
]

// ===== 工具 =====

function formatYuan(minor: number): string {
  return (minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const dayMs = 86_400_000
  if (diffMs < dayMs && d.getDate() === now.getDate()) {
    return `今天`
  }
  const yesterday = new Date(now.getTime() - dayMs)
  if (diffMs < 2 * dayMs && d.getDate() === yesterday.getDate()) {
    return `昨天`
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function todayDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function tagClassForName(name: string): string {
  const m: Record<string, string> = {
    '餐饮': 'tag-food', '购物': 'tag-shopping', '日用百货': 'tag-other',
    '娱乐': 'tag-entertainment', '交通': 'tag-transport', '虚拟消费': 'tag-shopping',
    '其他': 'tag-other',
  }
  return m[name] || 'tag-other'
}

// ===== 主组件 =====

export default function Ledger() {
  const [amountText, setAmountText] = useState('')
  const [txType, setTxType] = useState<'income' | 'expense'>('expense')
  const [categoryName, setCategoryName] = useState('餐饮')
  const [merchantPlatform, setMerchantPlatform] = useState('拼多多')
  const [customMerchant, setCustomMerchant] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<Transaction['paymentMethod']>('微信')
  const [date, setDate] = useState(todayDate())
  const [note, setNote] = useState('')
  const [allRecords, setAllRecords] = useState<Transaction[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [showAddCat, setShowAddCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  // 负债支付：账户列表 / 选中的账户 / 创建账户弹窗
  const [creditAccounts, setCreditAccounts] = useState<CreditAccount[]>([])
  const [lienAccountId, setLienAccountId] = useState<string | null>(null)
  const [showCreateAcc, setShowCreateAcc] = useState(false)
  const [accNickname, setAccNickname] = useState('')
  const [accLimitText, setAccLimitText] = useState('')
  const [accStatementDay, setAccStatementDay] = useState(1)
  const [accDueDay, setAccDueDay] = useState(9)
  const [tab, setTab] = useState<LedgerTab>('manual')
  // 主动拦截：当前是否处于高频冲动窗口（分类为购物/娱乐/虚拟消费时显示提醒条）
  const [fragileNow, setFragileNow] = useState<{ label: string; share: number } | null>(null)
  const [showAllRecords, setShowAllRecords] = useState(false)
  const [recordsLimit, setRecordsLimit] = useState(15)
  const [isWide, setIsWide] = useState(window.innerWidth >= 900)
  const inputRef = useRef<HTMLInputElement>(null)
  const addCatInputRef = useRef<HTMLInputElement>(null)

  const isOtherCategory = categoryName === '其他'
  const isOtherMerchant = merchantPlatform === '其他'
  const isIncome = txType === 'income'
  // 负债支付：支付方式是否属于负债平台（花呗/白条/月付/先用后付/信用卡）
  const isCreditPay = !isIncome && !!PLATFORM_TO_FUNDING[paymentMethod as string]
  const filteredAccounts = creditAccounts.filter((a) => a.platform === paymentMethod)
  const displayCats: { id: string; name: string; icon: string; color: string; isDefault: boolean }[] = isIncome
    ? INCOME_CATEGORIES.map((c) => ({ id: c.name, name: c.name, icon: c.icon, color: '#22D3EE', isDefault: true }))
    : categories

  // 加载
  async function loadData() {
    const [cats, all, accs] = await Promise.all([getAllCategories(), getAllTransactions(), loadCreditAccounts()])
    setCategories(cats)
    if (!cats.find((c) => c.name === categoryName)) {
      setCategoryName(cats[0]?.name ?? '其他')
    }
    const sorted = all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    setAllRecords(sorted)
    setCreditAccounts(accs)
  }

  // 仅挂载时加载一次（loadData 内部依赖多条表查询，无需响应式重跑）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadData() }, [])

  // 响应式：监听窗口宽度
  useEffect(() => {
    const h = () => setIsWide(window.innerWidth >= 900)
    window.addEventListener('resize', h)
    return () => window.removeEventListener('resize', h)
  }, [])

  // 显示记录：默认 15 条，超过可加载更多或查看全部
  const displayedRecords = showAllRecords ? allRecords : allRecords.slice(0, recordsLimit)
  const hasMore = allRecords.length > recordsLimit && !showAllRecords

  function handleLoadMore() {
    setRecordsLimit(prev => Math.min(prev + 15, allRecords.length))
  }

  function handleToggleShowAll() {
    setShowAllRecords(prev => !prev)
  }

  // 金额
  const amountMinor = (() => {
    const n = parseFloat(amountText)
    if (isNaN(n) || n <= 0) return 0
    return Math.round(n * 100)
  })()

  const amountPreview = amountText ? `¥${formatYuan(amountMinor)}` : '¥0.00'

  function handleAmountInput(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value
    if (/^\d*\.?\d{0,2}$/.test(v) || v === '') setAmountText(v)
  }

  function quickAdd(n: number) {
    setAmountText(String(n))
    inputRef.current?.focus()
  }

  // 商家最终名称
  function finalMerchant(): string {
    if (isOtherMerchant && customMerchant.trim()) {
      return `其他：${customMerchant.trim()}`
    }
    return merchantPlatform
  }

  // 保存
  async function handleSave() {
    if (amountMinor <= 0) return
    const merchant = isIncome ? (categoryName === '工资' ? '工资' : categoryName === '奖金' ? '奖金' : '红包') : finalMerchant()
    // 时间：用户选的日期 + 当前时刻（保证深夜/凌晨等时段能被正确识别，而不是存成午夜）
    const now = new Date()
    const timeISO = new Date(
      `${date}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`
    ).toISOString()
    const tx: Omit<Transaction, 'id'> = {
      txType,
      amountMinor,
      category: categoryName,
      merchant,
      time: timeISO,
      paymentMethod: isIncome ? '银行卡' : paymentMethod,
      source: 'manual',
      impulseScore: 0,
      impulseLevel: 'low',
      isRevoked: false,
      revokedAt: null,
      regretValue: null,
      regretAt: null,
      importId: null,
      note: isOtherCategory ? note.trim() : '',
      screenshot: null,
      fundingSource: isCreditPay ? PLATFORM_TO_FUNDING[paymentMethod as string] : null,
      lienAccountId: isCreditPay ? lienAccountId : null,
    }

    if (isIncome) {
      // 收入不做冲动判断
      await addTransaction(tx)
      setToast(`💚 已记录收入 ¥${formatYuan(amountMinor)} · ${categoryName}`)
    } else {
      // 冲动指数 + 预警分流（本地规则引擎）
      const result = await runSaveFlow(tx)

      // 轻度提醒条（不阻断，先展示再继续保存）
      if (result.infoMessages.length > 0) {
        setToast(result.infoMessages[0])
        await sleep(1800)
      }

      if (result.action === 'cancel') {
        setToast('💡 要不要放进欲望清单冷静一下？')
        setTimeout(() => setToast(null), 3000)
        return
      }
      if (result.action === 'wishlist') {
        setToast(`🧾 已放入欲望清单「${result.wishlistName}」，24小时后回来确认`)
        setTimeout(() => setToast(null), 4000)
        window.dispatchEvent(new CustomEvent('dashboard-refresh'))
        await loadData()
        return
      }

      // 保存：负债支付 → 写支出 + 该账户当前期账单累计；否则普通支出
      if (result.noteSuffix) {
        tx.note = tx.note ? `${tx.note} · ${result.noteSuffix}` : result.noteSuffix
      }
      if (isCreditPay) {
        const account = creditAccounts.find((a) => a.id === lienAccountId)
        if (!account) {
          setToast('⚠️ 请先选择负债账户（花呗/白条等）')
          setTimeout(() => setToast(null), 3000)
          return
        }
        tx.lienAccountId = account.id
        const r = await recordCreditPurchase(tx, account)
        setToast(`✅ 已用${paymentMethod}记 ¥${formatYuan(amountMinor)} · 借来的钱，未来约 ${r.graceDays} 天要还 ¥${formatYuan(amountMinor)}`)
      } else {
        const txId = await addTransaction(tx)
        // 冲动消费已入库 → 触发"今日冲动复盘"入口
        window.dispatchEvent(new CustomEvent('impulse-saved', { detail: { tx: { ...tx, id: txId } } }))
        const reasonText = result.reasons.length > 0 ? ` · ${result.reasons.join('、')}` : ''
        setToast(`✅ 已记录支出 ¥${formatYuan(amountMinor)} · ${categoryName} · 冲动 ${result.score} 分（${IMPULSE_LABEL[result.level]}）${reasonText}`)
      }
    }
    window.dispatchEvent(new CustomEvent('dashboard-refresh'))
    setTimeout(() => setToast(null), 4000)
    setAmountText('')
    setCustomMerchant('')
    setNote('')
    setDate(todayDate())
    inputRef.current?.focus()
    await loadData()
  }

  // 添加分类
  async function handleAddCategory() {
    const name = newCatName.trim()
    if (!name) return
    if (categories.some((c) => c.name === name)) {
      setToast('⚠️ 该分类已存在')
      setTimeout(() => setToast(null), 2000)
      return
    }
    const colors = ['#0040FF', '#06B6D4', '#f59e0b', '#0040FF', '#6B90FF', '#22D3EE', '#f59e0b']
    const color = colors[categories.length % colors.length]
    await addCategory({ name, icon: '📌', color, isDefault: false })
    setNewCatName('')
    setShowAddCat(false)
    setCategoryName(name)
    await loadData()
  }

  // 删除分类
  async function handleDeleteCategory(cat: Category) {
    if (cat.isDefault) return
    const ok = window.confirm(`删除分类「${cat.name}」后，该分类下已有记录会归入「其他」，确定？`)
    if (!ok) return
    await deleteCategory(cat.id)
    setCategoryName('其他')
    await loadData()
  }

  // 创建负债账户（记账页首次使用引导）
  async function handleCreateCreditAccount() {
    const platform = paymentMethod as CreditAccount['platform']
    const def = PLATFORM_DEFAULT[platform] ?? { rateType: 'apr' as const, feeRate: 18.0, minPayRatio: 0.1, graceDays: 38 }
    const limitYuan = parseFloat(accLimitText)
    const limitMinor = isNaN(limitYuan) || limitYuan <= 0 ? 0 : Math.round(limitYuan * 100)
    const id = await createCreditAccount({
      platform,
      nickname: accNickname.trim() || platform,
      creditLimitMinor: limitMinor,
      statementDay: Math.min(28, Math.max(1, accStatementDay)),
      dueDay: Math.min(28, Math.max(1, accDueDay)),
      graceDays: def.graceDays,
      minPayRatio: def.minPayRatio,
      rateType: def.rateType,
      feeRate: def.feeRate,
    })
    setLienAccountId(id)
    setShowCreateAcc(false)
    setAccNickname('')
    setAccLimitText('')
    setAccStatementDay(1)
    setAccDueDay(9)
    await loadData()
    setToast(`✅ 已创建「${platform}」负债账户，现在可以用它记账了`)
    setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    if (showAddCat) addCatInputRef.current?.focus()
  }, [showAddCat])

  // 主动拦截：挂载时更新高频窗口数据，切到购物/娱乐/虚拟消费且当前处于窗口内 → 显示提醒条
  useEffect(() => {
    void (async () => {
      await computeFragileWindows()
      const [win, flag] = await Promise.all([getFragileWindowNow(), getSetting('fragileReminder')])
      if (flag === 'false' || !win || isIncome || !SHOP_CATEGORIES.includes(categoryName)) {
        setFragileNow(null)
        return
      }
      setFragileNow({ label: win.label, share: win.share })
    })()
  }, [categoryName, isIncome])

  return (
    <div style={{ position: 'relative' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 72, left: '50%', transform: 'translateX(-50%)',
          background: '#111111', color: '#FFFFFF', padding: '10px 24px', borderRadius: 12,
          fontSize: 14, fontWeight: 500, zIndex: 100,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        }}>
          {toast}
        </div>
      )}

      <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>智能记账</h1>
      <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 24 }}>快速记录每一笔收入与支出</p>

      {/* Tab 切换（全宽） */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {LEDGER_TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              flex: 1, padding: '10px 0', borderRadius: 999, fontSize: 14, fontWeight: 600, cursor: 'pointer',
              fontFamily: 'var(--font-stack)', transition: 'all 0.15s',
              border: tab === t.key ? '1.5px solid #0040FF' : '1px solid #C0C4C4',
              background: tab === t.key ? '#0040FF' : '#FFFFFF',
              color: tab === t.key ? '#FFFFFF' : 'var(--color-text-secondary)',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* 两栏布局 */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isWide ? 'minmax(0, 0.82fr) minmax(0, 1fr)' : '1fr',
        gap: 24,
        alignItems: 'start',
      }}>
        {/* ========== 左栏：记账表单 ========== */}
        <div style={{ minWidth: 0 }}>
          {/* 高频冲动窗口提醒条 */}
          {tab === 'manual' && fragileNow && (
            <div style={{
              marginBottom: 16, padding: '12px 16px', background: '#E4E6E6',
              border: '1px solid rgba(245,158,11,0.2)', borderRadius: 12, display: 'flex', gap: 10, alignItems: 'flex-start',
              animation: 'fadeInUp 0.3s ease both',
            }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>🌙</span>
              <div style={{ flex: 1, fontSize: 13, color: '#f59e0b', lineHeight: 1.7 }}>
                现在是你的高频冲动时段 <b>{fragileNow.label}</b>（近30天 <b>{fragileNow.share}%</b> 的冲动发生在这个时段），确定要买吗？
              </div>
            </div>
          )}

          {/* Import Tab */}
          {tab === 'import' && <ImportTab />}

          {/* 手动记账表单 */}
          {tab === 'manual' && (
          <div className="card" style={{ padding: 24 }}>
            {/* 收支切换 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button onClick={() => setTxType('expense')}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                  transition: 'all 0.15s',
                  border: txType === 'expense' ? '1.5px solid #0040FF' : '1px solid #C0C4C4',
                  background: txType === 'expense' ? 'rgba(0,64,255,0.05)' : '#FFFFFF',
                  color: txType === 'expense' ? '#0040FF' : 'var(--color-text-secondary)',
                }}>
                支出 −
              </button>
              <button onClick={() => setTxType('income')}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)',
                  transition: 'all 0.15s',
                  border: txType === 'income' ? '1.5px solid #22D3EE' : '1px solid #C0C4C4',
                  background: txType === 'income' ? 'rgba(34,211,238,0.05)' : '#FFFFFF',
                  color: txType === 'income' ? '#22D3EE' : 'var(--color-text-secondary)',
                }}>
                收入 +
              </button>
            </div>

            {/* 金额预览 */}
            <div style={{ textAlign: 'center', marginBottom: 12, fontSize: 18, fontWeight: 500 }}>
              <span style={{ color: isIncome ? '#22D3EE' : 'var(--color-text-muted)' }}>{amountPreview}</span>
            </div>

            {/* 金额输入 */}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 40, fontWeight: 300, color: 'var(--color-text-muted)', marginRight: 8, lineHeight: 1, userSelect: 'none' }}>¥</span>
              <input ref={inputRef} type="text" inputMode="decimal" value={amountText} onChange={handleAmountInput} placeholder="0.00"
                style={{ flex: 1, fontSize: 40, fontWeight: 600, color: 'var(--color-text)', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--font-stack)', fontVariantNumeric: 'tabular-nums', width: '100%' }} />
            </div>

            {/* 快捷金额（窄屏可换行，避免按钮溢出） */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, justifyContent: 'center', flexWrap: 'wrap' }}>
              {quickAmounts.map((n) => (
                <button key={n} onClick={() => quickAdd(n)}
                  style={{ background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '6px 16px', fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-stack)', transition: 'all 0.15s' }}>
                  ¥{n}
                </button>
              ))}
            </div>

            {/* 分类选择 */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 10, fontWeight: 500 }}>分类</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                {displayCats.map((c) => {
                  const selected = categoryName === c.name
                  return (
                    <div key={c.id} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button onClick={() => setCategoryName(c.name)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
                          border: selected ? `1.5px solid ${c.color}` : '1px solid #C0C4C4',
                          background: selected ? `${c.color}12` : '#FFFFFF',
                          color: selected ? c.color : 'var(--color-text-secondary)',
                          cursor: 'pointer', fontFamily: 'var(--font-stack)', transition: 'all 0.15s',
                        }}>
                        <span>{c.icon}</span> {c.name}
                      </button>
                      {!c.isDefault && (
                        <span onClick={(e) => { e.stopPropagation(); handleDeleteCategory(c) }}
                          title="删除分类"
                          style={{
                            position: 'absolute', top: -4, right: -4,
                            width: 18, height: 18, borderRadius: '50%',
                            background: '#0040FF', color: '#FFFFFF',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer',
                            lineHeight: 1, zIndex: 2,
                          }}>
                          ×
                        </span>
                      )}
                    </div>
                  )
                })}

                {!isIncome && (showAddCat ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input ref={addCatInputRef} value={newCatName} onChange={(e) => setNewCatName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); if (e.key === 'Escape') { setShowAddCat(false); setNewCatName('') } }}
                      placeholder="分类名，如 宠物"
                      style={{ width: 120, padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)' }} />
                    <button onClick={handleAddCategory}
                      style={{ padding: '8px 12px', borderRadius: 10, border: 'none', background: 'var(--color-primary)', color: '#FFFFFF', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                      确认
                    </button>
                    <button onClick={() => { setShowAddCat(false); setNewCatName('') }}
                      style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: 'var(--color-text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                      取消
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setShowAddCat(true)}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 10, border: '1.5px dashed #C0C4C4', background: 'transparent', color: 'var(--color-text-muted)', fontSize: 18, fontWeight: 400, cursor: 'pointer', fontFamily: 'var(--font-stack)', transition: 'all 0.15s' }}>
                    +
                  </button>
                ))}
              </div>
            </div>

            {/* "其他"分类备注 */}
            {isOtherCategory && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>备注</div>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="请输入具体分类名"
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box' }} />
              </div>
            )}

            {/* 补充信息（仅支出） */}
            {!isIncome && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                {/* 商家 */}
                <div>
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>商家</div>
                  <select value={merchantPlatform} onChange={(e) => setMerchantPlatform(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', background: '#D8DADA', boxSizing: 'border-box' }}>
                    {MERCHANT_PLATFORMS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {isOtherMerchant && (
                    <input value={customMerchant} onChange={(e) => setCustomMerchant(e.target.value)}
                      placeholder="输入商家名"
                      style={{ marginTop: 8, width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box' }} />
                  )}
                </div>

                {/* 支付方式 */}
                <div>
                  <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>支付方式</div>
                  <select value={paymentMethod}
                    onChange={(e) => { setPaymentMethod(e.target.value as Transaction['paymentMethod']); setLienAccountId(null) }}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', background: '#D8DADA', boxSizing: 'border-box' }}>
                    {PAY_GROUPS.map((g) => (
                      <optgroup key={g.group} label={g.group}>
                        {g.items.map((m) => <option key={m} value={m}>{m}</option>)}
                      </optgroup>
                    ))}
                  </select>
                  {/* 负债支付：选择具体负债账户（无账户则引导创建） */}
                  {isCreditPay && (
                    <div style={{ marginTop: 8 }}>
                      {filteredAccounts.length === 0 ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '10px 12px' }}>
                          <span style={{ fontSize: 12.5, color: '#0040FF', flex: 1, lineHeight: 1.6 }}>
                            还没有「{paymentMethod}」账户，先创建才能记录借来的钱
                          </span>
                          <button onClick={() => setShowCreateAcc(true)}
                            style={{ flexShrink: 0, padding: '7px 12px', borderRadius: 8, border: 'none', background: '#0040FF', color: '#FFFFFF', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                            创建账户
                          </button>
                        </div>
                      ) : (
                        <select value={lienAccountId ?? ''} onChange={(e) => setLienAccountId(e.target.value || null)}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', background: '#E4E6E6', boxSizing: 'border-box' }}>
                          <option value="">选择具体账户…</option>
                          {filteredAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.nickname || paymentMethod}（额度 ¥{formatYuan(a.creditLimitMinor)}）
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 日期 */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>日期</div>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                style={{ width: '100%', padding: '8px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box' }} />
            </div>

            {/* 保存 */}
            <button onClick={handleSave} disabled={amountMinor <= 0} className="btn-primary"
              style={{ width: '100%', padding: '12px 0', fontSize: 15, borderRadius: 12, opacity: amountMinor <= 0 ? 0.5 : 1 }}>
              ✓ 记一笔
            </button>
          </div>
          )}

          {/* OCR Tab */}
          {tab === 'ocr' && (
            <div className="card" style={{ padding: 24 }}>
              <OcrTab onSaved={loadData} />
            </div>
          )}

          {/* Voice Tab */}
          {tab === 'voice' && (
            <div className="card" style={{ padding: 24 }}>
              <VoiceTab onSaved={loadData} />
            </div>
          )}
        </div>

        {/* ========== 右栏：最近记录 ========== */}
        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', minHeight: isWide ? 460 : undefined }}>
          {/* 标题栏 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>最近记录</span>
            {allRecords.length > 0 && (
              <button onClick={handleToggleShowAll}
                style={{
                  background: 'none', border: 'none', color: '#0040FF', fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', fontFamily: 'var(--font-stack)',
                }}>
                {showAllRecords ? '收起' : '查看全部 ▸'}
              </button>
            )}
          </div>

          {/* 空状态 */}
          {allRecords.length === 0 ? (
            <div style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              padding: '48px 20px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
              <div style={{ fontSize: 14, color: '#888888', marginBottom: 6 }}>还没有记录</div>
              <div style={{ fontSize: 12, color: '#888888' }}>在左边记一笔吧</div>
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {displayedRecords.map((tx) => {
                const cat = categories.find((c) => c.name === tx.category)
                const isInc = (tx.txType ?? 'expense') === 'income'
                const impulse = !isInc && isImpulsive(tx.impulseLevel)
                return (
                  <div key={tx.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '12px 14px', background: '#D8DADA', borderRadius: 12,
                    border: '1px solid #E4E6E6', transition: 'box-shadow 0.15s',
                  }}>
                    {/* 分类标签 */}
                    <span className={`tag ${tagClassForName(tx.category)}`}
                      style={{
                        flexShrink: 0, fontSize: 11, padding: '3px 10px',
                        ...(isInc ? { background: 'rgba(34,211,238,0.08)', color: '#22D3EE' } : (cat && !cat.isDefault ? { background: `${cat.color}18`, color: cat.color } : {})),
                      }}
                    >
                      {isInc ? (tx.category === '工资' ? '💼' : tx.category === '奖金' ? '🏆' : '🧧') : (cat ? cat.icon : '')} {tx.category}
                    </span>
                    {/* 商家 + 时间 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 500, color: '#111111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {tx.merchant}
                        {impulse && <span style={{ marginLeft: 4, fontSize: 11 }} title="冲动消费">⚡</span>}
                      </div>
                      <div style={{ fontSize: 11.5, color: '#888888', marginTop: 1 }}>
                        {formatTime(tx.time)}
                        {tx.note && <span style={{ marginLeft: 6 }}>{tx.note}</span>}
                      </div>
                    </div>
                    {/* 金额 */}
                    <span style={{
                      flexShrink: 0, fontSize: 14, fontWeight: 600,
                      color: isInc ? '#22D3EE' : '#111111',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {isInc ? '+' : '-'}¥{formatYuan(tx.amountMinor)}
                    </span>
                  </div>
                )
              })}

              {/* 加载更多 */}
              {hasMore && (
                <button onClick={handleLoadMore}
                  style={{
                    marginTop: 4, padding: '10px 0', borderRadius: 10, border: '1px dashed #C0C4C4',
                    background: 'transparent', color: '#888888', fontSize: 13, fontWeight: 500,
                    cursor: 'pointer', fontFamily: 'var(--font-stack)',
                  }}>
                  加载更多（{allRecords.length - recordsLimit} 条）
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 创建负债账户弹窗 */}
      {showCreateAcc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setShowCreateAcc(false)}>
          <div className="card" style={{ width: '100%', maxWidth: 400, padding: 24, maxHeight: '85vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text)', marginBottom: 4 }}>创建「{paymentMethod}」账户</div>
            <div style={{ fontSize: 12.5, color: '#888888', marginBottom: 16 }}>用它消费=借来的钱，到期自动纳入待还与还款规划</div>

            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账户昵称</div>
            <input value={accNickname} onChange={(e) => setAccNickname(e.target.value)}
              placeholder={`如 ${paymentMethod}主卡`}
              style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box', marginBottom: 14 }} />

            <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>授信额度（元）</div>
            <input value={accLimitText} onChange={(e) => setAccLimitText(e.target.value)} inputMode="decimal" placeholder="如 5000"
              style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box', marginBottom: 14 }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>账单日</div>
                <input type="number" min={1} max={28} value={accStatementDay} onChange={(e) => setAccStatementDay(Number(e.target.value))}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box' }} />
              </div>
              <div>
                <div style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 6, fontWeight: 500 }}>还款日</div>
                <input type="number" min={1} max={28} value={accDueDay} onChange={(e) => setAccDueDay(Number(e.target.value))}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #C0C4C4', fontSize: 13, color: 'var(--color-text)', outline: 'none', fontFamily: 'var(--font-stack)', boxSizing: 'border-box' }} />
              </div>
            </div>

            <div style={{ fontSize: 12, color: '#888888', background: '#E4E6E6', border: '1px solid #C0C4C4', borderRadius: 10, padding: '10px 12px', marginBottom: 16, lineHeight: 1.7 }}>
              {(() => {
                const def = PLATFORM_DEFAULT[paymentMethod as CreditAccount['platform']]
                if (!def) return '费率以平台实际为准'
                const rateText = def.rateType === 'day_fee' ? `日费率 ${def.feeRate}（万${def.feeRate * 10000}/日）`
                  : def.rateType === 'installment_fee' ? `每期费率 ${def.feeRate * 100}%`
                  : `年化利率 ${def.feeRate}%`
                return `默认计息：${rateText} · 免息 ${def.graceDays} 天 · 最低还款比例 ${def.minPayRatio * 100}%`
              })()}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleCreateCreditAccount} className="btn-primary" style={{ flex: 1, padding: '11px 0', fontSize: 14, borderRadius: 10 }}>
                ✓ 创建账户
              </button>
              <button onClick={() => setShowCreateAcc(false)}
                style={{ padding: '11px 20px', borderRadius: 10, border: '1px solid #C0C4C4', background: '#D8DADA', color: 'var(--color-text-secondary)', fontSize: 14, cursor: 'pointer', fontFamily: 'var(--font-stack)' }}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
