# 负责人操作步骤（交接 2）

## 已完成

你已本人完成 Google/Shopify CLI 登录。CLI 已选择 GetShopReply 组织和已有 GetShopReply 应用，并找到开发店真实域名：`getshopreply-test-4k85f5hy.myshopify.com`。无需在网页上逐项手填应用 URL；仓库 TOML 管理配置，CLI 上传。

## 本地联调环境

在项目目录打开 `.env`。本文件只保存在你的电脑上，不提交 Git。开发店前台密码写法：

```dotenv
SHOPIFY_FLAG_STORE_PASSWORD="在这里填写前台密码"
```

前台密码在开发店 Online Store → Preferences → Password protection 中查看。它不是 Google 密码、Shopify 账号密码或 App secret。

AI 环境还需要服务器实际使用的三个值。不要发送密钥到聊天，直接在 `.env` 填写并保存：

```dotenv
LLM_BASE_URL=从服务器核对的DeepSeek接口地址
LLM_MODEL=从服务器核对的模型名称
LLM_API_KEY=从服务器安全复制的DeepSeek密钥
```

服务商已由你确认是 Vultr 和 DeepSeek，但仓库默认值不能证明服务器实际模型。若没有服务器访问权限，先联系管理 Vultr 实例的人；不要凭模型名称猜测。账号和 App secrets 同样只放本地或服务器的受保护配置中。

可复制的启动命令：

```powershell
npm run shopify -- app dev --config shopify.app.toml --store getshopreply-test-4k85f5hy.myshopify.com
```

CLI 打开 Shopify 页面后，所有需要 Google/Shopify 登录的操作由你本人完成。保持 CLI 运行，完成安装后再测试 App Home 和主题开关。开发环境只使用测试计费；不要批准任何没有明确测试标记的真实收费。

## 本人完成的审核与发布步骤

先在已有 GetShopReply 应用的 Home → Distribution → Select distribution method 选择 **Public distribution / Shopify App Store**。真实 Billing API 已返回尚未公开分发的限制，必须先完成这一设置才能继续测试收费。不要选择 Custom；分发方式选择后不可更改，详见 [Shopify 官方说明](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method)。如果页面已经显示 Custom，请保留现状并告知开发者，不要重复创建应用或尝试绕过。

1. 在 Partner/Dev Dashboard 查看 App Store 注册状态，按 Shopify 当前页面支付一次性登记费用。交接单预期为 USD 19；以你的实际结算页面为准。本任务不会代付。
2. 确认 Pro 当前仅增加到每月 500 条回复，价格为 USD 21/30 天或 USD 205/年。去品牌、CSV 导出、周报是待决定功能，目前未实现，不应写成现有权益。
3. 在 `docs/APP-STORE-CHECKLIST.md` 中关闭真实安装、回答、计费、webhook、性能、域名法律页和服务器代码差异等待验收项。按 `docs/LISTING.md` 拍摄真实商店截图并录制英文演示；本地样例截图只能作草稿。
4. 核对 `docs/DEPLOYMENT.md` 的具体部署方案，再明确批准合并 PR 和服务器上线。未收到这项确认，不合并 main、不重启或覆盖 Vultr 上的现有后端。
5. 核对已上传的 Shopify 版本后，决定发布版本；版本上传和后端部署是两个独立动作。不要在生产 `/shopify` 尚不可用时提交审核。
6. 在提交表中填写 support@getshopreply.com、运营主体 Maliao 和地址、测试说明、紧急开发者联系人；确认当前隐私披露、服务商、备份及保留规则正确。
7. 负责人本人在 Partner/Dev Dashboard 点击提交审核。本任务不会替你点击最终提交。

## 需要迁移到其他电脑时

```powershell
npm ci
npm install --prefix ../shopify-cli @shopify/cli@4.9.4
npm run shopify -- app config link --file-name linked
node scripts/configure-shopify.js
npm run shopify -- app config use shopify.app.toml
npm run shopify -- app build --config shopify.app.toml
```

关联时选已有应用。辅助脚本保留仓库配置的 URL、空 scopes 和五个 webhook，避免导入远程旧的 example.com 设置覆盖本次配置。不使用 `--verbose`，避免输出敏感诊断内容。
