# English App Store listing draft

Draft for owner review; do not submit until the development-store checks and release blockers are closed. Check current field limits in the actual submission form. Keep search terms natural rather than cramming every keyword into the name.

**Name:** ShopReply: AI FAQ Support

**Subtitle / introduction:** AI customer support for shipping, returns, and store FAQs.

**Description:**

Help shoppers get answers from your own store policies and FAQs. Add your shipping and returns information, enable ShopReply in your theme editor, and preview how your assistant responds. When a question needs your team, ShopReply collects the shopper’s question and email for follow-up.

Start free, then choose a fixed-price Pro plan when you need more replies. There are no usage-overage charges. If you reach your monthly allowance, shoppers can still leave a question and email.

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
4. Optional **Usage and billing:** real Free/Pro plans and usage inside admin. Caption: “Fixed prices with clear monthly allowances.”

App icon: 1200×1200 PNG using owner-approved artwork. No icon or review screenshot is fabricated by this code change. Optional short demo: install → App Embed → save policies → grounded answer → handoff. Avoid unsupported AI accuracy, Lighthouse or setup-time claims.

## Submission fields to complete

- App URL: deployed HTTPS origin + `/shopify`.
- Privacy policy: `https://getshopreply.com/privacy` after this route is deployed and the text finalized.
- Terms: `https://getshopreply.com/terms` after deployment and final review.
- Support email: provision and verify a domain address such as `support@getshopreply.com`. Current repository pages use the existing `maliao4639@gmail.com`; do not claim the domain mailbox exists yet.
- Support/review contacts, verified operator name and required address/jurisdiction details: owner supplies.
- Review store/test access: owner supplies through Shopify's secure review form; no real credentials in source control.
- AI provider name, hosting/processing locations, backup retention and applicable disclosures: owner confirms and updates policy.

## Reviewer test instructions draft

1. Install the app on the review store and open ShopReply inside Shopify admin. No separate account is required.
2. Save store name “Review Store”, shipping information “Orders ship within 2 business days. Delivery normally takes 3–5 business days.”, returns information “Unused items can be returned within 30 days.” and a sample FAQ.
3. Choose Open theme editor, enable ShopReply chat under App embeds, and save. Open the storefront.
4. Ask “How long does delivery take?” and compare the answer with the saved policy. Ask an order-specific question and submit a test email; confirm the question appears in Questions for your team.
5. Open Plan and usage. Choose a Pro plan and inspect Shopify’s confirmation page. For review, use the test-billing configuration supplied by the operator. Approve and refresh the app; verify Pro and a 500-reply allowance. Deny a separate checkout and verify the current plan remains unchanged.
6. Cancel Pro through the app’s explicit confirmation. Verify a Free allowance and unchanged used reply count.
7. Uninstall and confirm the storefront widget no longer works. The operator can demonstrate compliance webhooks and deletion using Shopify's supported test mechanisms.

Owner must confirm current App Store review requirements and account/registration charges directly in Shopify. Final submission is performed by the owner.
