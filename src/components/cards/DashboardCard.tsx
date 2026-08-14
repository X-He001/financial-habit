import type { ReactNode } from 'react'

interface DashboardCardProps {
  title: string
  children: ReactNode
  onExpand?: () => void
  action?: ReactNode // 标题栏右侧额外操作（如"＋ 添加日程"）
}

/** 监控数据块卡片：浅灰底 + 细边框 + 紧凑标题栏（左侧状态点） */
export default function DashboardCard({ title, children, onExpand, action }: DashboardCardProps) {
  return (
    <div className="dash-card" style={{
      background: 'var(--card)',
      borderRadius: 10,
      border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-sm)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* 紧凑标题栏（监控终端风格：状态点 + 标题 + 右侧操作） */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(0,0,0,0.03)',
        userSelect: 'none',
        flexShrink: 0,
        minHeight: 36,
      }}>
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12.5,
          fontWeight: 650,
          color: '#111111',
          letterSpacing: '0.04em',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: '#0040FF', boxShadow: '0 0 0 3px rgba(0,64,255,0.18)',
          }} />
          {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {action}
          {onExpand && (
            <button
              onClick={(e) => { e.stopPropagation(); onExpand() }}
              className="dash-card-action"
              title="放大查看"
              style={{
                width: 26,
                height: 26,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 14,
                color: '#888888',
                lineHeight: 1,
                transition: 'all 0.15s ease',
              }}
            >
              ⛶
            </button>
          )}
        </div>
      </div>

      {/* 内容区（紧凑） */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '12px 14px',
      }}>
        {children}
      </div>
    </div>
  )
}
