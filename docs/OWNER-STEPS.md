# 负责人亲自操作清单

按顺序做。不要把 URL 手填进网页；仓库 `shopify.app.toml` 是配置来源，用 CLI 推上去。下表的值只用来核对 Dev Dashboard。需要登录 Shopify 的步骤都在你自己的浏览器里用 Google 账号完成。不要把 API secret、加密密钥或 DeepSeek 密钥发到聊天。

已确认、不要改掉的事实：

- 开发店真实域名：`getshopreply-test-4k85f5hy.myshopify.com`（后台显示名 getshopreply-test）
- 已有应用 client id：`361cd9115e2b28f23410adcc5f64050c`
- 线上现在 `GET https://getshopreply.com/shopify` 返回 `Cannot GET /shopify`，因为这版代码还没部署
- 线上隐私页仍是旧版，联系邮箱还是 `maliao4639@gmail.com`

## A. 本机连接开发店（现在就可以做）

在项目目录准备 `.env`（不提交）：

```dotenv
SHOPIFY_API_KEY=361cd9115e2b28f23410adcc5f64050c
SHOPIFY_API_SECRET=Dev Dashboard → GetShopReply → Settings → Client credentials 里的 Client secret
SHOPIFY_TOKEN_ENCRYPTION_KEY=运行 openssl rand -hex 32 得到的 64 位十六进制
SHOPIFY_BILLING_TEST=true
PUBLIC_BASE_URL=https://getshopreply.com
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_API_KEY=你本地已有的 DeepSeek 密钥
SHOPIFY_FLAG_STORE_PASSWORD=开发店 Online Store → Preferences 里的前台密码
SESSION_SECRET=任意不少于 32 位的随机串
```

开发用的加密密钥和生产用的不是同一把。生产那把一旦写入服务器就不能再换，否则已保存的店铺令牌解不开。

```powershell
npm ci
npm install --prefix ../shopify-cli @shopify/cli@4.9.4
npm run check
npm test
npm run shopify -- app dev --config shopify.app.toml --store getshopreply-test-4k85f5hy.myshopify.com
```

浏览器要求登录时用 Google。选择已有组织 GetShopReply 和已有应用 GetShopReply，不要新建应用。这个窗口要一直开着。

1. 安装应用，内嵌后台出现 Connected。
2. 填写店名、物流、退货政策和一条 FAQ，保存。点 Open theme editor，在 App embeds 打开 GetShopReply chat，保存主题。不要改 `theme.liquid`。
3. 打开店铺前台，用前台密码进入。问一个物流问题，回答应来自你刚保存的政策。再问订单状态，留下测试邮箱，后台 Questions for your team 能看到。
4. 点 Pro — $21 / 30 days。确认页必须带测试标记。批准后再点 Pro — $205 / year。然后 Cancel Pro，确认后回到 Free、额度 100。不要批准没有 Test 标记的付款。
5. 保持 `app dev` 运行，在开发店卸载应用。终端必须出现：

```text
[shopify-webhook] outcome=ok topic=app/uninstalled shop=getshopreply-test-4k85f5hy.myshopify.com
```

- `bad_hmac`：`SHOPIFY_API_SECRET` 不是这个应用的 secret。
- `shop_id_mismatch`：把这一行原样记下来，先不要提交审核。
- 完全没有这一行：通知没到这个进程。先不要 `app deploy`，也不要提交审核。

6. 重新安装。应再次 Connected，卸载前的测试聊天不再出现。

## B. 部署到现有服务器（要你明确同意之后；这次没有改服务器，也没有合并 main）

服务器是 Vultr 上的 `139.180.143.31`，应用目录 `/opt/csb`，服务 `csb.service`，数据库 `/opt/csb/data/app.db`，环境文件 `/opt/csb/.env`。前面是 Caddy，`/shopify` 已经会转到 Node。不要改 DNS，不要动 SPF、DKIM、DMARC。

先备份 `/opt/csb/data/app.db`（含 WAL）。把下面几项加进 `/opt/csb/.env`。已经在用的 `LLM_API_KEY`、`LLM_MODEL`、`SESSION_SECRET`、`PORT` 保持原值，不要改成仓库里的 OpenAI 默认。

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://getshopreply.com
BIND_HOST=127.0.0.1
SHOPIFY_API_KEY=361cd9115e2b28f23410adcc5f64050c
SHOPIFY_API_SECRET=与 Dev Dashboard 里这个应用的 Client secret 相同
SHOPIFY_TOKEN_ENCRYPTION_KEY=在服务器上 openssl rand -hex 32，只放密码库和这个文件
SHOPIFY_BILLING_TEST=false
CSB_ALLOW_MOCK_BILLING=0
CSB_DATA_DIR=/opt/csb/data
```

`LLM_BASE_URL` 应为 `https://api.deepseek.com`。开发店测过的模型名是 `deepseek-flash`；若服务器上已是别的 DeepSeek 模型名，保留服务器上的值。

更新 `/opt/csb` 代码后执行 `systemctl restart csb`，然后在你自己的电脑上检查：

```sh
curl -sS https://getshopreply.com/shopify | head -c 400
curl -sS https://getshopreply.com/privacy | head -c 500
journalctl -u csb -n 30 --no-pager
```

- 第一个命令要包含 `shopify-api-key`，不能再是 `Cannot GET /shopify`。
- 第二个命令要包含 `support@getshopreply.com` 和 `No. 269 Chenghua North Road`，不能再是 `maliao4639@gmail.com`。
- 日志要有 `[boot] public_base=https://getshopreply.com llm_base=https://api.deepseek.com llm_model=... shopify_configured=true`。`shopify_configured=false` 表示三个 Shopify 变量里有一个不对。

## C. 把配置发布到 Dev Dashboard（B 的 curl 成功之后）

```powershell
npm run shopify -- app deploy --config shopify.app.toml
```

询问是否 release 时选是。不要新建应用。发布后打开该版本的配置，逐项核对：

| 字段 | 必须等于 |
| --- | --- |
| App URL | `https://getshopreply.com/shopify` |
| Embedded in Shopify admin | 开启 |
| Redirect URL | `https://getshopreply.com/shopify` |
| Scopes | 空。不要勾选订单、顾客、内容权限 |
| Webhook API version | `2026-10` |
| `app/uninstalled` | `https://getshopreply.com/shopify/webhooks` |
| `app_subscriptions/update` | `https://getshopreply.com/shopify/webhooks` |
| `customers/data_request` | `https://getshopreply.com/shopify/webhooks` |
| `customers/redact` | `https://getshopreply.com/shopify/webhooks` |
| `shop/redact` | `https://getshopreply.com/shopify/webhooks` |

如果还显示 `https://example.com`，说明新版本没有 release。如果显示 `https://getshopreply.com/shopify/shopify/webhooks`，这版代码也能收到，但请确认 toml 里的 `uri` 仍是 `/webhooks` 后再 deploy 一次。

## D. 用生产地址再测一次 getshopreply-test

这一步不要开 `app dev`，否则 URL 会临时改回隧道。从开发店后台打开 GetShopReply，页面应来自 `getshopreply.com`。再走一遍：保存政策、打开 App embed、前台提问、测试计费升到年付再取消回 Free、卸载。卸载时服务器日志要有 `outcome=ok topic=app/uninstalled`。然后重装，确认是新的空店铺数据。

## E. 提交审核（只有你能点）

1. 在 Dev Dashboard 查看 App Store 登记费。未付则按页面支付；交接单写的是一次性 19 美元，以结算页为准。
2. 名称填 `GetShopReply ‑ AI FAQ Chatbot`。副标题、英文介绍和审核测试说明用 `docs/LISTING.md`。不要把“去掉品牌、导出 CSV、每周未答报告”写成现有功能，这三项还没做。
3. 定价：Free，0 美元，每店每 UTC 月 100 条 AI 回复。Pro，21 美元 / 30 天，或 205 美元 / 年，每店每 UTC 月 500 条。用完后仍可留言，没有超量费。
4. 隐私政策 URL：`https://getshopreply.com/privacy`。客服邮箱：`support@getshopreply.com`。运营主体：Maliao，No. 269 Chenghua North Road, Fengze District, Quanzhou, Fujian, China 362000。
5. 用真实开发店截至少 3 张 1600×900 的图，准备 1200×1200 图标，并录一段英文演示（安装、打开 App embed、保存政策、前台回答、留下邮箱）。仓库里的草稿图不能当正式素材。
6. 测试账号只填在 Shopify 的审核表里，不写进 Git。
7. 你本人点击提交审核。合并 main 和重启 Vultr 都要另外再确认一次。
