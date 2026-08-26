#!/usr/bin/env node
/**
 * 拉取 Go 订阅实时配额（5小时滚动/周/月）。
 * 支持多 Key：auth.json 里所有 api 类型条目并行查询，全部输出。
 * 输出 data/quota.js 供 dashboard.html 使用。
 */
const fs = require("fs")
const path = require("path")

const HOME = process.env.USERPROFILE || process.env.HOME || ""
const AUTH_PATH = process.env.OCMON_AUTH_PATH || path.join(HOME, ".local", "share", "opencode", "auth.json")
const OUT = path.join(process.env.OCMON_DATA_DIR || path.join(__dirname, "data"), "quota.js")
const ENDPOINT = process.env.OCMON_ENDPOINT || "https://opencode.ai/zen/go/v1/usage"

function listApiKeys() {
  if (process.env.OCMON_API_KEY) return [{ name: "OCMON_API_KEY", key: process.env.OCMON_API_KEY, source: "env" }]
  const auth = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"))
  let names = process.env.OCMON_KEYS ? process.env.OCMON_KEYS.split(",").map(s => s.trim()).filter(Boolean) : null
  const out = Object.entries(auth)
    .filter(([name, e]) => e && typeof e === "object" && e.type === "api" && e.key)
    .filter(([name]) => (names ? names.includes(name) : /opencode/i.test(name)))
    .map(([name, e]) => ({ name, key: e.key, source: "auth" }))
  // 合并界面添加的额外账号
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(path.dirname(OUT), "extra-keys.json"), "utf8"))
    for (const k of Array.isArray(extra) ? extra : []) {
      if (k && k.name && k.key && !out.some(x => x.key === k.key)) out.push({ name: k.name, key: k.key, source: "extra" })
    }
  } catch {}
  return out
}

function fetchOne(name, key) {
  return fetch(ENDPOINT, { headers: { Authorization: `Bearer ${key}` } }).then(async (res) => {
    if (!res.ok) return { name, ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` }
    const json = await res.json()
    return json.usage ? { name, ok: true, usage: json.usage } : { name, ok: false, error: "响应缺少 usage" }
  }).catch((e) => ({ name, ok: false, error: "网络错误: " + e.message }))
}

async function main() {
  const keys = listApiKeys()
  if (!keys.length)
    throw new Error(`未找到任何 API Key（已检查 ${AUTH_PATH}）；可用环境变量 OCMON_API_KEY 指定`)
  console.log(`[quota] key 来源: ${keys.map((k) => k.name).join(", ")}`)

  const accounts = await Promise.all(keys.map((k) => fetchOne(k.name, k.key)))
  const primary = accounts.find((a) => a.ok)
  if (!primary) throw new Error(accounts.map((a) => `${a.name}: ${a.error}`).join(" | "))

  const out = { fetchedAt: new Date().toISOString(), accounts, usage: primary.usage }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, "OCMON_QUOTA=" + JSON.stringify(out) + ";")

  for (const a of accounts) {
    if (!a.ok) { console.log(`${a.name}: FAILED (${a.error})`); continue }
    for (const [k, v] of Object.entries(a.usage)) {
      console.log(`${a.name}.${k}: ${v.percent}% (resets ${v.resetsAt})`)
    }
  }
}

main().catch((e) => {
  console.error("FAILED: " + e.message)
  process.exit(1)
})
