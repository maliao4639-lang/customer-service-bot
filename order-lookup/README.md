# Development-store order lookup pilot

This is a single-store pilot, not a public Shopify app or an OAuth implementation for other merchants. `createShopify` deliberately accepts only `getshopreply-test.myshopify.com`. No feature is enabled unless an encrypted, explicitly enabled configuration is present. Do not reuse client credentials for unrelated merchants.

## Files and boundaries

- `bootstrap.js`: opt-in mounting, exact merchant binding, HTTPS origin allowlist. Default config: `/opt/csb/private/order-lookup.enc`; decryption key: `/etc/csb-order-lookup.key`. Missing/invalid configuration disables the feature while the existing website continues.
- `providers.js`: Shopify client-credentials token refresh, `read_orders`, API version 2026-07, bounded exact order matching, rechecking email ownership after OTP, minimal status projection, Resend transactional email. No address, payment or phone fields are requested. Carrier URLs use a conservative HTTPS hostname allowlist; other carriers retain their name/number without a clickable link.
- `store.js`: a separate SQLite database under `private/order-state/`, not the existing application database. Encrypted temporary order reference, HMAC OTP and browser binding, persistent HMAC rate-limit identifiers. No plain order number, email, token, OTP or status cache. Application data schema is unchanged.
- `router.js`: explicit origin/merchant binding; browser-generated 256-bit session secret held only in memory; uniform 202 response before asynchronous lookup; OTP valid for 5 minutes and at most 5 guesses; synchronous consumption before querying Shopify prevents concurrent reuse. Verification returns the result directly, so no long-lived order access token or general order endpoint is exposed.
- `public/widget/embed.js`: independent order form. Recognized order questions open this form without calling chat. Arbitrary personal information typed in normal chat is **not** guaranteed to be detected. Closing, navigating away, or a five-minute result timer clears order UI state.

## Limits and retention

Single-instance only; the separate SQLite database holds atomic counters across restarts. At most 4 upstream jobs, 5 starts per IP/minute, 60 starts/hour, 300 starts/day, 30 email attempts/day, 3 requests per email or order/15 minutes, 60-second email cooldown, 15 verifies per IP/minute. Additional all-endpoint network budget: 30/minute. These are pilot abuse budgets, not paid-plan quotas. They do not consume or modify AI usage.

Challenges expire after 5 minutes; cleanup runs every minute. A restart invalidates all challenges but keeps rate limits. Rate identifiers expire within 24 hours plus cleanup interval. SQLite secure deletion is enabled. Store only encrypted references; no claim of guaranteed physical erasure on SSDs or external snapshots. Exclude `private/order-state` from application backups. Keep encrypted credential backups and key backups separate with access control; losing the key requires reconnecting the pilot.

## Before any remote enablement

1. Obtain explicit deployment approval required by the handoff. Back up the existing release and verify source hashes before changes.
2. Have the owner enter the Shopify Client ID/secret through a hidden-input tool. Do not print, place on a command line, or paste them in chat. The prior read-only connection check did not save them. Resend already exists in `/etc/csb-resend.env`; reuse it server-side without redisplay.
3. Resolve the exact GetShopReply account by login email. Do not assume the first database merchant is the owner. `scripts/configure-order-pilot.js` accepts JSON on stdin (`merchantEmail`, `clientId`, `clientSecret`), verifies the development-store scope and stages an encrypted **disabled** configuration. It does not modify the existing database, `.env`, or billing.
4. Register the Shopify `app/uninstalled` webhook at `https://getshopreply.com/api/order-lookup/webhook`, using the app's normal signing secret. Verify subscription settings and signed delivery during enablement. Forged events must fail; valid uninstall disables persistent state and removes the encrypted config. Reinstallation requires a deliberate operator review/reset, not automatic reactivation. Other required public-app privacy webhooks are not implemented: this release must not be distributed as a public app.
5. Enable only the matched development merchant and the two listed HTTPS origins after configuration review, restart csb, and perform a real #1001 → email OTP → UNFULFILLED test. Verify ordinary chat, login, checkout and health again. Do not log the real order/email/OTP or trigger a real payment.
6. Test one code reuse, wrong email, expired code and closing the widget. Confirm no order details in conversation/escalation tables and no sensitive request bodies in proxy/application logs.

Rollback: remove/disable the encrypted configuration and restart csb, which hides the order entry point; restore prior source release if needed. Existing business tables are untouched. Never restore old challenge databases to regain access.

## Known limits

- Credentials for the real Shopify test app have not been entered into this implementation. Automated tests use mocked providers and synthetic data. Resend's separate setup test was received, but that is not proof of the full real-order OTP path.
- Default `read_orders` access is limited to recent orders (normally 60 days); masked/missing email, phone-only checkout, older orders, unsupported order-name formats and provider outages lead to the same generic fallback. The form supports common ASCII order names and requires exact spelling, including `#` when present.
- Upstream work is not durable: a process restart can abandon a request. The visitor requests a new code. Every process restart invalidates old codes.
- Only the first 20 fulfillments and first 10 tracking entries each are requested. The UI does not claim this is a live carrier feed. Multi-store OAuth, public-app protected-data approval, Shopify billing requirements and privacy webhooks need a separate release.
- Origin restrictions do not authenticate a visitor; the bound OTP challenge does. X-API-Key is the existing public embed identifier and is not treated as a secret.

## Validation

`npm test` runs the four existing suites plus `scripts/order-lookup-regression.js`. Browser verification additionally covers 1440/390/320 widths, request isolation from `/api/chat`, transient state cleanup, OTP flow and subsequent ordinary chat. No live Shopify credentials or real emails are used by automated tests.

Primary references:
- https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders
- https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment
- https://resend.com/docs/api-reference/emails/send-email
