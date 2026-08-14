import { NavLink } from 'react-router-dom'

const navItems = [
  { path: '/', label: '财务看板', icon: '◫' },
  { path: '/ledger', label: '智能记账', icon: '◷' },
  { path: '/report', label: 'AI 报告', icon: '◴' },
  { path: '/wishlist', label: '欲望清单', icon: '◒' },
  { path: '/debt', label: '债务分析', icon: '◑' },
  { path: '/networth', label: '净资产', icon: '◍' },
  { path: '/settings', label: '设置', icon: '⚙' },
]

export default function Sidebar() {
  const renderItem = (item: typeof navItems[number]) => (
    <NavLink
      key={item.path}
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        `sidebar-item${isActive ? ' active' : ''}`
      }
    >
      <span className="sidebar-icon">{item.icon}</span>
      <span>{item.label}</span>
    </NavLink>
  )
  return (
    <>
      {/* 桌面侧边栏（<768px 隐藏，见 index.css 媒体查询） */}
      <aside className="sidebar">
        <div style={{ padding: '0 4px 12px', fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          导航
        </div>
        {navItems.map(renderItem)}
      </aside>

      {/* 手机底部导航（仅 <768px 显示） */}
      <nav className="mobile-nav">
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) =>
              `mobile-nav-item${isActive ? ' active' : ''}`
            }
          >
            <span className="sidebar-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  )
}
