# Production deployment proposal — approval required

## Confirmed target

Use the existing backend and domain, as selected by the owner:

| Setting | Value |
| --- | --- |
| App URL | `https://getshopreply.com/shopify` |
| Redirect URL | `https://getshopreply.com/shopify` |
| Webhooks | `https://getshopreply.com/shopify/webhooks` |
| Privacy / terms | `https://getshopreply.com/privacy`, `https://getshopreply.com/terms` |
| Support | `support@getshopreply.com` |
| Host / AI | Vultr / DeepSeek, confirmed by owner |
| Database in this branch | Node's embedded SQLite on a persistent local volume |

Read-only DNS/HTTP checks on 2026-10-20 observed A `139.180.143.31` and an HTTP `Via: 1.1 Caddy` response. These checks do not establish the server's internal process, paths, ports, model configuration or backup policy.

## DNS

**No Namecheap DNS edit is needed for the selected existing-domain deployment.** Preserve the domain's existing mail records, SPF, DKIM and DMARC.

| Record | Host | Value | Action |
| --- | --- | --- | --- |
| A | `@` | `139.180.143.31` observed publicly | Keep; verify against the Vultr instance before any infrastructure work |
| CNAME (optional future alternative) | `app` | `getshopreply.com` | Only if the owner later chooses a separate app subdomain; do not add now |

A future `app` subdomain also needs a Caddy virtual host/TLS certificate and consistent TOML/runtime URLs. Adding DNS alone does not deploy the backend.

## Important baseline mismatch

Historical local deployment records and a later local Git project have now been found. They identify `/opt/csb`, `csb.service`, `/opt/csb/data/app.db`, `/opt/csb/.env` and a separate Paddle environment; these paths still need current-server verification. See `BASELINE-RECONCILIATION.md` for the candidate source and safe hash-check commands. Existing SSH authentication was unavailable, so no current server source was read.

The live privacy notice describes DeepSeek, Vultr, Paddle and a Resend-assisted order-lookup pilot. This repository baseline has Stripe scaffolding and no pilot implementation. The owner confirmed Vultr/DeepSeek, but no server source or runtime configuration has been accessed. Public policy statements alone do not prove a feature is currently active. Before merging/deploying, compare the running application with GitHub, import legitimate missing code into an audited branch, and preserve the live billing, order lookup and static pages. Do not overwrite the running server with this older baseline.

## Environment variables

| Variable | Production value / handling |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | Existing internal service port, to be discovered on the server |
| `PUBLIC_BASE_URL` | `https://getshopreply.com` (origin only) |
| `HOST` | Optional alias; omit when `PUBLIC_BASE_URL` is set |
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
2. Resolve the server/GitHub mismatch above. Review the merged code and migrations against a backup copy of the real schema. The current branch assumes the `merchants`, `faqs`, `conversations` and `escalations` tables from this repository; the running app may differ.
3. Run `npm ci`, `npm run check`, `npm test` and `npm run shopify -- app build --config shopify.app.toml` in staging. Do not introduce multi-worker clustering: token refresh serialization currently assumes one Node process and one durable SQLite database.
4. Add Shopify environment variables to the real service manager without printing values. Keep existing AI, legacy billing and session configuration. The production encryption key must be stable across restarts and deployments.
5. Preserve existing Caddy routes. Ensure `/shopify` and `/shopify/*` reach the Node app; preserve raw JSON bodies and Shopify headers for webhooks. Ensure `/static/shopify.js`, `/embed.js`, `/static/widget.css`, `/api/chat` and `/api/chat/handoff` reach the same service. In a staging copy, reconcile static `/privacy` and `/terms` routing with the new pages before switching them.
6. Deploy the approved backend revision using the existing service manager and disk. Verify health, existing standalone login, legacy billing and any order pilot before changing the Shopify release.
7. Publish the tested Shopify app version using `npm run shopify -- app release --version VERSION --config shopify.app.toml`. A CLI version upload is separate from a backend deployment. This task uploads unreleased versions for review and does not authorize a main merge or server rollout.
8. Verify install, App Home, theme embed, test billing, cancellation, GDPR callbacks and uninstall on the development store, then follow the approved production smoke-test plan. Do not incur a real production subscription charge without explicit owner authorization.
9. Monitor webhook delivery failures, token refresh failures and persistent disk health. Verify cleanup scheduling and agree on backup expiry and deletion replay. Roll back application code and Shopify release if needed; do not restore deleted personal data without replaying deletion requests.

No SSH connection, server file update, DNS change, service restart, main merge or production rollout was performed by this task.
