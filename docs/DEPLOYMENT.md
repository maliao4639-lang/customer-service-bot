# Production deployment proposal — approval required

## Confirmed target

Use the existing backend and domain, as selected by the owner:

| Setting | Value |
| --- | --- |
| App URL | `https://getshopreply.com/shopify` |
| Redirect URL | `https://getshopreply.com/shopify` |
| Webhooks | `https://getshopreply.com/shopify/webhooks` (toml uri is `/webhooks`; CLI appends it to the app URL) |
| Privacy / terms | `https://getshopreply.com/privacy`, `https://getshopreply.com/terms` |
| Support | `support@getshopreply.com` |
| Host / AI | Vultr / DeepSeek, confirmed by owner |
| Database in this branch | Node's embedded SQLite on a persistent local volume |

Read-only DNS/HTTP checks on 2026-10-20 observed A `139.180.143.31` and an HTTP `Via: 1.1 Caddy` response. `GET /shopify` is already forwarded to Node and currently returns Express `Cannot GET /shopify`, because this branch is not deployed. `GET /privacy` is the older page and still shows `maliao4639@gmail.com`. These checks do not establish the server's internal port, the live `LLM_MODEL`, or the backup policy. The published privacy page names Vultr as the host and DeepSeek as the AI provider. The code calls `POST {LLM_BASE_URL}/chat/completions`; if those variables are unset it falls back to `https://api.openai.com/v1` and `gpt-4o-mini`. Do not deploy that fallback over the server's existing DeepSeek settings.

## DNS

**No Namecheap DNS edit is needed for the selected existing-domain deployment.** Preserve the domain's existing mail records, SPF, DKIM and DMARC.

| Record | Host | Value | Action |
| --- | --- | --- | --- |
| A | `@` | `139.180.143.31` observed publicly | Keep; verify against the Vultr instance before any infrastructure work |
| CNAME (optional future alternative) | `app` | `getshopreply.com` | Only if the owner later chooses a separate app subdomain; do not add now |

A future `app` subdomain also needs a Caddy virtual host/TLS certificate and consistent TOML/runtime URLs. Adding DNS alone does not deploy the backend.

## Important baseline mismatch

The owner ran read-only Vultr Console checks on 2026-10-20. Four core files under `/opt/csb` and a combined hash of 13 supporting files match the later local source at historical commit `4536ef4`. `csb.service` is active. The branch now integrates Shopify into that source, including Paddle, public guards, standalone static pages and the separately configured order-lookup pilot. See `BASELINE-RECONCILIATION.md` for exact scope. Runtime environment, private configuration and backup state remain to be checked; no production secrets were read.

The original GitHub main was an older Stripe-era baseline. Its missing production functionality has now been restored in the independent development branch and tested together with Shopify. Do not deploy the old main or an earlier Shopify source archive. Preserve `/opt/csb/private`, the existing database, service environment files and Caddy configuration when deploying the approved final revision.

## Environment variables

| Variable | Production value / handling |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | Existing internal service port, to be discovered on the server |
| `PUBLIC_BASE_URL` | `https://getshopreply.com` (origin only) |
| `BIND_HOST` | Local listening interface; preserve the current loopback binding unless proxy architecture requires otherwise |
| `HOST` | Legacy non-URL interface binding is retained; a CLI HTTPS URL is never used as a local bind address |
| `SHOPIFY_API_KEY` | Linked app's public client ID from TOML |
| `SHOPIFY_API_SECRET` | Actual app client secret in the server's protected environment |
| `SHOPIFY_TOKEN_ENCRYPTION_KEY` | Stable, unique 32 random bytes as 64 hex characters; back up securely |
| `SESSION_SECRET` | Existing strong session secret; do not casually rotate during migration |
| `SHOPIFY_BILLING_TEST` | `false` in production, `true` only for development-store tests |
| `CSB_ALLOW_MOCK_BILLING` | `0` |
| `CSB_DATA_DIR` | Discovered existing persistent database directory; do not point at an empty directory by accident |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | Preserve actual DeepSeek settings discovered on the server; do not use the repository's OpenAI defaults or expose the key |
| `APP_URL` / `HOST` (or `SHOPIFY_APP_URL` compatibility alias) | CLI tunnel variable for development; production ignores it in favor of the canonical origin |
| `SCOPES` | Not read by this implementation. Empty `access_scopes.scopes` in TOML is authoritative |

`SHOPIFY_FLAG_STORE_PASSWORD` is a local CLI-only storefront test setting, not an application secret for production. All actual secrets stay out of Git and logs. This branch adds ignore rules for CLI state and environment files.

## Steps to execute only after merge/deployment approval

1. Identify the running service, source directory, git commit, Node version, environment file, internal port, database path and Caddy routing. Export only sanitized configuration facts. Obtain a consistent SQLite backup, including WAL state, using SQLite's backup mechanism or a stopped-service copy. Record a tested restore procedure.
2. Review the reconciled revision and additive migrations against a backup copy of the actual schema. File hashes establish source correspondence for the checked files, not the current database schema or enabled runtime features. Preserve the existing Paddle/order-lookup private configuration and all standalone subscribers.
3. Run `npm ci`, `npm run check`, `npm test` and `npm run shopify -- app build --config shopify.app.toml` in staging. Do not introduce multi-worker clustering: token refresh serialization currently assumes one Node process and one durable SQLite database.
4. Add Shopify environment variables to the real service manager without printing values. Keep existing AI, legacy billing and session configuration. The production encryption key must be stable across restarts and deployments.
5. Preserve existing Caddy routes. Ensure `/shopify` and `/shopify/*` reach the Node app; preserve raw JSON bodies and Shopify headers for webhooks. Ensure `/static/shopify.js`, `/embed.js`, `/static/widget.css`, `/api/chat` and `/api/chat/handoff` reach the same service. In a staging copy, reconcile static `/privacy` and `/terms` routing with the new pages before switching them.
6. Deploy the approved backend revision using the existing service manager and disk. Verify health, existing standalone login, legacy billing and any order pilot before changing the Shopify release.
7. Publish the tested Shopify app version using `npm run shopify -- app release --version VERSION --config shopify.app.toml`. A CLI version upload is separate from a backend deployment. This task uploads unreleased versions for review and does not authorize a main merge or server rollout.
8. Verify install, App Home, theme embed, test billing, cancellation, GDPR callbacks and uninstall on the development store, then follow the approved production smoke-test plan. Do not incur a real production subscription charge without explicit owner authorization.
9. Monitor webhook delivery failures, token refresh failures and persistent disk health. Verify cleanup scheduling and agree on backup expiry and deletion replay. Roll back application code and Shopify release if needed; do not restore deleted personal data without replaying deletion requests.

No SSH connection, server file update, DNS change, service restart, main merge or production rollout was performed by this task.
