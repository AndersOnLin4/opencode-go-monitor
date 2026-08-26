# OpenCode Go 用量监控台

监控 [OpenCode](https://opencode.ai) Go 订阅的实时配额与本地全部 token 消耗历史的桌面端工具。Electron 构建，**自包含设计：目标电脑无需安装 Node.js 或任何依赖。**

> **版本说明**：本仓库包含两个版本线
> | 版本 | 分支 | 说明 |
> |---|---|---|
> | **v1.2.0 稳定版** | `main` | 本地历史 + 实时配额 + 迷你挂球，功能完整稳定（推荐） |
> | **v2.0.0-remote.1 实验版** | `remote-experimental` | 在稳定版基础上新增「云端用量拉取」——通过登录 Cookie 拉取工作区全部云端调用记录（含外部 harness 直调 API 的用量），实验性质 |

## 功能

- **实时配额**：5 小时滚动 / 每周 / 每月用量百分比 + 重置倒计时（数据源：`/zen/go/v1/usage`，官方接口）
- **多账号**：自动发现本机所有 opencode 系 API Key 并行查询，选项卡切换；界面可直接添加/移除其他账号的 Key
- **本地历史**：从 opencode 本地数据库聚合每日 Token/费用、模型分布、会话排行、最近调用明细
- **来源筛选**：按 provider（opencode-go / openrouter / deepseek…）筛选模型数据
- **时间粒度**：时 / 日 / 周 / 月 四档柱状图，长跨度横向滚动，时粒度带日期分隔线；另有分模型堆叠图
- **迷你挂球**：收缩为置顶小窗，可拖动、可自定义模块（配额 / 今日 / 累计 / 模型 Top），账号随主窗口切换
- **故障诊断**：数据异常时界面显示探测路径与具体原因

## 下载

前往 [Releases](https://github.com/AndersOnLin4/opencode-go-monitor/releases)：

| 资产 | 用途 |
|---|---|
| `OpenCode Go Monitor.exe` | 便携版，双击即用（推荐） |
| `OpenCode Go Monitor Setup x.y.z.exe` | 安装版，用户级一键安装 |

## 使用（开发态）

```powershell
npm.cmd install
npm.cmd start        # 启动桌面端
.\refresh.ps1        # 仅命令行刷新数据
npm.cmd run dist     # 打包（见 README 构建章节的镜像环境变量）
```

## 可移植性与环境变量

| 变量 | 作用 |
|---|---|
| `OCMON_DB_PATH` | 指定 opencode.db 路径 |
| `OCMON_AUTH_PATH` | 指定 auth.json 路径 |
| `OCMON_DATA_DIR` | 指定监控台数据输出目录 |
| `OCMON_API_KEY` | 直接指定 API Key |
| `OCMON_KEYS` | 指定参与查询的 Key 名称名单 |
| `OCMON_ENDPOINT` | 配额接口地址（默认官方） |

## 后台行为与隐私

- 正常关闭窗口后全部进程退出，零后台残留（心跳日志 `data/.heartbeat` 可查证）
- 单实例锁，重复启动只聚焦已有窗口
- 配额查询为只读 GET，约 30 秒一次且带 ±30% 随机抖动
- token 历史完全来自本地数据库，不产生网络请求
- **远程实验版**需粘贴登录 Cookie 才能拉取云端用量；Cookie 明文保存在本机 `data/remote-config.json`（已被 .gitignore 排除），请勿分享

## 作者

**AndersOnLin4-Design**

- Email：[andersonlin1107@gmail.com](mailto:andersonlin1107@gmail.com)
- GitHub：[github.com/AndersOnLin4](https://github.com/AndersOnLin4)

欢迎学习交流，商业合作请备注来意。

## License

[MIT](./LICENSE) © 2026 AndersOnLin4-Design
