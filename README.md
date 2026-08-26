# OpenCode Go 用量监控台（远程实验分支）

> ⚠️ **实验分支**（`remote-experimental`，v2.0.0-remote.1）：在 [稳定版 main 分支](https://github.com/AndersOnLin4/opencode-go-monitor/tree/main) 基础上新增「云端用量拉取」。接口为逆向 opencode 网页端所得，官方改版即可能失效。求稳用 main，尝鲜用本分支。

在稳定版全部功能之上，新增：

- **云端用量拉取**：通过登录 Cookie 调用工作台服务端函数，分页拉取工作区**全部**云端调用记录——包含外部工具（如 deepseek harness）直调 opencode API 的用量，这些不会写入本地数据库
- **数据源切换**：顶部 本地 / 远程 一键切换，图表、模型表、会话、明细全维度联动
- **协议实现**：自动从页面脚本发现服务端函数 ID，seroval 序列化请求、分块流解析响应，自动翻页直到取完

## 使用远程拉取

1. 浏览器登录 opencode.ai 并进入工作区 Usage 页
2. F12 → Network → 刷新 → 任一请求的 Request Headers 复制完整 `cookie:` 值
3. 应用顶部点「☁ 远程设置」→ 粘贴 Cookie + 工作区 ID（`wrk_...`）→ 保存并拉取
4. 拉取完成后自动切到「远程」数据源；Cookie 明文存本机 `data/remote-config.json`（已被 .gitignore 排除），过期后重新粘贴即可

## 注意

- 拉取为手动触发，不会自动轮询（避免高频请求）
- 服务端函数 ID 由构建哈希生成，官方前端改版会导致 ID 失效——届时重新运行一次发现流程通常即可恢复
- 其余功能、构建方式、环境变量与 [main 分支 README](https://github.com/AndersOnLin4/opencode-go-monitor/tree/main#readme) 一致

## 作者

**AndersOnLin4-Design**

- Email：[andersonlin1107@gmail.com](mailto:andersonlin1107@gmail.com)
- GitHub：[github.com/AndersOnLin4](https://github.com/AndersOnLin4)

欢迎学习交流，商业合作请备注来意。

## License

[MIT](./LICENSE) © 2026 AndersOnLin4-Design
