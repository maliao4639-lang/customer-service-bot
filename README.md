# Customer Service Bot (v0.1)

A tiny embeddable AI customer-service chatbot for small overseas independent e-commerce merchants (Shopify / WooCommerce / any HTML site).

**Scope (very deliberately small for v0.1):**
- Visitors ask questions in a chat bubble on the merchant's site.
- The bot uses the merchant's store info + FAQ as the only source of truth.
- If the bot can't answer, it captures the visitor's email and question and the merchant sees it in the admin console.
- **No cart, no checkout, no payment, no order placement.** This bot only answers questions.

---

## What you need on your computer

You only need **one** thing already installed:

- **Node.js 22 or newer** (this project uses the built-in `node:sqlite`, so no other databases needed).

To check:
```
node --version
```
Anything `v22.0.0` or higher is fine.

You also need an **LLM API key** for whatever provider you want to use. Any service that speaks the OpenAI Chat Completions API works — OpenAI, DeepSeek, Groq, OpenRouter, Together, etc.

---

## Get it running locally (5 steps, plain language)

> Everything below assumes your terminal is pointed at the project folder: `D:\ai-customer-service-bot` on Windows, or wherever you put it on Mac/Linux.

### 1) Install dependencies

```
npm install
```

That's it. No Python, no native compilers, no other database.

### 2) Add your LLM API key

Open the file `.env` in a text editor. Find this line:

```
LLM_API_KEY=sk-replace-me
```

Replace `sk-replace-me` with the API key from your LLM provider. If you're using a non-OpenAI provider, also update `LLM_BASE_URL` and `LLM_MODEL`.

Save the file.

### 3) Seed a demo merchant (optional but recommended)

```
npm run seed
```

This creates a demo account so you can immediately poke around without signing up:

- **Email:** `demo@local`
- **Password:** `demo1234`

It also prints a working **embed snippet** (the `<script>` tag you would paste into a real storefront). Copy it — you'll need it in step 5.

### 4) Start the server

```
npm start
```

You should see:

```
AI customer-service bot listening on http://localhost:3000
```

Leave this window open. The server is now running.

### 5) Try it out

Open your browser to:

- **Demo page (chat widget):** http://localhost:3000/
- **Merchant console:** http://localhost:3000/admin (sign in with the seed credentials, or sign up fresh)

On the demo page you should see a blue chat bubble in the bottom-right corner. Click it and ask things like:

- "How long does shipping to the US take?" → answers from your shipping info.
- "What's your return policy?" → answers from your FAQ.
- "Can I change my order to express shipping?" → bot escalates, asks for an email, and the question appears in the admin console under **Questions handed off to you**.

---

## How a merchant uses this on a real store

1. Merchant signs up at `/admin`, fills in store info + FAQs.
2. The console shows them an **embed snippet** like:

   ```
   <script src="https://your-host/embed.js" data-api-key="csb_…" defer></script>
   ```

3. Merchant pastes that one line into their storefront HTML:
   - **Shopify:** Online Store → Themes → Edit code → `theme.liquid` → before `</body>`.
   - **WooCommerce:** Appearance → Theme File Editor → `footer.php` → before `<?php wp_footer(); ?>`.
   - **Any HTML site:** just before `</body>`.

4. The chat bubble appears on every page.

That's it. No DNS changes, no Shopify app review.

---

## Files at a glance

```
ai-customer-service-bot/
├── server.js                ← Express app, all routes
├── db.js                    ← SQLite schema + a few helpers
├── llm.js                   ← OpenAI-compatible chat call + escalate logic
├── scripts/seed.js          ← Creates a demo merchant
├── public/
│   ├── demo.html            ← What visitors see when previewing locally
│   ├── admin/index.html     ← The merchant console
│   ├── widget/embed.js      ← The one <script> merchants paste
│   └── static/
│       ├── admin.css / admin.js
│       └── widget.css
├── data/app.db              ← Auto-created SQLite database
├── .env                     ← Local config, including your LLM key
└── .env.example             ← Template for .env
```

---

## How answers are generated (in plain English)

Every time a visitor sends a message, the server builds a prompt that looks like:

```
You are the AI customer service assistant for "Demo Store".

STORE INFORMATION
Return policy: ...
Shipping info: ...

KNOWN FAQ
Q: Do you ship internationally?
A: Yes, ...
…

YOUR JOB
- Answer visitor questions using the store information and FAQ above as your ONLY source of truth.
- If the visitor asks something you cannot answer, reply with EXACTLY the word "ESCALATE" and nothing else.
- Never make up policies, prices, or order details.
- Do not offer to take payment or place orders.
```

The bot is told that if it doesn't know the answer, it must answer with the single word `ESCALATE`. The server then asks the visitor for an email and saves the question + email into a `escalations` table, which is what the merchant sees in the admin console.

This is the simplest possible "grounding" approach: the model literally cannot make things up about your policies because it can only quote from what you typed.

---

## What this v0.1 does NOT do (and how to add it later)

- ❌ No order lookup / "where is my order?" — needs a Shopify/Woo API integration.
- ❌ No multi-language auto-detect — replies are English only.
- ❌ No analytics / dashboard charts.
- ❌ No email-out from the bot (the merchant has to check the console).
- ❌ No team accounts / roles.

When you're ready to ship, the typical next steps are: deploy the Node app to a small VPS / Railway / Fly.io, change `SESSION_SECRET` and `PUBLIC_BASE_URL`, point a domain at it, and you're done.

---

## Troubleshooting checklist

- *Server won't start: "missing LLM_API_KEY"* → fill in `.env`.
- *Bot always escalates* → your store info and FAQ are empty, or the LLM is being too cautious. Add more FAQ content.
- *Embed script 404* → the merchant needs `PUBLIC_BASE_URL` to point at the real public URL (not `localhost`) before copying it.
- *Admin console won't let me log in* → cookies might be blocked. Try a normal window (not incognito) and make sure your browser accepts cookies for `localhost`.