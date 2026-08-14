// ==================== 冲动分析雷达图（纯 SVG，7 轴） ====================

export interface RadarItem {
  label: string
  score: number // 0-100
}

/**
 * 7 维度冲动分析雷达图：
 * - 同心 4 层网格（25/50/75/100）
 * - 每条轴从中心到最外圈
 * - 数据多边形：靛蓝半透明填充 + 描边 + 顶点圆点
 */
export default function RadarChart({ items, size = 220, max = 100 }: {
  items: RadarItem[]
  size?: number
  max?: number
}) {
  const n = items.length
  const cx = size / 2
  const cy = size / 2
  const r = size / 2 - 30
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const pt = (i: number, ratio: number): [number, number] => [
    cx + r * ratio * Math.cos(angle(i)),
    cy + r * ratio * Math.sin(angle(i)),
  ]
  const poly = (ratio: number) =>
    Array.from({ length: n }, (_, i) => pt(i, ratio).map(v => v.toFixed(1)).join(',')).join(' ')

  const dataPoints = items.map((it, i) => pt(i, Math.max(0, Math.min(max, it.score)) / max))
  const dataPoly = dataPoints.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')

  const grids = [0.25, 0.5, 0.75, 1].map(ratio => (
    <polygon key={ratio} points={poly(ratio)} fill="none" stroke="#C0C4C4" strokeWidth={1} />
  ))
  const axes = Array.from({ length: n }, (_, i) => {
    const [x, y] = pt(i, 1)
    return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#C0C4C4" strokeWidth={1} />
  })
  const labels = items.map((it, i) => {
    const a = angle(i)
    const lx = cx + (r + 20) * Math.cos(a)
    const ly = cy + (r + 20) * Math.sin(a)
    const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end'
    const dy = Math.sin(a) < -0.5 ? -2 : Math.sin(a) > 0.5 ? 14 : 4
    return (
      <text key={i} x={lx} y={ly} textAnchor={anchor} dy={dy}
        style={{ fontSize: 10.5, fill: '#888888', fontWeight: 600 }}>
        {it.label}
      </text>
    )
  })
  const dots = dataPoints.map((p, i) => (
    <circle key={i} cx={p[0]} cy={p[1]} r={3} fill="#0040FF" />
  ))

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="冲动分析雷达图">
      {grids}
      {axes}
      <polygon points={dataPoly} fill="rgba(0,64,255,0.18)" stroke="#0040FF" strokeWidth={1.8} strokeLinejoin="round" />
      {dots}
      {labels}
    </svg>
  )
}
