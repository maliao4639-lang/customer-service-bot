# 线上源码基线核对

本轮找到了本机保存的历史部署记录和源码，不应再把“GitHub main 是线上完整源码”当作前提。

## 证据

- GitHub main 基线：`aaf98db248f1fc7fd039e64cbde0d53131504f74`，早期 Stripe 代码。
- 本机历史项目：`C:/Users/21267/Documents/Codex/2026-09-27/i/work/getshopreply-brand`；HEAD 为 `4536ef4`，前序包括 `f138829` 和订单试点 `820980f`。
- 历史阶段二部署记录日期为 2026-10-01，记录 `/opt/csb` 的订单试点部署和 `csb.service` 重启；历史正式订阅记录明确提醒旧本地 Paddle 工作目录不能直接覆盖线上。
- 这些是历史证据，尚未核对今天服务器文件哈希。一次 BatchMode + StrictHostKeyChecking 只读 SSH 尝试返回认证拒绝；没有读取生产 `.env`、数据库或私钥，也没有更改服务器。

## 历史记录中的运行位置（仍需现网确认）

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

在确认现网版本后，把 Shopify 模块和必要改动移植到核对过的基线，再同时运行原有 smoke、billing、public、Paddle、order-lookup 回归与新增 Shopify 测试。当前 PR 的独立开发店验证不等同于该移植完成。

## 负责人在已登录服务器终端可运行的只读核对

只复制以下命令的输出即可；不要复制环境文件或数据库内容：

```sh
sha256sum /opt/csb/server.js /opt/csb/db.js /opt/csb/package.json /opt/csb/llm.js
systemctl is-active csb
```

核对后再确定源代码提取与移植方案。不得用历史压缩包直接覆盖今天运行的代码。合并 PR 和上线仍需负责人明确确认。
