'use strict';

const { db } = require('./db');

const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

function systemPromptFor(merchant, faqs) {
  const faqBlock = faqs.length
    ? faqs.map((f, i) => `Q${i + 1}: ${f.question}\nA${i + 1}: ${f.answer}`).join('\n\n')
    : '(No FAQs configured yet.)';

  return `You are the AI customer service assistant for "${merchant.brand_name}", a small online store.

====================
STORE INFORMATION
====================
Return policy:
${merchant.return_policy || '(not provided)'}

Shipping / delivery time:
${merchant.shipping_info || '(not provided)'}

Other store info:
${merchant.extra_info || '(not provided)'}

====================
KNOWN FAQ
====================
${faqBlock}

====================
YOUR JOB
====================
- Answer visitor questions using the store information and FAQ above as your ONLY source of truth.
- Be friendly, concise, and helpful. Reply in English.
- NEVER make up policies, shipping times, prices, or order details that are not in the source above.
- If the visitor asks something you cannot answer from the store info / FAQ (e.g. order-specific status, custom requests, anything outside scope), or if the question is unclear, you MUST respond with EXACTLY the word "ESCALATE" and nothing else.
- Do not promise order changes, refunds, or any action on the merchant's behalf. The merchant will follow up by email if you escalate.
- Do NOT offer to add items to a cart, take payment, or place orders. This bot is for questions only.`.trim();
}

/**
 * Calls the chat-completions API and returns one of:
 *   - { ok: true, content: "..." }  a real answer
 *   - { ok: false, escalate: true } bot decided to hand off to a human
 *   - { ok: false, error: "..." }   upstream / network failure
 */
async function generateAnswer({ merchant, faqs, history, visitorMessage }) {
  if (!LLM_API_KEY) {
    return { ok: false, error: 'Server is missing LLM_API_KEY. Set it in .env.' };
  }

  const messages = [
    { role: 'system', content: systemPromptFor(merchant, faqs) },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: visitorMessage },
  ];

  let res;
  try {
    res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 400,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error calling LLM: ${err.message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `LLM returned ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim() || '';

  if (content.toUpperCase() === 'ESCALATE') {
    return { ok: false, escalate: true };
  }

  return { ok: true, content };
}

function loadFaqs(merchantId) {
  return db
    .prepare('SELECT id, question, answer FROM faqs WHERE merchant_id = ? ORDER BY position ASC, id ASC')
    .all(merchantId);
}

module.exports = { generateAnswer, loadFaqs };