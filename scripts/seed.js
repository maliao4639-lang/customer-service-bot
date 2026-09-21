'use strict';

/**
 * Seeds a demo merchant so you can poke at the system without going through signup.
 * Usage:
 *   node scripts/seed.js                          # creates demo@local / demo1234
 *   node scripts/seed.js you@example.com hunter2  # creates a custom merchant
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, randomToken } = require('../db');

const email = process.argv[2] || 'demo@local';
const password = process.argv[3] || 'demo1234';

const existing = db.prepare('SELECT id FROM merchants WHERE email = ?').get(email.toLowerCase());
if (existing) {
  console.log(`Merchant ${email} already exists (id=${existing.id}). No changes.`);
  process.exit(0);
}

const hash = bcrypt.hashSync(password, 10);
const apiKey = 'csb_' + randomToken(16);
const info = db
  .prepare(
    `INSERT INTO merchants (email, password_hash, brand_name, return_policy, shipping_info, extra_info, api_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  .run(
    email.toLowerCase(),
    hash,
    'Demo Store',
    'We accept returns within 30 days of delivery. Items must be unworn and in original packaging. Buyer pays return shipping; we refund the item cost within 5 business days of receiving the return.',
    'Orders ship within 1–2 business days. US delivery takes 5–8 business days. EU delivery takes 7–12 business days. Tracking numbers are emailed once the order ships.',
    'Support hours: Mon–Fri 9am–6pm UTC. Email: support@example.com.',
    apiKey
  );

const merchantId = info.lastInsertRowid;
const sampleFaqs = [
  ['Do you ship internationally?',
   'Yes — we ship to the US, EU, UK, Canada, and Australia. Delivery times vary by region; US orders usually arrive in 5–8 business days.'],
  ['Can I change or cancel my order after I place it?',
   'Email us within 12 hours of placing the order and we will do our best to help. After that the order is locked for shipment.'],
  ['Do you offer exchanges?',
   'We do not offer direct exchanges. The fastest path is to return the original item for a refund and place a new order.'],
  ['Are your products true to size?',
   'Our items run true to size. Each product page has a size chart — measure a similar item you own and compare.'],
];

const insertFaq = db.prepare(
  'INSERT INTO faqs (merchant_id, question, answer, position) VALUES (?, ?, ?, ?)'
);
sampleFaqs.forEach((row, i) => insertFaq.run(merchantId, row[0], row[1], i));

console.log('Seeded merchant:');
console.log('  email:    ', email);
console.log('  password: ', password);
console.log('  api_key:  ', apiKey);
console.log('  id:       ', merchantId);
console.log(`Embed snippet:\n  <script src="http://localhost:${process.env.PORT || 3000}/embed.js" data-api-key="${apiKey}" defer></script>`);