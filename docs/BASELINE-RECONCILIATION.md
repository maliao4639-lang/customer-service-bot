# 线上源码基线核对

本轮找到了本机保存的历史部署记录和源码，不应再把“GitHub main 是线上完整源码”当作前提。

## 证据

- GitHub main 基线：`aaf98db248f1fc7fd039e64cbde0d53131504f74`，早期 Stripe 代码。
- 本机历史项目：`C:/Users/21267/Documents/Codex/2026-09-27/i/work/getshopreply-brand`；HEAD 为 `4536ef4`，前序包括 `f138829` 和订单试点 `820980f`。
- 历史阶段二部署记录日期为 2026-10-01，记录 `/opt/csb` 的订单试点部署和 `csb.service` 重启；历史正式订阅记录明确提醒旧本地 Paddle 工作目录不能直接覆盖线上。
- 负责人于 2026-10-20 本人在 Vultr Console 执行只读核对。`/opt/csb/server.js`、`db.js`、`package.json`、`llm.js` 四个核心文件的 SHA256 与上述本机源码逐一相同，`systemctl is-active csb` 返回 `active`。
- Paddle、public-guards、五个 order-lookup JS、widget JS/CSS、home/pricing/refunds/signup 共 13 个配套文件的 SHA256 输出再次汇总，结果为 `c2cc2987497898a29a84fea7ab096a2be2ed51c2fd176c3aad94fe6fd252df1e`，与本机计算完全一致。合计核对 17 个关键文件；这不代表整个服务器目录或运行配置已核对。
- 一次 BatchMode + StrictHostKeyChecking 只读 SSH 尝试曾返回认证拒绝；随后由负责人通过 Console 提供哈希。没有读取生产 `.env`、数据库或私钥，没有更改服务器。

## 运行位置与核对边界

| 项目 | 路径 / 名称 |
| --- | --- |
| 应用 | `/opt/csb` |
| 服务 | `csb.service` |
| 数据库 | `/opt/csb/data/app.db` |
| 通用环境 | `/opt/csb/.env` |
| Paddle Live 环境 | `/etc/csb-paddle-live.env` |
| 订单试点私有目录 | `/opt/csb/private` |
| Caddy | `/etc/caddy/Caddyfile` |
| 发布与回滚备份 | `/var/backups/csb/releases/` |
| 一致性备份工具 | `/usr/local/sbin/csb-backup` |

## 必须保留并核对的代码

| 历史源码 | 与当前 PR 的关系 |
| --- | --- |
| `public-guards.js` | 登录防护、Origin、可信代理、会话与限流；不可回退为早期版本 |
| `paddle.js` 和四个既有回归脚本 | 独立站订阅与安全规则；Shopify 商家不能通过旧计费路径改变权益 |
| `order-lookup/*` | 已单独运行的只读订单试点，不是本 Shopify app 的新权限/功能 |
| `public/widget/embed.js`、widget CSS | 历史版本含订单表单；当前 PR 的 quota/handoff 修复应移植，不应直接覆盖 |
| `public/home.html`、signup/pricing/refunds/Paddle 页面 | GitHub 老基线缺失；上线时必须保留 |
| `server.js`、`db.js`、`llm.js` | 真实会话、计数、部署监听与模型配置需逐处对照 |

已按上述已核对的源码准备整合：保留公共路由防护、带期限的会话、Stripe 幂等事务、Paddle、只读订单试点和静态页面，加入 Shopify 模块及跨计费渠道隔离。五套原有 smoke、billing、public、Paddle、order-lookup 回归均通过；新增 Shopify 与计费隔离测试共 25 项通过，30 个 JavaScript 文件语法检查通过。

订单试点仍使用原来的受保护私有配置，Shopify app 不申请订单权限，也不启用该试点入口。Paddle/Stripe 的 checkout、回调和全局权益刷新不能改写 Shopify 商家的套餐或额度。生产现有环境、密钥、私有目录、数据库和服务管理文件不属于本次源码同步范围；发布前仍需确认这些运行配置和备份。

## 负责人在已登录服务器终端可运行的只读核对

只复制以下命令的输出即可；不要复制环境文件或数据库内容：

```sh
sha256sum /opt/csb/server.js /opt/csb/db.js /opt/csb/package.json /opt/csb/llm.js
systemctl is-active csb
```

核对后再确定源代码提取与移植方案。不得用历史压缩包直接覆盖今天运行的代码。合并 PR 和上线仍需负责人明确确认。
