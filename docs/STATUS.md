# 当前状态与遗留事项（2026-10-07）

> `docs/superpowers/plans/` 里的勾选框多数没有随实现更新，不能当进度看。以本文件为准。

## 已确认完成

- 头条、公众号、小红书、抖音图文发布通路均已有实现与单元测试（`src/lib/toutiao-*`、`wechat-*`、`xhs-*`）。
- UI 审计 P0：`Unknown User` 本地化（`src/lib/nickname.ts`）、`1970/1/1` → 「未知时间」（`renderer/src/utils/display.ts`）。
- `publishing-service.test.ts` 启动恢复用例的日期相关失败已修（显式设置 mtime）。
- `src/server.ts` 空串环境变量视为未配置（2026-10-07）。

## 仍未完成

| 事项 | 阻塞原因 | 下一步 |
| --- | --- | --- |
| 抖音大文件端到端下载 | 抖音 CDN 对单 IP 限流，约 2MB 截断 | 在应用内用真实登录态重试 |
| 抖音签名 `Uifid` 头与过期签名算法 | 需要真实账号和抓包 | 有登录态后单独排查 |
| 长操作不可取消 | `api.ts` 默认超时 16 分钟，无中断入口 | 给「创建文章包」等加 AbortController 与取消按钮 |
| 素材页、热点页忙时无法离开 | busy 分支直接 reset() | 与文章页统一，提供「忙时也能离开」出口 |
| 导航拦截无浏览器交互测试 | renderer 用例只做 renderToStaticMarkup | 依赖 Actions 中的 Playwright 流程或引入 jsdom |
| 真实账号发布、ASR 性能、AI 输出质量 | 需用户配置账号与 Key | 用户本机逐项验收 |
| 安装器代码签名 | 需要签名证书 | 有证书后在 Actions 加签名步骤 |

## 产品范围外（暂不做）

- 自动 TTS 配音
- 自动调用图片生成接口（目前只出提示词）
