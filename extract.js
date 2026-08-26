#!/usr/bin/env node
/**
 * 从本地 opencode 数据库提取用量数据，聚合为 日/模型/会话 三个维度。
 * 输出 data/data.js （JSONP 风格，供 file:// 直开的 dashboard.html 使用）
 */
const { DatabaseSync } = require("node:sqlite")
const fs = require("fs")
const path = require("path")

// 跨平台：Windows 用 USERPROFILE，macOS/Linux 用 HOME
const HOME = process.env.USERPROFILE || process.env.HOME || ""
const DB_PATH =
  process.argv[2] ||
  process.env.OCMON_DB_PATH ||
  path.join(HOME, ".local", "share", "opencode", "opencode.db")
const OUT_DIR = process.env.OCMON_DATA_DIR || path.join(__dirname, "data")

if (!fs.existsSync(DB_PATH)) {
  console.error(
    `[extract] 未找到 opencode 数据库: ${DB_PATH}\n` +
      `  请确认已安装并使用过 opencode；或用环境变量 OCMON_DB_PATH / 命令行参数指定数据库路径`,
  )
  process.exit(1)
}

function localDate(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${dd}`
}

function blank() {
  return { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

function add(a, t, cost) {
  a.calls++
  a.input += t.input || 0
  a.output += t.output || 0
  a.reasoning += t.reasoning || 0
  a.cacheRead += (t.cache && t.cache.read) || 0
  a.cacheWrite += (t.cache && t.cache.write) || 0
  a.cost += cost || 0
}

const db = new DatabaseSync(DB_PATH, { readOnly: true })

// ---- sessions 元信息（schema 变化时容错降级）----
const sessionMeta = {}
try {
  for (const s of db.prepare("SELECT id, title, directory FROM session").all()) {
    sessionMeta[s.id] = { title: s.title || s.id, directory: s.directory || "" }
  }
} catch (e) {
  console.error("[extract] session 表读取失败（忽略，仅影响会话标题显示）: " + e.message)
}

// ---- 遍历消息 ----
const days = new Map()
const models = new Map()
const sessions = new Map()
const dayModels = new Map() // 日期 × 模型 交叉聚合，供分模型图表使用
const hours = new Map()     // 小时级聚合
const hoursModels = new Map() // 小时 × 模型
const TODAY_KEY = localDate(Date.now())
const todayAgg = blank()
const todayModels = new Map()
let errors = 0
let firstAt = Infinity
let lastAt = -Infinity

for (const r of db.prepare("SELECT session_id, time_created, data FROM message").all()) {
  let d
  try {
    d = JSON.parse(r.data)
  } catch {
    continue
  }
  if (d.role !== "assistant") continue
  if (d.error) {
    errors++
    continue
  }
  const t = d.tokens || {}
  if (!(t.input || t.output)) continue

  const ts = (d.time && d.time.created) || r.time_created || Date.now()
  if (ts < firstAt) firstAt = ts
  if (ts > lastAt) lastAt = ts

  const cost = d.cost || 0
  const modelID = `${d.providerID}/${d.modelID}` // 保留 provider 前缀：区分账号/来源
  const dayKey = localDate(ts)

  if (!days.has(dayKey)) days.set(dayKey, blank())
  add(days.get(dayKey), t, cost)

  if (!models.has(modelID)) models.set(modelID, { ...blank(), provider: d.providerID })
  add(models.get(modelID), t, cost)

  const sid = r.session_id
  if (!sessions.has(sid)) sessions.set(sid, { ...blank(), meta: sessionMeta[sid] })
  add(sessions.get(sid), t, cost)

  if (dayKey === TODAY_KEY) {
    add(todayAgg, t, cost)
    if (!todayModels.has(modelID)) todayModels.set(modelID, { ...blank(), provider: d.providerID })
    add(todayModels.get(modelID), t, cost)
  }

  const dmKey = dayKey + "|" + modelID
  if (!dayModels.has(dmKey)) dayModels.set(dmKey, { ...blank(), provider: d.providerID })
  add(dayModels.get(dmKey), t, cost)

  const hourKey = dayKey + " " + String(new Date(ts).getHours()).padStart(2, "0")
  if (!hours.has(hourKey)) hours.set(hourKey, blank())
  add(hours.get(hourKey), t, cost)
  const hmKey = hourKey + "|" + modelID
  if (!hoursModels.has(hmKey)) hoursModels.set(hmKey, { ...blank(), provider: d.providerID })
  add(hoursModels.get(hmKey), t, cost)
}

const fmt = (m) => ({
  calls: m.calls,
  input: m.input,
  output: m.output,
  reasoning: m.reasoning,
  cacheRead: m.cacheRead,
  cacheWrite: m.cacheWrite,
  cost: Math.round(m.cost * 1e6) / 1e6,
})

const out = {
  generatedAt: new Date().toISOString(),
  range: { from: isFinite(firstAt) ? firstAt : null, to: isFinite(lastAt) ? lastAt : null },
  totals: (() => {
    const sum = blank()
    for (const v of days.values()) {
      sum.calls += v.calls
      sum.input += v.input
      sum.output += v.output
      sum.reasoning += v.reasoning
      sum.cacheRead += v.cacheRead
      sum.cacheWrite += v.cacheWrite
      sum.cost += v.cost
    }
    return { ...fmt(sum), errors }
  })(),
  days: [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, ...fmt(v) })),
  today: { date: TODAY_KEY, ...fmt(todayAgg) },
  models: [...models.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([model, v]) => ({ model, provider: v.provider || model.split("/")[0], ...fmt(v) })),
  sessions: [...sessions.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(([id, v]) => ({
      id,
      title: (v.meta && v.meta.title) || id,
      ...fmt(v),
    })),
  todayModels: [...todayModels.entries()]
    .sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))
    .map(([model, v]) => ({ model, provider: v.provider || model.split("/")[0], ...fmt(v) })),
  daysModels: [...dayModels.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => { const [date, model] = k.split("|"); return { date, model, provider: v.provider || model.split("/")[0], ...fmt(v) } }),
  hours: [...hours.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, ...fmt(v) })),
  hoursModels: [...hoursModels.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => { const [date, model] = k.split("|"); return { date, model, provider: v.provider || model.split("/")[0], ...fmt(v) } }),
  recent: [],
}

// ---- 最近调用明细（含错误标记）----
{
  const rows = []
  for (const r of db.prepare("SELECT session_id, time_created, data FROM message").all()) {
    let d
    try {
      d = JSON.parse(r.data)
    } catch {
      continue
    }
    if (d.role !== "assistant") continue
    const ts = (d.time && d.time.created) || r.time_created
    rows.push({ ts, d, sid: r.session_id })
  }
  rows.sort((a, b) => b.ts - a.ts)
  for (const { ts, d, sid } of rows.slice(0, 120)) {
    const t = d.tokens || {}
    out.recent.push({
      ts,
      model: `${d.providerID}/${d.modelID}`,
      input: t.input || 0,
      output: t.output || 0,
      reasoning: t.reasoning || 0,
      cacheRead: (t.cache && t.cache.read) || 0,
      cacheWrite: (t.cache && t.cache.write) || 0,
      cost: Math.round((d.cost || 0) * 1e8) / 1e8,
      error: d.error ? (d.error.name || "Error") : undefined,
      session: sid,
      sessionTitle: (sessionMeta[sid] && sessionMeta[sid].title) || sid,
    })
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, "data.js"), "OCMON_DATA=" + JSON.stringify(out) + ";")
console.log(
  `OK ${out.days.length} days / ${out.models.length} models / ${out.sessions.length} sessions / ${out.totals.calls} calls`,
)
