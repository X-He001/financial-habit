import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import AddWishlistModal from './AddWishlistModal'
import AddDebtModal from './AddDebtModal'

export default function TopBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const isWishlist = location.pathname === '/wishlist'
  const isDebt = location.pathname === '/debt'
  const [showWishlistModal, setShowWishlistModal] = useState(false)
  const [showDebtModal, setShowDebtModal] = useState(false)
  // 监控台时钟（每秒刷新）
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <>
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: 'var(--color-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M32 10l15 5.5v14c0 11.2-6.2 19.2-15 22.6C23.2 48.7 17 40.7 17 29.5v-14z" fill="#FFFFFF"/>
              <path d="M25 26h14M25 33h14" stroke="#0040FF" strokeWidth="4.2" strokeLinecap="round"/>
              <path d="M32 26v17" stroke="#0040FF" strokeWidth="4.2" strokeLinecap="round"/>
            </svg>
          </div>
          <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--color-text)', letterSpacing: '0.02em' }}>Financial Habit</span>
        </div>
        <div style={{ flex: 1 }} />
        {/* 监控系统状态：同步指示 + 时钟 */}
        <div className="topbar-status" style={{ display: 'flex', alignItems: 'center', gap: 14, marginRight: 4 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#888888', whiteSpace: 'nowrap' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10B981', boxShadow: '0 0 0 3px rgba(16,185,129,0.20)' }} />
            数据已同步到本地
          </span>
          <span style={{
            fontSize: 12, color: '#111111', fontVariantNumeric: 'tabular-nums',
            fontFamily: '"JetBrains Mono", Consolas, monospace', letterSpacing: '0.06em',
            background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border)', borderRadius: 6,
            padding: '3px 8px',
          }}>
            {now.toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
        </div>
        {isWishlist ? (
          <button className="btn-primary" onClick={() => setShowWishlistModal(true)}>
            ＋ 添加欲望
          </button>
        ) : isDebt ? (
          <button className="btn-primary" onClick={() => setShowDebtModal(true)}>
            ＋ 记负债
          </button>
        ) : (
          <button className="btn-primary" onClick={() => navigate('/ledger')}>
            ＋ 记一笔
          </button>
        )}
      </header>

      <AddWishlistModal
        open={showWishlistModal}
        onClose={() => setShowWishlistModal(false)}
        onSaved={() => setShowWishlistModal(false)}
      />

      <AddDebtModal
        open={showDebtModal}
        onClose={() => setShowDebtModal(false)}
        onSaved={() => setShowDebtModal(false)}
      />
    </>
  )
}