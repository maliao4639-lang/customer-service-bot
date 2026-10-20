# Shopify app: local development and deployment

This branch extends the existing Express + Node SQLite service. It does not create a second backend or migrate existing accounts automatically. Shopify authentication is independent of standalone login cookies. Node 24 LTS is recommended.

## Handoff 2 update (2026-10-20)

The owner completed CLI browser authentication. CLI 4.9.4 linked the existing GetShopReply app in the GetShopReply organization. The actual development store domain discovered by CLI is `getshopreply-test-4k85f5hy.myshopify.com`, rather than the shorter display name. Canonical production URLs now use `https://getshopreply.com/shopify`; no additional DNS is needed. See `DEPLOYMENT.md`, `INTEGRATION-RESULTS.md`, `OWNER-STEPS.md` and `APP-STORE-CHECKLIST.md` for the current evidence and remaining actions. The live website differs from this GitHub baseline and must be reconciled before a server deployment.

## Architecture

- `/shopify`: embedded App Home, App Bridge and Polaris web components (stable v1 CDN).
- `/shopify/api/*`: server-verified HS256 App Bridge ID tokens. Validates signature, algorithm, audience, issuer, destination, expiry, not-before and issued-at. Shop identity comes from the verified token, never a body parameter or cookie.
- Managed installation + OAuth token exchange, with **expiring offline tokens**. No authorization-code callback or additional account signup is needed. Access and refresh tokens are AES-256-GCM encrypted and refreshed under a per-shop lock.
- Zero requested content/customer/order scopes. Policies and FAQs are entered manually. Billing and app-installation-owned metafields are used without requesting theme-write or content-read scopes.
- The app writes a public widget key and base URL to `AppInstallation` metafield `shopreply.widget`. Liquid reads it using `app.metafields.shopreply.widget.value`. Admin API credentials never enter Liquid or the browser.
- Theme extension `shopreply-embed` adds the existing widget after the page becomes idle. No ScriptTag API or theme source editing.
- Shopify Billing API: Free (no charge), Pro USD 21 / `EVERY_30_DAYS`, Pro USD 205 / `ANNUAL`. Server-controlled amount, currency and interval. Paid access is synchronized from active Shopify subscriptions, including on app load and subscription webhooks. A pending checkout or return URL grants no access.
- `/shopify/webhooks`: raw-byte HMAC verification, durable delivery-ID deduplication and atomic local writes. Subscription notifications cause an API reconciliation, so an older notification cannot overwrite newer status. Failures return non-200 so Shopify can retry.
- Dedicated accounts per Shopify shop prevent email-based account takeover and accidental conversion of an existing Stripe subscription.

## Run and validate locally

```sh
npm ci
npm run check
npm test
```

Tests create and remove their own temporary SQLite directory, mock Shopify and AI calls, and run the real Express routes. `node scripts/smoke.js` runs the same suite. There is no separate frontend build or lint configuration in this repository.

For actual Shopify development:

1. Use the existing GetShopReply organization and GetShopReply app. Do not create a duplicate app. The owner completes browser authentication and any applicable registration payment directly with Shopify.
2. Install the pinned CLI with `npm install --prefix ../shopify-cli @shopify/cli@4.9.4`. Use `npm run shopify -- app config link --file-name linked`, then `node scripts/configure-shopify.js` and `npm run shopify -- app config use shopify.app.toml`. The helper imports the linked public client ID while retaining this branch's URLs, empty scopes and webhooks; it does not print credentials.
3. Copy `.env.example` to `.env`; supply `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SESSION_SECRET`, AI provider configuration and `SHOPIFY_TOKEN_ENCRYPTION_KEY`. The encryption key must be 32 random bytes as 64 hex characters. Generate it locally and put it directly in your environment/secret manager; do not paste it in chat or logs.
4. Set an HTTPS `PUBLIC_BASE_URL` reachable by Shopify. It is the **origin**, without `/shopify`. Configure the CLI tunnel or an HTTPS development host; keep the environment value aligned with the app URL origin. Use a separate database (`CSB_DATA_DIR`) and `SHOPIFY_BILLING_TEST=true` for development.
5. Run `npm run shopify -- app dev --config shopify.app.toml --store getshopreply-test-4k85f5hy.myshopify.com`. The wrapper reads local `.env` for CLI flags such as `SHOPIFY_FLAG_STORE_PASSWORD`. The Express dev command is declared in `shopify.web.toml`; it uses `PORT` and the public `APP_URL` / `HOST` (or `SHOPIFY_APP_URL` compatibility alias) supplied by CLI. Shopify requests to the tunnel root redirect to `/shopify` without forwarding an ID token in the URL. Production explicitly uses `PUBLIC_BASE_URL`.
6. Open the dashboard once so it exchanges the session token, creates the shop account and publishes its widget configuration. Enter policies/FAQs, enable ShopReply chat in App embeds, and save the theme. The deep link selects `CLIENT_ID/shopreply-embed`.
7. Use Shopify CLI validation/build for the extension, and check the generated extension `uid` into the branch if Shopify assigns one. This cannot be completed without the owner's app registration.

The app intentionally returns 503 for an unconfigured Shopify integration; standalone routes remain usable. HTTPS is required even for Shopify development. Do not turn on production billing for local tests.

## Deploy to a staging service first

1. Review the diff and run the checks above. Back up the SQLite database before running the updated server. Migrations add Shopify tables and do not convert existing standalone accounts. The monthly reset correction applies to both channels; it preserves the existing current-month count.
2. Use a single running Node process with a durable writable disk. Set `CSB_DATA_DIR` to that disk, keep `SHOPIFY_TOKEN_ENCRYPTION_KEY` stable across deployments, and protect environment secrets. This implementation's in-memory per-shop serialization is not suitable for multiple workers/replicas without a distributed lock and shared database redesign.
3. Set `PUBLIC_BASE_URL=https://STAGING_HOST`; configure the actual client ID and URLs in `shopify.app.toml`. Register `application_url=https://STAGING_HOST/shopify`. Match app credentials to that configuration.
4. Terminate HTTPS at a trusted proxy; do not let the proxy overwrite the raw JSON webhook bytes or remove Shopify HMAC, topic, shop, webhook-ID and triggered-at headers. Allow framing of `/shopify` by Shopify admin. The app sets CSP frame ancestors itself.
5. Start `npm start` under your process manager. Ensure startup/hourly retention jobs run. Use encrypted storage/backups, restrict filesystem access, monitor service failures and webhook retries, and define backup expiration and deletion replay procedures.
6. Run `shopify app deploy` only for the intended registered staging app, after checking the TOML contains no placeholder URL/client ID. This publishes app configuration/extensions, not the Express server. Verify all five webhook topics are registered and delivered.
7. Run the real-store acceptance flow below. Review privacy text against actual hosting/AI providers, international data transfers, backup retention, operating entity and contact details. `/privacy` and `/terms` are included in this repository, but these operational facts must be finalized before public publication.
8. For a production deployment, repeat on the production app/host with `NODE_ENV=production`, `SHOPIFY_BILLING_TEST=false` and mock billing disabled. No deployment or automatic main-branch merge is included in this change.

## Real development-store acceptance

- [ ] Fresh install from Shopify, App Home in the admin iframe, no standalone signup or third-party-cookie dependency.
- [ ] No unnecessary scopes in the installation permission screen. Invalid/expired ID tokens cannot call the API.
- [ ] Save shipping/returns policies and FAQs; preview an answer. Confirm preview does not consume a storefront reply.
- [ ] Enable App Embed via deep link and save. Chat appears on all intended storefront pages; no source edit required. Check current theme and a second supported theme.
- [ ] Ask a grounded question and receive an answer; ask an unsupported question and save an email. Verify it appears only for that shop.
- [ ] Compare Lighthouse before/after enabling the embed on the same storefront/device conditions. Record actual results; no performance score is claimed by unit tests.
- [ ] Approve monthly test charge: USD 21, 30-day interval, 500 replies. Deny a checkout and verify no upgrade. Reload/return from Shopify and verify state is reconciled.
- [ ] Switch to annual USD 205, verify Shopify replacement/proration behavior, duplicate confirmation clicks and a reopened checkout. Plan changes retain used replies.
- [ ] Cancel in the app after explicit confirmation; verify Shopify cancellation and the Free allowance. Cancellation uses `appSubscriptionCancel(prorate: true)` and has an in-app confirmation, since this API does not return a hosted cancellation confirmation URL.
- [ ] Exhaust 100/500 replies; the next AI request is blocked, but the visitor can submit the original question/email without any AI quota or pricing CTA.
- [ ] Verify UTC month rollover and API failure refunds; no daily reset or reset upon plan switching.
- [ ] Send all compliance webhooks with valid Shopify signatures. Data requests create encrypted dashboard exports; verify requester identity and deliver within the applicable deadline. Delete delivered exports. No outbound email is sent automatically.
- [ ] Customer-redaction test: matching handoffs removed; all shop chat history removed conservatively; prior privacy exports removed. Repeat the delivery to check idempotency.
- [ ] Uninstall: account/policies/FAQs/chats/handoffs removed, encrypted credentials removed, old public widget key rejected. Receive `shop/redact`; clear the remaining tombstone. Reinstall and check stale notifications cannot erase the new account.
- [ ] Test mobile admin, keyboard operation, dark/light mode and published `/privacy` and `/terms` links.

## Existing merchants / Stripe migration

No existing email/account is automatically linked, upgraded, cancelled or charged by this branch. The Shopify dashboard explains that existing policies are not imported and advises existing customers to contact support before subscribing. Before migrating an existing store, authenticate both the existing account and the Shopify store owner, inventory active Stripe subscriptions/lifetime access and agree on credit/cancellation timing. Copy authorized policies/FAQs into the Shopify account and explicitly resolve the old subscription before starting a new charge. Do not infer ownership from a matching email. A migration/import UI, automatic credits and Stripe cancellation tooling are **not implemented** and must be completed before inviting existing paid users to migrate.

Stripe checkout, mock upgrades, local trials and Stripe cancellation webhooks cannot change a Shopify-linked account's tier. Existing unrelated standalone accounts retain their original flows. No extra Pro-only features or order lookup were added.

## Data operations

Shopify chat/handoff records and email-to-session mappings expire after 90 days via startup/hourly cleanup. Privacy exports are encrypted and expire after 30 days; pending exports are visible in App Home. Delivery remains a merchant/operator responsibility. `customers/redact` clears all conversation history for the shop because anonymous messages cannot reliably be matched by customer ID. Minimal installation metadata remains after uninstall until `shop/redact`. Backups/AI-provider retention must be configured separately and reflected in the final policy.

## Official references checked during implementation

- [Implement managed installation/token exchange without a template](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange)
- [Access tokens, expiring offline credentials and refresh](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- [Theme app extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)
- [App-data metafields](https://shopify.dev/docs/apps/build/metafields)
- [App subscription creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate)
- [Cancellation and prorated credits](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCancel)
- [Privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
- [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
