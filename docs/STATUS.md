# 当前状态与遗留事项（2026-10-07）

> `docs/superpowers/plans/` 里的勾选框多数没有随实现更新，不能当进度看。以本文件为准。

## 已确认完成

- 头条、公众号、小红书、抖音图文发布通路均已有实现与单元测试（`src/lib/toutiao-*`、`wechat-*`、`xhs-*`）。
- UI 审计 P0：`Unknown User` 本地化（`src/lib/nickname.ts`）、`1970/1/1` → 「未知时间」（`renderer/src/utils/display.ts`）。
- `publishing-service.test.ts` 启动恢复用例的日期相关失败已修（显式设置 mtime）。
- `src/server.ts` 空串环境变量视为未配置（2026-10-07）。
- 长操作可取消（2026-10-07）：文章步骤/读资料/预览/建公众号包、图文包、视频发布包、头条/公众号文章包都接了 AbortController，忙时显示「取消」，卸载即停止等待；取消提示如实说明后端可能仍在完成（`renderer/src/utils/cancellableOperation.ts`）。
- 忙时也能离开（2026-10-07）：文章页、素材页、热点页共用 `blockedNavigationAction`，忙时确认一次即可离开。
- 安全加固（2026-10-07）：本机 API 只认回环 Host/Origin，CORS 不再是 `*`；桌面端每次启动生成本机令牌（`X-Doin-Token`，媒体 GET 用 `?doin_token=`），独立后端可用 `DOIN_API_TOKEN` 启用并只监听 127.0.0.1；Electron 开启 sandbox、拦截站外导航与新窗口、外链只放行 http/https/mailto、IPC 校验发送方、收紧权限；`/api/config` 打码返回 Key；配置与 Cookie 文件 0600；yt-dlp 来源只收 http(s) 且加 `--`；async 路由异常统一进兜底 JSON 错误处理；抖音 Cookie 提取不再 `execSync` 阻塞主进程。
- `runtime-checks` 兜底超时不再 `unref`（否则探测挂起时任务永远停在 running，测试也因此被取消 9 例）。

## 仍未完成

| 事项 | 阻塞原因 | 下一步 |
| --- | --- | --- |
| 抖音大文件端到端下载 | 抖音 CDN 对单 IP 限流，约 2MB 截断 | 在应用内用真实登录态重试 |
| 抖音签名 `Uifid` 头与过期签名算法 | 需要真实账号和抓包 | 有登录态后单独排查 |
| 取消只是「停止等待」 | 文章 AI 步骤、建包等后端路由不感知客户端断开 | 需要时给这些路由接 `req` 关闭 → AbortSignal |
| 桌面端改动未做 GUI 冒烟 | 沙箱里没有 Electron 二进制与显示环境（sandbox、导航守卫、本机令牌、权限处理器只过了类型检查与单测） | 本机 `npm run dev` / 安装包走一遍：文章页、素材页、视频播放、复制按钮、外链、全屏 |
| 渲染端无 CSP | file:// 页面加 CSP 需逐项验证 Tailwind/Vite 产物与媒体地址 | GUI 冒烟通过后再加 meta CSP |
| 钥匙串不可用时 Key 明文落盘 | `safeStorage` 不可用（部分 Linux）时回退明文，仅靠 0600 权限保护 | 视需要提示用户或拒绝保存 |
| 独立后端的 Cookie / 配置未加密 | `~/.douyin-ai-video/` 下为明文（已 0600） | 视需要接系统钥匙串 |
| 导航拦截无浏览器交互测试 | renderer 用例只做 renderToStaticMarkup | 依赖 Actions 中的 Playwright 流程或引入 jsdom |
| 真实账号发布、ASR 性能、AI 输出质量 | 需用户配置账号与 Key | 用户本机逐项验收 |
| 安装器代码签名 | 需要签名证书 | 有证书后在 Actions 加签名步骤 |

## 产品范围外（暂不做）

- 自动 TTS 配音
- 自动调用图片生成接口（目前只出提示词）
