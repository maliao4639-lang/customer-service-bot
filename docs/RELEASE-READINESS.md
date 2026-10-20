# Release readiness — Shopify integration

This is a reviewable implementation, not an App Store-ready deployment. No production deployment, charge, account registration or App Store submission was performed.

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

1. Register/link the actual Shopify app and development store; fill client ID and HTTPS URLs in TOML and environment. `shopify app dev` / extension build / real installation are not verified without those owner-controlled resources.
2. Exercise the full acceptance checklist in `SHOPIFY.md` using real Shopify APIs, theme Liquid, App Bridge, test billing and compliance notifications. Local mocks do not establish real API permissions, checkout replacement/proration behavior, extension compilation or App Store approval.
3. Confirm the production hosting setup. The repository has no deployment manifest, hosted database access or secret manager configuration. Use one process and a persistent SQLite volume; distributed workers need shared locking/session storage changes.
4. Finalize operator identity, domain support mailbox, actual AI/hosting providers, processing locations, backup retention, lawful transfer arrangements and required privacy disclosures. Legal routes are implementation-based drafts for the operator to review. They must not replace a more complete live policy without comparison.
5. Approve 90-day Shopify chat/handoff retention and 30-day privacy-export retention, and configure backup deletion accordingly. A customer-redaction notification conservatively removes all chat history for that shop; this is deliberate because anonymous chats cannot be mapped reliably to a Shopify customer ID.
6. Assign someone to process privacy exports and deliver them to verified requesters within the applicable deadline. The app stores exports and makes them downloadable; it does not send mail automatically.
7. Review existing standalone customers/Stripe subscriptions before any migration invitation. Automatic account linking, subscription credits and migration tooling are intentionally absent. Existing users must not be double charged; support-led migration requires verification of both identities.
8. Capture actual 1600×900 screenshots, approve a 1200×1200 app icon and measure storefront Lighthouse performance before/after enabling the embed. No generated mockup should be passed off as review evidence.
9. Reconcile the separately maintained live homepage/legal pages with repository files. The current default branch lacks `public/pricing.html` and `public/signup.html` despite routes referring to them; this pre-existing gap was not repaired by copying unknown production content. Do not overwrite separately maintained pages during deployment.
10. Owner reviews prices/plan differentiation and makes the final App Store submission. Pro currently provides the larger allowance only. No order lookup, content-import scope or extra Pro functionality was added.

## Corrections to the handoff assumptions

- Free needs no paid subscription object. Pro checkout uses Shopify confirmation; API cancellation uses explicit in-app confirmation and `appSubscriptionCancel`, rather than a nonexistent returned cancellation confirmation URL.
- Managed installation/token exchange is the embedded OAuth path used here, rather than the legacy authorization-code redirect flow.
- New public apps use expiring offline access tokens and stored refresh credentials.
- The base implementation reset allowance daily, despite monthly wording. The reset now compares UTC calendar months. Plan changes preserve current-month usage rather than granting an additional allowance.

## Verification limits

Automated checks run in an isolated database, with Shopify and AI responses replaced by local fixtures. They cover valid/invalid JWTs, shop isolation, billing amount/interval/confirmation, encrypted credentials, expiry refresh, webhook retries/signatures, privacy requests/redaction, quota rollover/handoff and uninstall/reinstall races. Real Shopify end-to-end, Lighthouse and final production legal review remain open.
