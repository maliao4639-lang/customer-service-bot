# Release readiness — Shopify integration

This is a reviewable implementation, not an App Store-ready deployment. The owner completed CLI browser authentication, and the existing GetShopReply app was linked. Configuration and extension versions were uploaded without release. No main merge, production backend deployment, real charge or App Store submission was performed.

## Implemented and covered by local integration tests

- Managed Shopify installation with App Bridge ID-token validation and expiring encrypted offline tokens.
- Per-shop accounts and dashboard data isolation; no email-based account linking.
- App-data widget configuration, idle-loaded Theme App Embed and editor activation link.
- Fixed-price monthly/annual Shopify Billing API mutations; authoritative entitlement reconciliation and confirmed cancellation.
- Five raw-HMAC-verified, delivery-deduplicated lifecycle/privacy webhook topics.
- Durable encrypted privacy exports with dashboard download/completion; redaction and uninstall deletion.
- UTC calendar-month allowance reset; AI failure/escalation refunds; email handoff at quota exhaustion.
- Polaris App Home, manual policies/FAQs, preview, usage and handoff list.
- Repository-owned `/privacy` and `/terms`, setup/deployment guide, listing copy and screenshot plan.

## Must complete before public release

1. App linking and real client ID configuration are complete. Shopify CLI discovered development store `getshopreply-test-4k85f5hy.myshopify.com`. Official extension build passes. Real App Bridge/dashboard, theme and test billing acceptance passed on the initial integration revision. Recheck the reconciled revision and complete the real uninstall/lifecycle checks before release.
2. Exercise the full acceptance checklist in `SHOPIFY.md` using real Shopify APIs, theme Liquid, App Bridge, test billing and compliance notifications. Local mocks do not establish real API permissions, checkout replacement/proration behavior, extension compilation or App Store approval.
   Real App Home connection, encrypted offline-token storage, Admin GraphQL read and widget metafield publication pass. The owner selected public distribution. Real test billing passed monthly activation (21 USD), annual replacement (205 USD), cancellation and entitlement reconciliation back to Free. The saved development theme loads the widget; real DeepSeek storefront answers, unknown-order email collection, handoff persistence and allowance accounting pass using temporary fixtures that were subsequently removed. Remaining lifecycle/privacy delivery, the dashboard cancellation button and release checks are still open; see INTEGRATION-RESULTS.md for boundaries.
3. Owner confirmed Vultr hosting and DeepSeek AI. Console hash checks matched 17 key production files to the later local baseline, and the service is active. Shopify is now integrated with that baseline. Actual environment, data directory, region, production model and backups still need runtime confirmation. Use one process and persistent SQLite storage.
4. Operator Maliao, full address and support@getshopreply.com are now in the legal pages. Vultr/DeepSeek/Namecheap are disclosed; standalone Paddle/Resend disclosures are retained conditionally. Processing locations, backups and actual runtime behavior still require comparison before these pages replace the live notice.
5. Approve 90-day Shopify chat/handoff retention and 30-day privacy-export retention, and configure backup deletion accordingly. A customer-redaction notification conservatively removes all chat history for that shop; this is deliberate because anonymous chats cannot be mapped reliably to a Shopify customer ID.
6. Assign someone to process privacy exports and deliver them to verified requesters within the applicable deadline. The app stores exports and makes them downloadable; it does not send mail automatically.
7. Review existing standalone customers/Stripe subscriptions before any migration invitation. Automatic account linking, subscription credits and migration tooling are intentionally absent. Existing users must not be double charged; support-led migration requires verification of both identities.
8. Three 1600×900 local UI previews and a 1200×1200 proposed original icon have been prepared. Replace draft images with real-store captures before submission and record the English demo screencast. Six Lighthouse diagnostic runs are saved (pre-reconciliation revision); they do not replace the final, actual theme-toggle performance comparison. See PERFORMANCE.md.
9. Reconciliation restores Paddle, public guards, order lookup and missing pricing/signup/static pages. Five retained regression suites and 25 Shopify/provider-isolation tests pass. Still review runtime configuration, private files, database migration and rollback before approving deployment; code tests do not verify the production environment.
10. Owner reviews prices/plan differentiation and makes the final App Store submission. Pro currently provides the larger allowance only. No order lookup, content-import scope or extra Pro functionality was added.

## Corrections to the handoff assumptions

- Free needs no paid subscription object. Pro checkout uses Shopify confirmation; API cancellation uses explicit in-app confirmation and `appSubscriptionCancel`, rather than a nonexistent returned cancellation confirmation URL.
- Managed installation/token exchange is the embedded OAuth path used here, rather than the legacy authorization-code redirect flow.
- New public apps use expiring offline access tokens and stored refresh credentials.
- The base implementation reset allowance daily, despite monthly wording. The reset now compares UTC calendar months. Plan changes preserve current-month usage rather than granting an additional allowance.

## Verification limits

The regression suite uses an isolated database with mocked Shopify and AI responses. It covers valid/invalid JWTs, shop isolation, billing amount/interval/confirmation, encrypted credentials, expiry refresh, webhook retries/signatures, privacy requests/redaction, quota rollover/handoff and uninstall/reinstall races. Separate real API and development-store browser checks now verify billing, storefront chat, handoff and allowance accounting. Real lifecycle/privacy notifications, Lighthouse and final production legal review remain open.
