# English App Store listing draft

Draft for owner review; do not submit until the development-store checks and release blockers are closed. Check current field limits in the actual submission form. Keep search terms natural rather than cramming every keyword into the name.

**Name:** GetShopReply ‑ AI FAQ Chatbot

**Subtitle:** Answer store questions and collect requests for your team.

**Introduction:** AI customer support for shipping, returns, and store FAQs.

**Search terms for relevant submission fields:** AI, FAQ, shipping, returns, customer support. Use natural descriptions; do not repeat search keywords in the subtitle.

**Description:**

Help shoppers get answers from your own store policies and FAQs. Add your shipping and returns information, enable ShopReply in your theme editor, and preview how your assistant responds. When a question needs your team, ShopReply collects the shopper’s question and email for follow-up.

Track your monthly AI reply allowance in the dashboard. If automated replies pause, shoppers can still leave a question and email for your team.

**Feature bullets:**

- Answer shipping, returns, and FAQ questions using your store’s information.
- Enable the chat widget through App embeds without editing theme files.
- Collect a question and email when a shopper needs human help.
- Preview answers and manage policies and FAQs inside Shopify admin.
- Track monthly AI replies and manage your plan through Shopify billing.

**Pricing fields:**

| Plan | Price | Allowance |
| --- | --- | --- |
| Free | USD 0 | 100 AI replies per UTC calendar month |
| Pro monthly | USD 21 every 30 days | 500 AI replies per UTC calendar month |
| Pro annual | USD 205 per year | 500 AI replies per UTC calendar month |

No automatic overages. Allowances reset on the first day of each UTC calendar month. Human handoff remains available after the allowance runs out. Taxes and Shopify billing adjustments may apply. Pro increases the reply allowance; it does not currently add separate features.

**Limits to disclose:** No order-status lookup or actions on orders, no automatic policy import, no automatic email follow-up. Answers are AI generated and should be tested. Typical installation may take about five minutes once policies are prepared; this is an estimate to validate, not a guaranteed claim for the listing.

## Listing assets to capture from a real development store

At least three screenshots at 1600×900, without real visitor information:

1. **Get started:** embedded dashboard showing the theme-editor activation link and sample shipping/returns policies. Caption: “Add your store policies and enable chat.”
2. **Storefront support:** real storefront chat answering a shipping question from the entered policy. Caption: “Help shoppers find answers from your store information.”
3. **Human handoff:** unsupported question, email collection and the matching dashboard handoff. Caption: “Keep questions that need your team in one place.”
4. Do not include plan prices, usage statistics or billing screenshots in listing images. Keep all numeric pricing information in the dedicated Pricing fields.

App icon: 1200×1200 PNG rendered from `assets/getshopreply-icon.svg` (proposed artwork for owner review). Local UI previews with sample data are drafts, not proof of development-store acceptance. Replace them with verified-store captures before submission. Record an English demo screencast: install → App Embed → save policies → grounded answer → handoff. Avoid unsupported accuracy, performance or setup-time claims.

## Submission fields to complete

- App URL: deployed HTTPS origin + `/shopify`.
- Privacy policy: `https://getshopreply.com/privacy` after this route is deployed and the text finalized.
- Terms: `https://getshopreply.com/terms` after deployment and final review.
- Support email: `support@getshopreply.com` (owner confirmed Namecheap Private Email is active).
- Operator: Maliao, individual developer. Address: No. 269 Chenghua North Road, Fengze District, Quanzhou, Fujian, China 362000.
- Review store/test access: owner supplies through Shopify's secure review form; no real credentials in source control.
- Providers confirmed by owner: Vultr hosting and DeepSeek AI. Shopify app billing and Namecheap support email are disclosed. SQLite is embedded database software. Actual model, hosting region, backup policy and any separate standalone Paddle/Resend flows still require server reconciliation.
- Languages: English only. Sales channel requirement: merchant must have Online Store. Distribution: regular public app, not Sales Channel.

## Reviewer test instructions draft

1. Install the app on the review store and open ShopReply inside Shopify admin. No separate account is required.
2. Save store name “Review Store”, shipping information “Orders ship within 2 business days. Delivery normally takes 3–5 business days.”, returns information “Unused items can be returned within 30 days.” and a sample FAQ.
3. Choose Open theme editor, enable ShopReply chat under App embeds, and save. Open the storefront.
4. Ask “How long does delivery take?” and compare the answer with the saved policy. Ask an order-specific question and submit a test email; confirm the question appears in Questions for your team.
5. Open Plan and usage. Choose a Pro plan and inspect Shopify’s confirmation page. For review, use the test-billing configuration supplied by the operator. Approve and refresh the app; verify Pro and a 500-reply allowance. Deny a separate checkout and verify the current plan remains unchanged.
6. Cancel Pro through the app’s explicit confirmation. Verify a Free allowance and unchanged used reply count.
7. Uninstall and confirm the storefront widget no longer works. The operator can demonstrate compliance webhooks and deletion using Shopify's supported test mechanisms.

Owner must confirm current App Store review requirements and account/registration charges directly in Shopify. Final submission is performed by the owner.
