# Shopify 联调结果记录

日期：2026-10-20。此记录明确区分官方 CLI、真实 Shopify 与本地模拟测试，不把尚未运行的流程标为成功。

| 检查 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| CLI 安装 | 通过 | 工作区安装 Shopify CLI 4.9.4 |
| Shopify 登录 | 通过 | 负责人本人在浏览器完成 Google/Shopify 登录 |
| 关联已有应用 | 通过 | `app config link`，选择 GetShopReply 组织及已有同名 App；没有重复创建 |
| 应用配置 | 已写入 | 已关联真实 public client ID；embedded、现有域名 URL、空 scopes、五个 webhooks 在 TOML 中 |
| 开发商店识别 | 通过 | CLI 返回真实域名 `getshopreply-test-4k85f5hy.myshopify.com` |
| 官方构建 | 通过 | `app build` 和 Theme Check；修复 locale 目录缺失后重新构建无该错误 |
| 版本上传 | 已上传未发布 | 已创建 [getshopreply-3](https://dev.shopify.com/dashboard/241817759/apps/437534851073/versions/1173732229121)；使用 `--no-release`，Theme Check / bundling / validation 成功；未切换生产活动版本 |
| 本地启动 | 通过 | 更正密码后 CLI 开发预览已启动，主题服务器 ready，真实隧道可用 |
| 安装 / OAuth / App Home | 未验收 | CLI 已确认安装；App Bridge token exchange 和实际后台仍待测试窗口登录后验收 |
| Theme Editor / App Embed | 未验收 | 扩展已构建上传，实际主题开启和保存尚未操作 |
| 实际 AI 回答 | 未验收 | 未配置实际 DeepSeek 密钥/模型，不使用假回答冒充联调结果 |
| Shopify 月付/年付 test billing | 未验收 | 本地逻辑已测试，真实 Shopify 确认页未走通 |
| 取消 / 降级 | 未验收 | 本地逻辑已测试，真实订阅操作未进行 |
| GDPR / 卸载投递 | 未验收 | 本地验签/删除/重装测试通过，真实 webhook 尚未触发 |
| Lighthouse | 未测量 | 不报告虚构分数 |
| 本地后端回归 | 通过 | 20 个场景，Node 测试器含父测试共 21 项；隔离数据库，模拟 Shopify/AI 服务 |
| 本地素材 | 已生成草稿 | 三张不同 UI 视图 1600×900；原创 SVG 与 1200×1200 PNG；明确非真实开发店证明 |
| 生产操作 | 未执行 | main、Vultr 服务、DNS 和真实收费均未更改 |

## 本轮修复

- 接入 CLI 的 `APP_URL` / `HOST` (or `SHOPIFY_APP_URL` compatibility alias)；生产保持 `PUBLIC_BASE_URL` 优先，避免临时隧道污染正式入口。
- 处理 CLI 从根路径打开应用的情况，重定向到 `/shopify`，不转发 URL 中的 ID token。
- 增加读取本地环境的 CLI 包装脚本及安全导入已关联 client ID 的辅助脚本。
- 补齐扩展 locale 文件并保留 CLI 分配的 extension uid；移除 CLI 已不支持的 include_config_on_deploy 配置。
- 根据自检增加商家分页读取本店聊天记录的后台入口，确保收集的数据可以在 Shopify 后台查看；这不涉及尚未确认的 Pro CSV 导出功能。
- 统一新应用、扩展、法律页面的 GetShopReply 名称和 support@getshopreply.com；补充运营主体与地址。

## 线上基线发现

公开 DNS 为 `139.180.143.31`，首页响应经过 Caddy。负责人确认 Vultr 和 DeepSeek。线上隐私页披露 Paddle 与 Resend 订单试点，而 GitHub 基线没有对应代码。尚未获取服务器源码，因此不推断具体服务目录、进程管理器、模型、数据库路径或该试点是否实际启用。部署前必须完成这些核对。

## 下一步

前台密码已更正并通过，CLI dev 已运行。负责人在隔离 Edge 测试窗口登录后继续真实界面检查；AI 回答还需真实 DeepSeek 环境。后续可通过 `npm run shopify -- app dev --config shopify.app.toml --store getshopreply-test-4k85f5hy.myshopify.com` 恢复。所有需要 Shopify 登录的网页操作仍由负责人本人完成。完成真实测试、差异核对和负责人批准后，才决定活动版本发布、PR 合并和 Vultr 上线。
