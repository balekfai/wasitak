import { z } from 'zod';
import crypto from 'node:crypto';
import { route, HttpError, bad, notFound, type Ctx } from '../core.js';
import { saveImage } from '../storage.js';

async function me(c: Ctx) {
  const m = (await c.db.query('SELECT id, shop_name, status, rejection_reason, default_currency FROM merchants WHERE user_id = $1', [c.user!.id])).rows[0];
  if (!m) throw notFound('حساب التاجر غير موجود');
  return m;
}
async function approvedMe(c: Ctx) {
  const m = await me(c);
  if (m.status !== 'approved') throw new HttpError(403, 'حساب التاجر بانتظار موافقة الإدارة أو غير فعال');
  return m;
}
const R = { roles: ['merchant'] };

route('GET', '/merchant/me', R, async (c) => ({ merchant: await me(c) }));

route('GET', '/merchant/dashboard', R, async (c) => {
  const m = await me(c);
  const [prod, orders, low, bal] = await Promise.all([
    c.db.query(`SELECT status, count(*)::int AS n FROM products WHERE merchant_id = $1 GROUP BY status`, [m.id]),
    c.db.query(`SELECT o.status, count(DISTINCT o.id)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.merchant_id = $1 GROUP BY o.status`, [m.id]),
    c.db.query(`SELECT count(*)::int AS n FROM inventory i JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id WHERE p.merchant_id = $1 AND i.quantity <= 3 AND v.is_active`, [m.id]),
    c.db.query('SELECT currency, balance, total_sales_credit, total_paid FROM merchant_balances WHERE merchant_id = $1', [m.id]),
  ]);
  return { merchant: m, products: prod.rows, orders: orders.rows, low_stock: low.rows[0].n, balances: bal.rows };
});

route('GET', '/merchant/products', R, async (c) => {
  const m = await me(c);
  const rows = (await c.db.query(`SELECT p.id, p.name_ar, p.description, p.merchant_price, p.currency, p.status, p.is_available, p.review_notes, p.category_id, cat.name_ar AS category,
      (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort_order, created_at LIMIT 1) AS image_url,
      COALESCE((SELECT json_agg(json_build_object('id', v.id, 'options', v.options, 'price_delta', v.price_delta, 'quantity', COALESCE(i.quantity,0)) ORDER BY v.created_at)
                FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id WHERE v.product_id = p.id AND v.is_active), '[]'::json) AS variants,
      COALESCE((SELECT json_agg(url ORDER BY sort_order, created_at) FROM product_images WHERE product_id = p.id), '[]'::json) AS images
      FROM products p JOIN categories cat ON cat.id = p.category_id WHERE p.merchant_id = $1 ORDER BY p.created_at DESC`, [m.id])).rows;
  return { products: rows };
});

const imgUrl = z.string().max(500).regex(/^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s]+)$/, 'رابط صورة غير صحيح');
const variantZ = z.object({ options: z.record(z.string().max(40), z.string().max(60)).default({}), quantity: z.number().int().min(0).max(1_000_000), price_delta: z.number().min(0).max(1e9).default(0) });
const productZ = z.object({
  name_ar: z.string().trim().min(2).max(150), description: z.string().max(4000).default(''),
  category_id: z.string().uuid(), merchant_price: z.number().positive().max(1e10), currency: z.string().length(3),
  details: z.record(z.string(), z.any()).default({}), images: z.array(imgUrl).max(8).default([]),
  variants: z.array(variantZ).min(1).max(40).default([{ options: {}, quantity: 0, price_delta: 0 }]),
});

route('POST', '/merchant/products', R, async (c) => {
  const m = await approvedMe(c);
  const b = productZ.parse(c.body);
  const id = await c.db.tx(async t => {
    const cat = (await t.query('SELECT id FROM categories WHERE id = $1 AND is_active', [b.category_id])).rows[0];
    if (!cat) throw bad('القسم غير صحيح');
    const cur = (await t.query('SELECT decimals FROM currencies WHERE code = $1 AND is_active', [b.currency])).rows[0];
    if (!cur) throw bad('العملة غير متاحة');
    const p = (await t.query(`INSERT INTO products(merchant_id, category_id, name_ar, description, details, merchant_price, currency, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review') RETURNING id`, [m.id, b.category_id, b.name_ar, b.description, b.details, b.merchant_price, b.currency])).rows[0];
    for (const [i, u] of b.images.entries()) await t.query('INSERT INTO product_images(product_id, url, sort_order) VALUES ($1,$2,$3)', [p.id, u, i]);
    await t.query(`SELECT set_config('app.inv_reason', 'initial', true)`);
    for (const v of b.variants) {
      const vr = (await t.query('INSERT INTO product_variants(product_id, options, price_delta) VALUES ($1,$2,$3) RETURNING id', [p.id, v.options, v.price_delta])).rows[0];
      await t.query('INSERT INTO inventory(variant_id, quantity) VALUES ($1,$2)', [vr.id, v.quantity]);
    }
    return p.id as string;
  }, { userId: c.user!.id });
  return { id };
});

async function ownProduct(c: Ctx, merchantId: string) {
  const p = (await c.db.query('SELECT id, status, merchant_price, currency FROM products WHERE id = $1 AND merchant_id = $2', [c.params.id, merchantId])).rows[0];
  if (!p) throw notFound('المنتج غير موجود');     // 404 لا 403: لا نكشف وجود منتجات تاجر آخر
  return p;
}

const patchZ = z.object({
  name_ar: z.string().trim().min(2).max(150).optional(), description: z.string().max(4000).optional(),
  merchant_price: z.number().positive().max(1e10).optional(), category_id: z.string().uuid().optional(),
  is_available: z.boolean().optional(), images: z.array(imgUrl).max(8).optional(),
});
route('PATCH', '/merchant/products/:id', R, async (c) => {
  const m = await me(c); const p = await ownProduct(c, m.id); const b = patchZ.parse(c.body);
  const contentChanged = ['name_ar', 'description', 'merchant_price', 'category_id', 'images'].some(k => (b as any)[k] !== undefined);
  await c.db.tx(async t => {
    const sets: string[] = []; const vals: any[] = [p.id];
    for (const k of ['name_ar', 'description', 'merchant_price', 'category_id', 'is_available'] as const)
      if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
    // أي تعديل في المحتوى أو السعر يعيد المنتج للمراجعة ويخفيه حتى الاعتماد
    if (contentChanged && ['approved', 'rejected'].includes(p.status)) sets.push(`status = 'pending_review'`);
    if (sets.length) await t.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (b.images) {
      await t.query('DELETE FROM product_images WHERE product_id = $1', [p.id]);
      for (const [i, u] of b.images.entries()) await t.query('INSERT INTO product_images(product_id, url, sort_order) VALUES ($1,$2,$3)', [p.id, u, i]);
    }
  }, { userId: c.user!.id });
  return { ok: true, sent_to_review: contentChanged && ['approved', 'rejected'].includes(p.status) };
});

route('PUT', '/merchant/products/:id/stock', R, async (c) => {
  const m = await me(c); const p = await ownProduct(c, m.id);
  const { variant_id, quantity } = z.object({ variant_id: z.string().uuid(), quantity: z.number().int().min(0).max(1_000_000) }).parse(c.body);
  await c.db.tx(async t => {
    await t.query(`SELECT set_config('app.inv_reason', 'merchant_adjust', true)`);
    const r = await t.query('UPDATE inventory SET quantity = $1 WHERE variant_id = $2 AND variant_id IN (SELECT id FROM product_variants WHERE product_id = $3)', [quantity, variant_id, p.id]);
    if (!r.rowCount) throw notFound('الخيار غير موجود');
  }, { userId: c.user!.id });
  return { ok: true };
});

// طلبات التاجر: بنوده فقط، وبلا هاتف المشتري، وبسعر التاجر لا سعر البيع
route('GET', '/merchant/orders', R, async (c) => {
  const m = await me(c);
  const rows = (await c.db.query(`SELECT o.id, o.order_number, o.status, o.created_at, g.name_ar AS governorate, split_part(o.recipient_name, ' ', 1) AS recipient,
      json_agg(json_build_object('name', i.product_name, 'qty', i.quantity, 'unit', i.merchant_unit_price, 'currency', i.merchant_currency)) AS items,
      sum(i.merchant_unit_price * i.quantity) AS merchant_total
      FROM order_items i JOIN orders o ON o.id = i.order_id JOIN governorates g ON g.id = o.governorate_id
      WHERE i.merchant_id = $1 GROUP BY o.id, g.name_ar ORDER BY o.created_at DESC LIMIT 200`, [m.id])).rows;
  return { orders: rows };
});

route('GET', '/merchant/finance', R, async (c) => {
  const m = await me(c);
  const [bal, tx, vouchers] = await Promise.all([
    c.db.query('SELECT currency, balance, total_sales_credit, total_paid FROM merchant_balances WHERE merchant_id = $1', [m.id]),
    c.db.query(`SELECT id, kind, amount, currency, order_id, note, created_at FROM merchant_transactions WHERE merchant_id = $1 ORDER BY id DESC LIMIT 100`, [m.id]),
    c.db.query(`SELECT pv.id, pv.voucher_number, pv.amount, pv.currency, pv.method, pv.reason, pv.status, pv.created_at, rv.voucher_number AS receipt_number
      FROM payment_vouchers pv LEFT JOIN receipt_vouchers rv ON rv.payment_voucher_id = pv.id WHERE pv.merchant_id = $1 ORDER BY pv.created_at DESC LIMIT 100`, [m.id]),
  ]);
  return { balances: bal.rows, transactions: tx.rows, vouchers: vouchers.rows };
});

route('POST', '/merchant/vouchers/:id/confirm', R, async (c) => {
  const id = await c.db.tx(async t => (await t.query('SELECT confirm_receipt($1,$2) AS id', [c.params.id, c.user!.id])).rows[0].id, { userId: c.user!.id });
  return { receipt_id: id };
});

// رفع صورة: جسم ثنائي خام، تحقق من النوع الحقيقي والحجم
route('POST', '/merchant/uploads', R, async (c) => {
  await approvedMe(c);
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) throw bad('لا يوجد ملف');
  if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'الصورة أكبر من 5 ميغابايت');
  const url = await saveImage(buf, crypto.randomBytes(12).toString('hex'));
  return { url };
}, { raw: true });

// حالة وحدة «وسيطك الذكي» للتاجر: رسالة تسويقية فقط ما دامت الوحدة معطلة
route('GET', '/merchant/smart', R, async (c) => {
  const mod = (await c.db.query(`SELECT status, readiness FROM system_modules WHERE code = 'smart_wasitak'`)).rows[0];
  return { enabled: mod?.status === 'enabled', readiness: mod?.readiness || 'not_implemented' };
});
