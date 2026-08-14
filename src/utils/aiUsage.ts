import { getSetting, setSetting } from '../db/crud'

const AI_COUNT_KEY = 'aiCallCount'
const pad2 = (n: number) => String(n).padStart(2, '0')
const curYm = () => `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`

interface Usage { ym: string; count: number }

async function read(): Promise<Usage> {
  const raw = await getSetting(AI_COUNT_KEY)
  if (typeof raw !== 'string') return { ym: curYm(), count: 0 }
  try {
    const parsed = JSON.parse(raw) as Usage
    if (parsed.ym === curYm() && typeof parsed.count === 'number') return parsed
    return { ym: curYm(), count: 0 }
  } catch {
    return { ym: curYm(), count: 0 }
  }
}

/** 本月已调用 AI 次数 */
export async function getAiMonthCount(): Promise<number> {
  const u = await read()
  return u.count
}

/** 记录一次 AI 调用，返回更新后的本月次数 */
export async function incrementAiCount(): Promise<number> {
  const u = await read()
  const next = { ym: curYm(), count: u.count + 1 }
  await setSetting(AI_COUNT_KEY, JSON.stringify(next))
  return next.count
}
