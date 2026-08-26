#!/usr/bin/env node
/**
 * 远程用量拉取（分支版专属）：
 * 通过 opencode.ai 控制台的 SolidStart 服务端函数，分页拉取工作区云端用量记录。
 * 需要：登录 Cookie（auth 会话）+ 工作区 ID。
 *
 * 协议：POST /_server
 *   X-Server-Id: <构建哈希-序号>（从页面脚本自动发现）
 *   X-Start-Type: 0（seroval）
 *   Body: seroval 序列化的 [workspaceId, page]
 * 响应：分块流（;0x<hex>;payload），首块为 crossJSON，用 seroval.fromCrossJSON 还原。
 */
const fs = require("fs")
const path = require("path")
const seroval = require("seroval")

const BASE = "https://opencode.ai"
const PAGE_SIZE = 50

/* ---------- 基础请求 ---------- */
async function getCookiePage(cookie, url) {
  const res = await fetch(url, { headers: { cookie }, redirect: "follow" })
  return { status: res.status, text: await res.text(), location: res.url }
}

/* ---------- 函数 ID 发现：从页面脚本抓 哈希-序号 形态的字符串 ---------- */
async function discoverFunctionIds(cookie, workspaceId) {
  const pageUrl = `${BASE}/workspace/${workspaceId}/usage`
  const page = await getCookiePage(cookie, pageUrl)
  if (page.text.includes("OpenAuth") || page.status === 401 || /\/auth\/authorize/.test(page.location)) {
    throw new Error("Cookie 无效或已过期（被重定向到登录页）")
  }
  const srcs = [...page.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1].startsWith("http") ? m[1] : BASE + m[1])
  if (!srcs.length) throw new Error("页面未发现脚本（结构可能已变化）")

  const candidates = new Set()
  let downloaded = 0
  for (const src of srcs) {
    if (downloaded >= 10) break
    try {
      const res = await fetch(src, { headers: { cookie } })
      if (!res.ok) continue
      const js = await res.text()
      downloaded++
      for (const m of js.matchAll(/"([A-Za-z0-9_]{3,24}-[0-9]{1,5})"/g)) candidates.add(m[1])
    } catch {}
  }
  const list = [...candidates]
  if (!list.length) throw new Error("未发现任何服务端函数 ID 候选")
  return list
}

/* ---------- 分块流解析 ---------- */
function parseSerovalStream(buf) {
  const chunks = []
  let off = 0
  while (off + 12 <= buf.length) {
    if (buf[off] !== 0x3b) return chunks // ';'
    const head = buf.toString("utf8", off + 1, off + 11)
    const bytes = parseInt(head, 16)
    if (Number.isNaN(bytes)) return chunks
    chunks.push(buf.toString("utf8", off + 12, off + 12 + bytes))
    off += 12 + bytes
  }
  return chunks
}

function parseResponse(buf) {
  const chunks = parseSerovalStream(buf)
  if (!chunks.length) throw new Error("响应不是 seroval 流（函数 ID 可能错误）")
  const refs = new Map()
  return seroval.fromCrossJSON(JSON.parse(chunks[0]), { refs, plugins: [] })
}

/* ---------- 单次调用 ---------- */
async function callUsageFn(cookie, fnId, workspaceId, page) {
  const res = await fetch(`${BASE}/_server`, {
    method: "POST",
    headers: {
      cookie,
      "X-Server-Id": fnId,
      "X-Server-Instance": "server-fn:0",
      "Content-Type": "text/plain",
      "X-Start-Type": "0",
    },
    body: seroval.serialize([workspaceId, page]),
  })
  if (res.status === 404 || res.status === 500) {
    return { kind: "bad-id", status: res.status }
  }
  if (res.status >= 300 && res.status < 400) {
    return { kind: "auth", status: res.status }
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const xType = res.headers.get("x-start-type")
  if (xType !== "0") {
    const text = buf.toString("utf8").slice(0, 150)
    return { kind: "auth", status: res.status, text }
  }
  const data = parseResponse(buf)
  return { kind: "data", data }
}

/* ---------- 归一化 + 聚合（与 extract.js 同构） ---------- */
function localDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
function blank() { return { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }
function add(a, t, cost) {
  a.calls++; a.input += t.input || 0; a.output += t.output || 0; a.reasoning += t.reasoning || 0
  a.cacheRead += t.cacheRead || 0; a.cacheWrite += t.cacheWrite || 0; a.cost += cost || 0
}

function aggregate(remoteRows) {
  const days = new Map(), models = new Map(), sessions = new Map(), dayModels = new Map(), hours = new Map(), hoursModels = new Map()
  const TODAY_KEY = localDate(Date.now())
  const todayAgg = blank(), todayModels = new Map()
  let firstAt = Infinity, lastAt = -Infinity
  const recent = []

  for (const r of remoteRows) {
    const ts = new Date(r.timeCreated).getTime()
    if (ts < firstAt) firstAt = ts
    if (ts > lastAt) lastAt = ts
    const t = {
      input: r.inputTokens || 0, output: r.outputTokens || 0, reasoning: r.reasoningTokens || 0,
      cacheRead: r.cacheReadTokens || 0, cacheWrite: r.cacheWrite5mTokens || 0,
    }
    const cost = (r.cost || 0) / 1e8
    const modelID = r.model || "unknown"
    const provider = "remote"
    const dayKey = localDate(ts)
    const hourKey = dayKey + " " + String(new Date(ts).getHours()).padStart(2, "0")

    if (!days.has(dayKey)) days.set(dayKey, blank()); add(days.get(dayKey), t, cost)
    if (!models.has(modelID)) models.set(modelID, { ...blank(), provider })
    add(models.get(modelID), t, cost)
    const sid = r.sessionID || "-"
    if (!sessions.has(sid)) sessions.set(sid, { ...blank(), meta: { title: "远程会话 " + sid.slice(-8) } })
    add(sessions.get(sid), t, cost)
    if (dayKey === TODAY_KEY) {
      add(todayAgg, t, cost)
      if (!todayModels.has(modelID)) todayModels.set(modelID, { ...blank(), provider })
      add(todayModels.get(modelID), t, cost)
    }
    const dmKey = dayKey + "|" + modelID
    if (!dayModels.has(dmKey)) dayModels.set(dmKey, { ...blank(), provider })
    add(dayModels.get(dmKey), t, cost)
    if (!hours.has(hourKey)) hours.set(hourKey, blank())
    add(hours.get(hourKey), t, cost)
    const hmKey = hourKey + "|" + modelID
    if (!hoursModels.has(hmKey)) hoursModels.set(hmKey, { ...blank(), provider })
    add(hoursModels.get(hmKey), t, cost)

    recent.push({
      ts, model: modelID, provider,
      input: t.input, output: t.output, reasoning: t.reasoning,
      cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
      cost: Math.round(cost * 1e8) / 1e8,
      session: sid, sessionTitle: "远程会话 " + String(sid).slice(-8),
    })
  }

  const fmt = m => ({
    calls: m.calls, input: m.input, output: m.output, reasoning: m.reasoning,
    cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cost: Math.round(m.cost * 1e6) / 1e6,
  })
  const totals = [...days.values()].reduce((a, d) => { add(a, d, d.cost); return a }, blank())

  return {
    source: "remote",
    generatedAt: new Date().toISOString(),
    range: { from: isFinite(firstAt) ? firstAt : null, to: isFinite(lastAt) ? lastAt : null },
    totals: { ...fmt(totals), errors: 0 },
    days: [...days.entries()].sort().map(([date, v]) => ({ date, ...fmt(v) })),
    today: { date: TODAY_KEY, ...fmt(todayAgg) },
    models: [...models.entries()].sort((a, b) => b[1].cost - a[1].cost)
      .map(([model, v]) => ({ model, provider: v.provider, ...fmt(v) })),
    sessions: [...sessions.entries()].sort((a, b) => b[1].cost - a[1].cost)
      .map(([id, v]) => ({ id, title: v.meta.title, ...fmt(v) })),
    todayModels: [...todayModels.entries()].sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))
      .map(([model, v]) => ({ model, provider: v.provider, ...fmt(v) })),
    daysModels: [...dayModels.entries()].sort()
      .map(([k, v]) => { const [date, model] = k.split("|"); return { date, model, provider: v.provider, ...fmt(v) } }),
    hours: [...hours.entries()].sort().map(([date, v]) => ({ date, ...fmt(v) })),
    hoursModels: [...hoursModels.entries()].sort()
      .map(([k, v]) => { const [date, model] = k.split("|"); return { date, model, provider: v.provider, ...fmt(v) } }),
    recent: recent.sort((a, b) => b.ts - a.ts).slice(0, 300),
  }
}

/* ---------- 主流程 ---------- */
async function fetchRemoteUsage({ cookie, workspaceId, onProgress } = {}) {
  if (!cookie) throw new Error("缺少登录 Cookie")
  if (!workspaceId) throw new Error("缺少工作区 ID")
  const log = m => onProgress && onProgress(m)

  log("发现服务端函数 ID…")
  const candidates = await discoverFunctionIds(cookie, workspaceId)
  log(`候选 ID ${candidates.length} 个，逐一试探…`)

  let fnId = null
  for (const id of candidates) {
    const r = await callUsageFn(cookie, id, workspaceId, 0)
    if (r.kind === "data" && Array.isArray(r.data)) { fnId = id; log(`命中: ${id}`); break }
    if (r.kind === "auth") { fnId = id; log(`命中(需登录态): ${id}`); break }
  }
  if (!fnId) throw new Error("所有候选 ID 均未命中（页面结构可能已变化）")

  const all = []
  for (let page = 0; page < 400; page++) {
    log(`拉取第 ${page + 1} 页…`)
    const r = await callUsageFn(cookie, fnId, workspaceId, page)
    if (r.kind === "auth") throw new Error("Cookie 无效或已过期（" + (r.text || `HTTP ${r.status}`) + "）")
    if (r.kind !== "data" || !Array.isArray(r.data)) break
    all.push(...r.data)
    if (r.data.length < PAGE_SIZE) break
  }

  log(`共 ${all.length} 条远程记录，聚合中…`)
  const data = aggregate(all)
  return { count: all.length, data, fnId }
}

module.exports = { fetchRemoteUsage, discoverFunctionIds, callUsageFn, parseSerovalStream, aggregate }

/* ---------- CLI 直跑 ---------- */
if (require.main === module) {
  const dataDir = process.env.OCMON_DATA_DIR || path.join(__dirname, "data")
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "remote-config.json"), "utf8")) } catch {}
  fetchRemoteUsage({
    cookie: cfg.cookie,
    workspaceId: cfg.workspaceId,
    onProgress: m => console.log("[remote]", m),
  }).then(({ count, data }) => {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, "remote-data.js"), "OCMON_REMOTE=" + JSON.stringify(data) + ";")
    console.log(`OK 写入 remote-data.js（${count} 条）`)
  }).catch(e => { console.error("FAILED: " + e.message); process.exit(1) })
}
