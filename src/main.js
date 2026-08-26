const { app, BrowserWindow, ipcMain } = require("electron")
const { execFile } = require("child_process")
const path = require("path")
const fs = require("fs")
const https = require("https")

/* ================= 路径解析（开发态 / 打包态 / 环境变量覆盖） ================= */
const HOME = process.env.USERPROFILE || process.env.HOME
const DEFAULT_OC_DIR = path.join(HOME, ".local", "share", "opencode")

// 打包后脚本被复制到 resources/scripts（extraResources），数据写到用户可写目录
const IS_PACKAGED = app.isPackaged
const ROOT = IS_PACKAGED ? path.join(process.resourcesPath, "scripts") : path.join(__dirname, "..")
const DEV_ROOT = path.join(__dirname, "..") // dashboard.html 始终随应用分发

const BASE_MS = 30_000
// 随机抖动 ±30% → 约 21~39 秒，避免固定周期请求特征
const nextDelay = () => BASE_MS + Math.floor((Math.random() * 0.6 - 0.3) * BASE_MS)

let win = null
let miniWin = null
let timer = null
let lastDelay = null
let extractChild = null
let activeAccountName = null // 当前选中账号（主窗口选项卡与迷你挂球共享）

const diag = {
  dbPath: process.env.OCMON_DB_PATH || path.join(DEFAULT_OC_DIR, "opencode.db"),
  authPath: process.env.OCMON_AUTH_PATH || path.join(DEFAULT_OC_DIR, "auth.json"),
  endpoint: process.env.OCMON_ENDPOINT || "https://opencode.ai/zen/go/v1/usage",
  keySource: null,
  lastTickAt: null,
  lastExtractOk: null,
  lastExtractError: null,
  lastQuotaOk: null,
  startedAt: new Date().toISOString(),
}

function dataDir() {
  if (process.env.OCMON_DATA_DIR) return process.env.OCMON_DATA_DIR
  if (IS_PACKAGED) return path.join(app.getPath("userData"), "data")
  return path.join(DEV_ROOT, "data")
}

function log(line) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.appendFileSync(path.join(dataDir(), ".heartbeat"), new Date().toISOString() + " " + line + "\n")
  } catch {}
  console.log("[tick]", line)
}

/* ================= 远程配置（分支版专属） ================= */
function remoteConfigPath() {
  return path.join(dataDir(), "remote-config.json")
}
function readRemoteConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(remoteConfigPath(), "utf8"))
    return { cookie: c.cookie || "", workspaceId: c.workspaceId || "" }
  } catch {
    return { cookie: "", workspaceId: "" }
  }
}

/* ================= 凭证：只查询 opencode 系 Key（可用 OCMON_KEYS 覆盖名单） ================= */
// 额外账号 Key 存放于 dataDir()/extra-keys.json（用户通过界面「＋添加账号」维护）
function extraKeysPath() {
  return path.join(dataDir(), "extra-keys.json")
}
function readExtraKeys() {
  try {
    const list = JSON.parse(fs.readFileSync(extraKeysPath(), "utf8"))
    return Array.isArray(list) ? list.filter(k => k && k.name && k.key) : []
  } catch {
    return []
  }
}
function writeExtraKeys(list) {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(extraKeysPath(), JSON.stringify(list, null, 2))
}

function listApiKeys() {
  if (process.env.OCMON_API_KEY) {
    return [{ name: "OCMON_API_KEY", key: process.env.OCMON_API_KEY, source: "env" }]
  }
  let names = null // null = 默认规则：provider 名含 opencode
  if (process.env.OCMON_KEYS) {
    names = process.env.OCMON_KEYS.split(",").map(s => s.trim()).filter(Boolean)
  }
  const out = []
  try {
    const auth = JSON.parse(fs.readFileSync(diag.authPath, "utf8"))
    for (const [name, entry] of Object.entries(auth)) {
      if (!(entry && typeof entry === "object" && entry.type === "api" && entry.key)) continue
      if (names ? names.includes(name) : /opencode/i.test(name)) {
        out.push({ name, key: entry.key, source: "auth" })
      }
    }
  } catch (e) {
    diag.keySource = "auth-unreadable: " + e.message.slice(0, 120)
  }
  // 合并用户添加的额外账号（按 key 去重，重名自动加后缀）
  for (const k of readExtraKeys()) {
    if (out.some(x => x.key === k.key)) continue
    let name = k.name
    const taken = new Set(out.map(x => x.name))
    let n = 2
    while (taken.has(name)) name = `${k.name}-${n++}`
    out.push({ name, key: k.key, source: "extra" })
  }
  return out
}

/* ================= 配额拉取（每个 Key 独立请求，并行） ================= */
function fetchOneQuota(name, key, source) {
  return new Promise((resolve) => {
    const req = https.request(
      diag.endpoint,
      { method: "GET", headers: { Authorization: `Bearer ${key}` }, timeout: 12_000 },
      (res) => {
        let buf = ""
        res.on("data", (c) => (buf += c))
        res.on("end", () => {
          try {
            if (res.statusCode === 200) {
              const json = JSON.parse(buf)
              resolve(json.usage ? { name, ok: true, usage: json.usage, source } : { name, ok: false, error: "响应缺少 usage", source })
            } else {
              resolve({ name, ok: false, error: `HTTP ${res.statusCode}: ${buf.slice(0, 120)}`, source })
            }
          } catch {
            resolve({ name, ok: false, error: "响应不是合法 JSON", source })
          }
        })
      },
    )
    req.on("timeout", () => req.destroy())
    req.on("error", (e) => resolve({ name, ok: false, error: "网络错误: " + e.message.slice(0, 120), source }))
    req.end()
  })
}

async function fetchQuota() {
  const keys = listApiKeys()
  if (!keys.length) {
    diag.lastQuotaOk = false
    diag.lastQuotaError = "未找到任何 API Key（检查 auth.json 或设置 OCMON_API_KEY）"
    return false
  }
  diag.keySource = keys.map((k) => k.name).join(", ")

  const accounts = await Promise.all(keys.map((k) => fetchOneQuota(k.name, k.key, k.source)))
  const okAny = accounts.some((a) => a.ok)
  if (okAny) {
    fs.mkdirSync(dataDir(), { recursive: true })
    const primary = accounts.find((a) => a.ok)
    fs.writeFileSync(
      path.join(dataDir(), "quota.js"),
      "OCMON_QUOTA=" +
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          accounts,
          usage: primary.usage, // 兼容旧字段：主账号的 usage
        }) +
        ";",
    )
    diag.lastQuotaOk = true
    diag.lastQuotaError = accounts.filter((a) => !a.ok).map((a) => `${a.name}: ${a.error}`).join(" | ") || null
  } else {
    diag.lastQuotaOk = false
    diag.lastQuotaError = accounts.map((a) => `${a.name}: ${a.error}`).join(" | ")
  }
  return okAny
}

/* ================= 本地历史提取：用自身二进制 RUN_AS_NODE 模式，零外部依赖 ================= */
function runExtract() {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OCMON_DATA_DIR: dataDir(),
      // 显式传递，避免打包后子进程拿不到默认路径推断所需变量
      USERPROFILE: process.env.USERPROFILE || "",
      HOME: process.env.HOME || "",
    }
    delete childEnv.ELECTRON_NO_ATTACH_CONSOLE
    const child = execFile(
      process.execPath,
      [path.join(ROOT, "extract.js")],
      { timeout: 40_000, env: childEnv, windowsHide: true },
      (err, stdout, stderr) => {
        if (extractChild === child) extractChild = null
        if (err) {
          diag.lastExtractOk = false
          diag.lastExtractError = String(stderr || err.message).slice(0, 300)
          log("extract ERROR: " + diag.lastExtractError)
        } else {
          log("extract OK: " + String(stdout).trim())
          diag.lastExtractOk = true
          diag.lastExtractError = null
        }
        resolve(!err)
      },
    )
    extractChild = child
  })
}

/* ================= 数据读取（供渲染进程 IPC 获取） ================= */
function readJsonp(file, varName) {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), file), "utf8")
    return JSON.parse(raw.replace(new RegExp("^" + varName + "="), "").replace(/;\s*$/, ""))
  } catch {
    return null
  }
}

async function tick(manual = false) {
  const okE = await runExtract()
  const okQ = await fetchQuota()
  diag.lastTickAt = new Date().toISOString()
  log(`tick done manual=${manual} extract=${okE} quota=${okQ}`)
  scheduleNext()
  pushSync()
  return { ok: okE, quota: okQ }
}

function scheduleNext() {
  if (timer) clearTimeout(timer)
  lastDelay = nextDelay()
  timer = setTimeout(() => tick(false), lastDelay)
  log(`next in ${lastDelay}ms`)
}

// 每轮 tick 后把最新数据 + 下次刷新时间推给所有窗口（避免整页刷新闪烁）
function pushSync() {
  const payload = {
    data: readJsonp("data.js", "OCMON_DATA"),
    quota: readJsonp("quota.js", "OCMON_QUOTA"),
    diag,
    nextDelay: lastDelay,
    at: Date.now(),
    activeAccountName,
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("sync", payload)
  }
}

/* ================= 窗口 ================= */
const WEB_PREFS = {
  // OCMON_NO_BRIDGE=1 时不挂 preload：用于模拟纯浏览器环境测试（不要在生产设置）
  preload: process.env.OCMON_NO_BRIDGE === "1" ? undefined : path.join(__dirname, "preload.js"),
  contextIsolation: true,
  nodeIntegration: false,
}

function assertPreload() {
  const p = WEB_PREFS.preload
  if (p && !fs.existsSync(p)) {
    log("FATAL: preload.js 缺失 → 桌面端桥接将不可用: " + p)
  }
}

function createWindow() {
  assertPreload()
  win = new BrowserWindow({
    width: 1240,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0e0e11",
    autoHideMenuBar: true,
    title: "OpenCode Go 用量监控台",
    webPreferences: WEB_PREFS,
  })
  win.loadFile(path.join(DEV_ROOT, "dashboard.html"))
  win.webContents.on("did-finish-load", pushSync)
  win.on("close", () => log("main window close event"))
  win.on("closed", () => log("main window closed"))
}

/* ================= 迷你挂起窗口（无边框置顶小部件，高度随内容自适应） ================= */
const MINI_W = 280

function createMiniWindow() {
  miniWin = new BrowserWindow({
    width: MINI_W,
    height: 220,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: WEB_PREFS,
  })
  miniWin.loadFile(path.join(DEV_ROOT, "dashboard.html"), { search: "view=mini" })
}

// 单实例锁：重复启动时聚焦已有窗口，避免多进程双重轮询
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.argv.includes("--mini")) createMiniWindow()
    else createWindow()
    ipcMain.handle("tick-now", () => tick(true))
    ipcMain.handle("get-data", () => ({
      data: readJsonp("data.js", "OCMON_DATA"),
      quota: readJsonp("quota.js", "OCMON_QUOTA"),
      diag,
    }))
    ipcMain.handle("mini-resize", (_e, h) => {
      if (miniWin && !miniWin.isDestroyed()) {
        miniWin.setBounds({ width: MINI_W, height: Math.max(150, Math.min(700, Math.round(h) || 150)) })
      }
    })
    ipcMain.handle("set-active-account", (_e, name) => {
      activeAccountName = name ? String(name).slice(0, 40) : null
      pushSync()
      return { ok: true, activeAccountName }
    })
    /* ---------- 远程用量（分支版专属） ---------- */
    ipcMain.handle("get-remote-config", () => {
      const c = readRemoteConfig()
      return { cookie: c.cookie || "", workspaceId: c.workspaceId || "" }
    })
    ipcMain.handle("set-remote-config", (_e, cfg) => {
      const clean = { cookie: String((cfg && cfg.cookie) || "").trim(), workspaceId: String((cfg && cfg.workspaceId) || "").trim() }
      fs.mkdirSync(dataDir(), { recursive: true })
      fs.writeFileSync(remoteConfigPath(), JSON.stringify(clean, null, 2))
      return { ok: true }
    })
    ipcMain.handle("fetch-remote", () => new Promise((resolve) => {
      const cfg = readRemoteConfig()
      if (!cfg.cookie || !cfg.workspaceId) { resolve({ ok: false, error: "请先填写 Cookie 与工作区 ID" }); return }
      let lastLine = ""
      const child = execFile(
        process.execPath,
        [path.join(ROOT, "remote.js")],
        { timeout: 180_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OCMON_DATA_DIR: dataDir() }, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) { resolve({ ok: false, error: String(stderr || err.message).slice(0, 300) }); return }
          const m = String(stdout).match(/OK[^\n]*（(\d+) 条）/)
          resolve({ ok: true, count: m ? +m[1] : null })
        },
      )
      child.stdout && child.stdout.on("data", d => {
        for (const line of String(d).split("\n")) {
          const t = line.replace(/^\[remote\]\s*/, "").trim()
          if (t && t !== lastLine) { lastLine = t; if (win && !win.isDestroyed()) win.webContents.send("remote-progress", t) }
        }
      })
    }))
    ipcMain.handle("get-remote-data", () => {
      try {
        const raw = fs.readFileSync(path.join(dataDir(), "remote-data.js"), "utf8")
        return JSON.parse(raw.replace(/^OCMON_REMOTE=/, "").replace(/;\s*$/, ""))
      } catch { return null }
    })
    ipcMain.handle("enter-mini", () => {
      if (!miniWin || miniWin.isDestroyed()) createMiniWindow()
      if (win && !win.isDestroyed()) win.hide()
    })
    ipcMain.handle("add-key", (_e, name, key) => {
      name = String(name || "").trim().slice(0, 30)
      key = String(key || "").trim()
      if (!name || !key) return { ok: false, error: "名称和 Key 不能为空" }
      if (!/^sk-|^[A-Za-z0-9_-]{20,}$/.test(key)) return { ok: false, error: "Key 格式看起来不对，请检查" }
      const list = readExtraKeys()
      if (list.some(k => k.key === key)) return { ok: false, error: "该 Key 已存在" }
      const taken = new Set(listApiKeys().map(k => k.name).concat(list.map(k => k.name)))
      let base = name, n = 2
      while (taken.has(name)) name = `${base}-${n++}`
      list.push({ name, key })
      try { writeExtraKeys(list) } catch (e) { return { ok: false, error: "写入失败: " + e.message } }
      tick(true).catch(() => {})
      return { ok: true, name }
    })
    ipcMain.handle("remove-key", (_e, name) => {
      const list = readExtraKeys().filter(k => k.name !== name)
      writeExtraKeys(list)
      tick(true).catch(() => {})
      return { ok: true }
    })
    ipcMain.handle("exit-mini", () => {
      if (miniWin && !miniWin.isDestroyed()) {
        miniWin.destroy()
      }
      miniWin = null
      if (!win || win.isDestroyed()) createWindow()
      else win.show()
    })
    tick(false).catch((e) => log("first tick failed: " + e.message))
  })

  app.on("window-all-closed", () => {
    log("window-all-closed -> quit")
    app.quit()
  })

  // 退出清理：终止未完成的提取子进程，杜绝后台残留（配额请求自带 12s 超时）
  app.on("before-quit", () => {
    log("before-quit cleanup")
    if (timer) clearTimeout(timer)
    timer = null
    try {
      if (extractChild) extractChild.kill()
    } catch {}
  })
}
