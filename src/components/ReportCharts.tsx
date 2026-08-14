// oxlint-disable react/only-export-components -- 图表工具函数（fmtMoney 等）与组件同文件（既定设计）
// ==================== 纯 SVG 图表生成器 ====================
// 数据全部由前端代码（数据库）算出，AI 不参与绘图，保证图表与真实数据一致。
// 每个生成器输出标准 SVG 字符串：既可注入独立 HTML 报告，也可作为 React 组件使用。

export interface AreaPoint {
  date: string
  amount: number
}

export interface NamedValue {
  name: string
  value: number
  color?: string
}

export interface BarItem {
  name: string
  value: number
  percent: number // 0-100，占条形容器宽度
}

// ---------- 数字格式化 ----------

export function fmtMoney(n: number): string {
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtMoneyShort(n: number): string {
  return '¥' + Math.round(n).toLocaleString('zh-CN')
}

// ---------- 通用 ----------

let uidSeq = 0
const FONT = "-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif"

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 分类固定配色（报告里图表、表格统一） */
export const CATEGORY_COLORS: Record<string, string> = {
  餐饮: '#0040FF',
  购物: '#22D3EE',
  日用百货: '#6B90FF',
  娱乐: '#94AFFF',
  交通: '#F59E0B',
  虚拟消费: '#6B90FF',
  其他: '#888888',
}
export function colorOf(name: string): string {
  return CATEGORY_COLORS[name] ?? '#0040FF'
}

// ==================== 1. 面积图（近 N 天支出趋势） ====================

export function areaChartSVG(data: AreaPoint[], width = 560, height = 210): string {
  const n = data.length
  const pad = { t: 16, r: 14, b: 26, l: 48 }
  const plotW = width - pad.l - pad.r
  const plotH = height - pad.t - pad.b
  const max = Math.max(1, ...data.map(d => d.amount))
  const stepX = n > 1 ? plotW / (n - 1) : 0
  const px = (i: number) => pad.l + i * stepX
  const py = (v: number) => pad.t + plotH * (1 - v / max)
  const uid = `areagrad${++uidSeq}`

  if (n === 0 || data.every(d => d.amount === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" font-family="${FONT}">
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="13" fill="#888888">近${n || 30}天暂无支出记录</text></svg>`
  }

  // 水平网格线（4 档）+ Y 轴标签
  let grid = ''
  for (let g = 0; g <= 3; g++) {
    const v = max * (1 - g / 3)
    const y = py(v)
    grid += `<line x1="${pad.l}" y1="${y}" x2="${pad.l + plotW}" y2="${y}" stroke="#C0C4C4" stroke-width="1"/>`
    grid += `<text x="${pad.l - 6}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="#888888">${Math.round(v)}</text>`
  }

  // X 轴标签（均匀取 ≤6 个点）
  const labelIdx: number[] = []
  for (let i = 0; i <= 5; i++) {
    const idx = Math.round((i * (n - 1)) / 5)
    if (!labelIdx.includes(idx)) labelIdx.push(idx)
  }
  let xLabels = ''
  for (const i of labelIdx) {
    xLabels += `<text x="${px(i)}" y="${pad.t + plotH + 15}" text-anchor="middle" font-size="10" fill="#888888">${esc(String(data[i].date).slice(5))}</text>`
  }

  const linePts = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${py(d.amount)}`).join(' ')
  const areaPts = `${linePts} L${px(n - 1)},${pad.t + plotH} L${px(0)},${pad.t + plotH} Z`

  // 数据点 + tooltip（title 标签）
  let points = ''
  data.forEach((d, i) => {
    points += `<circle cx="${px(i)}" cy="${py(d.amount)}" r="2.6" fill="#111111" stroke="#0040FF" stroke-width="1.6"><title>${esc(d.date)}：${fmtMoney(d.amount)}</title></circle>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" font-family="${FONT}">
<defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0040FF" stop-opacity="0.28"/><stop offset="1" stop-color="#0040FF" stop-opacity="0.02"/></linearGradient></defs>
${grid}
<line x1="${pad.l}" y1="${pad.t + plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" stroke="#C0C4C4" stroke-width="1"/>
<path d="${areaPts}" fill="url(#${uid})"/>
<path d="${linePts}" fill="none" stroke="#0040FF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
${points}
${xLabels}
</svg>`
}

// ==================== 2. 环形图（分类消费分布） ====================

export function ringChartSVG(data: NamedValue[], width = 500, height = 250): string {
  const rows = data.slice(0, 6)
  const total = data.reduce((s, d) => s + d.value, 0)
  const cx = 108
  const cy = height / 2
  const R = 84
  const r = 52
  const lx = 216
  const ly = 42

  if (rows.length === 0 || total <= 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="auto" font-family="${FONT}">
      <text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="13" fill="#888888">暂无支出数据</text></svg>`
  }

  // 扇区
  let slices = ''
  let angle = -Math.PI / 2
  for (const d of rows) {
    const sweep = (d.value / total) * 2 * Math.PI
    if (sweep <= 0) continue
    const a1 = angle + sweep
    const large = sweep > Math.PI ? 1 : 0
    const x0 = cx + R * Math.cos(angle)
    const y0 = cy + R * Math.sin(angle)
    const x1 = cx + R * Math.cos(a1)
    const y1 = cy + R * Math.sin(a1)
    const x2 = cx + r * Math.cos(a1)
    const y2 = cy + r * Math.sin(a1)
    const x3 = cx + r * Math.cos(angle)
    const y3 = cy + r * Math.sin(angle)
    slices += `<path d="M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z" fill="${d.color ?? '#0040FF'}"><title>${esc(d.name)}：${fmtMoney(d.value)}（${Math.round((d.value / total) * 100)}%）</title></path>`
    angle = a1
  }

  const center = `<text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="19" font-weight="700" fill="#111111" font-variant-numeric="tabular-nums">${fmtMoneyShort(total)}</text>
<text x="${cx}" y="${cy + 17}" text-anchor="middle" font-size="11" fill="#888888">支出总额</text>`

  // 图例（色块 + 名称 + 金额 + 占比）
  let legend = ''
  rows.forEach((d, i) => {
    const y = ly + i * 26
    const pct = Math.round((d.value / total) * 100)
    legend += `<rect x="${lx}" y="${y - 10}" width="10" height="10" rx="2" fill="${d.color ?? '#0040FF'}"/>`
    legend += `<text x="${lx + 16}" y="${y}" font-size="12" fill="#111111">${esc(d.name)}</text>`
    legend += `<text x="${lx + 132}" y="${y}" font-size="12" fill="#888888" text-anchor="end">${fmtMoney(d.value)}</text>`
    legend += `<text x="${lx + 156}" y="${y}" font-size="12" fill="#0040FF" font-weight="600">${pct}%</text>`
  })
  const h = Math.max(height, ly + rows.length * 26)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="100%" height="auto" font-family="${FONT}">
${slices}
${center}
${legend}
</svg>`
}

// ==================== 3. 横向条形图（平台分布 Top5） ====================

export function barListSVG(data: BarItem[], width = 500, height?: number): string {
  const rows = data.slice(0, 6)
  const rowH = 30
  const h = height ?? rows.length * rowH + 12
  const labelW = 96
  const pctW = 56
  const barX = labelW
  const barW = width - labelW - pctW - 10
  const uid = `bargrad${++uidSeq}`

  if (rows.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="100%" height="auto" font-family="${FONT}">
      <text x="${width / 2}" y="${h / 2}" text-anchor="middle" font-size="13" fill="#888888">暂无平台数据</text></svg>`
  }

  let bars = ''
  rows.forEach((row, i) => {
    const y = 8 + i * rowH
    const bw = Math.max(2, barW * (Math.min(100, Math.max(0, row.percent)) / 100))
    bars += `<text x="${barX - 8}" y="${y + 11.5}" font-size="12" fill="#888888" text-anchor="end">${esc(row.name)}</text>`
    bars += `<rect x="${barX}" y="${y}" width="${barW}" height="16" rx="8" fill="#E4E6E6"/>`
    bars += `<rect x="${barX}" y="${y}" width="${bw}" height="16" rx="8" fill="url(#${uid})"><title>${esc(row.name)}：${fmtMoney(row.value)}（${Math.round(row.percent)}%）</title></rect>`
    bars += `<text x="${barX + Math.max(bw, 10) + 8}" y="${y + 12.5}" font-size="12" fill="#0040FF" font-weight="600">${Math.round(row.percent)}%</text>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" width="100%" height="auto" font-family="${FONT}">
<defs><linearGradient id="${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0040FF"/><stop offset="1" stop-color="#22D3EE"/></linearGradient></defs>
${bars}
</svg>`
}

// ==================== React 组件（dangerouslySetInnerHTML 包装，SVG 为纯内部数据，安全） ====================

export function AreaChartSVG({ data, width, height }: { data: AreaPoint[]; width?: number; height?: number }) {
  return <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: areaChartSVG(data, width, height) }} />
}

export function RingChartSVG({ data, width, height }: { data: NamedValue[]; width?: number; height?: number }) {
  return <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: ringChartSVG(data, width, height) }} />
}

export function BarListSVG({ data, width, height }: { data: BarItem[]; width?: number; height?: number }) {
  return <div style={{ width: '100%' }} dangerouslySetInnerHTML={{ __html: barListSVG(data, width, height) }} />
}
