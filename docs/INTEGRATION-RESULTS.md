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
| 版本上传 | 已上传未发布 | 整合后的扩展和配置已创建 [getshopreply-4](https://dev.shopify.com/dashboard/241817759/apps/437534851073/versions/1173848064001)；使用 `--no-release`，Theme Check / bundling / validation 成功；未切换生产活动版本 |
| 本地启动 | 通过 | 更正密码后 CLI 开发预览已启动，主题服务器 ready，真实隧道可用 |
| 安装 / OAuth / App Home | 通过 | 负责人在普通浏览器看到真实后台；开发数据库确认已获取加密离线凭据，真实 Admin GraphQL 查询成功，widget 配置已发布 |
| Theme Editor / App Embed | 通过 | 密码保护的真实开发店预览可检测 App Embed 和 loader，聊天按钮、面板展开/关闭及邮箱按需显示均通过；Shopify 底部预览条会遮住按钮，收起后可点击。修复组件 display 样式覆盖 hidden 状态的问题 |
| 实际 AI 回答 | 真实前台通过 | 负责人更换有余额账号的密钥后，https://api.deepseek.com、deepseek-flash 真实调用成功。独立 HTTP 测试通过；进一步在真实开发店浏览器中临时加入明确标记的测试 FAQ，前台返回 3–5 个工作日，未知订单请求邮箱，提交后人工转接已入库；成功回答计数一次、转接不扣额度。测试 FAQ、测试会话、测试转接及测试用量已清理，没有替换实际商店政策或使用真实顾客资料 |
| Shopify 月付/年付 test billing | 通过 | 负责人已设置公开分发；真实月付订阅 ACTIVE、test=true、21 USD / EVERY_30_DAYS，本地权益同步 pro_monthly；切换年付后 ACTIVE、test=true、205 USD / ANNUAL，本地权益同步 pro_annual。没有真实扣款 |
| 取消 / 降级 | 通过 | 通过真实 Shopify API 取消年付测试订阅；随后只读查询 activeSubscriptions 为空，本地套餐恢复 free、用量 0。此项验证 API 取消和同步，不代表后台取消按钮已完成人工界面验收 |
| GDPR / 卸载投递 | 发现投递问题，待修复验收 | 已对空白开发店执行真实 appUninstall，Shopify 接受且旧令牌返回 401；观察期内本地未收到卸载通知，测试记录未被该通知自动清除，不能记为通过。负责人重新安装后打开原先占位页，正在恢复开发预览。已修复新 App Bridge 会话依赖被撤销旧凭据的问题，并在安装标识变更时隔离和清理旧数据；本地新增回归通过。GDPR 真实投递也待验收 |
| Lighthouse | 诊断已测，正式对照待验收 | 整合前版本完成三组移动端诊断：拦截组件脚本分数 83/90/93，正常加载 80/88/97；缓存和顺序影响明显，不能当作真实主题开关对照或最终版本验收。完整 HTML/JSON 已保存，见 PERFORMANCE.md |
| 本地后端回归 | 整合版通过 | 五套既有 smoke、billing、public、Paddle、order-lookup 回归均通过；增加通知丢失后恢复安装用例后，Shopify 与跨计费隔离共 26 项通过。此前 30 个 JavaScript 语法检查通过；新增修改已由测试加载验证。订单查询回归含 17 个场景，无真实邮件或订单 API 调用 |
| 生产源码对应关系 | 17 个关键文件匹配 | 负责人 Console 输出确认四个核心文件 SHA256 与本机较新基线逐一一致；13 个配套文件的汇总哈希也匹配；服务 active。已据此整合源码，未读取线上环境、数据库、私有配置或修改服务 |
| 本地素材 | 已生成草稿 | 三张不同 UI 视图 1600×900；原创 SVG 与 1200×1200 PNG；明确非真实开发店证明 |
| 生产操作 | 未执行 | main、Vultr 服务、DNS 和真实收费均未更改 |

2026-10-20 真实接口依次确认月付激活、切换年付、取消测试订阅；最终 activeSubscriptions 为空，本地权益 free、用量 0。负责人刷新后，widget origin 已同步到重启后的 CLI 隧道。独立自动化 Edge 的账号登录曾卡在 Cloudflare 验证页，因此 App Home 由负责人在普通浏览器登录；密码保护的店铺前台可由独立测试浏览器验证，真实聊天、人工转接和用量检查均已通过。

## 本轮修复

- 接入 CLI 的 `APP_URL` / `HOST` (or `SHOPIFY_APP_URL` compatibility alias)；生产保持 `PUBLIC_BASE_URL` 优先，避免临时隧道污染正式入口。
- 处理 CLI 从根路径打开应用的情况，重定向到 `/shopify`，不转发 URL 中的 ID token。
- 增加读取本地环境的 CLI 包装脚本及安全导入已关联 client ID 的辅助脚本。
- 补齐扩展 locale 文件并保留 CLI 分配的 extension uid；移除 CLI 已不支持的 include_config_on_deploy 配置。
- 根据自检增加商家分页读取本店聊天记录的后台入口，确保收集的数据可以在 Shopify 后台查看；这不涉及尚未确认的 Pro CSV 导出功能。
- 统一新应用、扩展、法律页面的 GetShopReply 名称和 support@getshopreply.com；补充运营主体与地址。

## 线上基线发现

公开 DNS 为 `139.180.143.31`，首页响应经过 Caddy。负责人确认 Vultr 和 DeepSeek。GitHub main 缺失的 Paddle、Resend 订单试点、公共路由防护及静态页面已从较新本机基线恢复；负责人通过 Console 核对 17 个关键源码文件与该基线一致，`csb` 服务 active。运行环境、生产模型、数据库和私有配置状态仍需在部署前确认。整合后的 Paddle/Stripe 路径不能改写 Shopify 套餐或额度，单独订单试点也不能为 Shopify app 账号提供订单访问。

## 下一步

负责人本人完成 App Home 登录、主题启用和测试订阅批准；整合后前台真实 AI 与转人工已再次通过。真实卸载测试发现通知投递问题，当前优先恢复开发预览、验证重新安装并定位通知来源/配置。随后处理 GDPR、正式性能对照和审核素材。后续可通过 `npm run shopify -- app dev --config shopify.app.toml --store getshopreply-test-4k85f5hy.myshopify.com` 恢复；重启导致隧道更换时需负责人刷新开发预览 App Home。正常应用入口在正式版本发布前可能仍指向旧占位页，不能将其当作已上线。完成剩余验收和负责人批准后，才决定活动版本发布、PR 合并和 Vultr 上线。
