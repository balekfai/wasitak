import { z } from 'zod';
import { route, notFound, forbidden, bad, type Ctx } from '../core.js';

const orderZ = z.object({
  items: z.array(z.object({ variant_id: z.string().uuid(), qty: z.number().int().min(1).max(99) })).min(1).max(50),
  governorate_id: z.string().uuid(), area_id: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(100), phone: z.string().trim().min(7).max(20),
  address: z.string().trim().min(5).max(400), notes: z.string().max(400).nullish(),
  payment_method: z.string().min(2).max(30), idempotency_key: z.string().min(8).max(80),
});

route('POST', '/orders', { roles: ['buyer'] }, async (c) => {
  const b = orderZ.parse(c.body);
  const id = await c.db.tx(async t => (await t.query('SELECT create_order($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10) AS id',
    [c.user!.id, JSON.stringify(b.items), b.governorate_id, b.area_id || null, b.name, b.phone.replace(/[\s\-()]/g, ''), b.address, b.notes || null, b.payment_method, b.idempotency_key])).rows[0].id,
    { userId: c.user!.id });
  const o = (await c.db.query('SELECT id, order_number, total, currency FROM orders WHERE id = $1', [id])).rows[0];
  return { order: o };
});

async function ownOrder(c: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('الطلب غير موجود');
  const o = (await c.db.query(`SELECT o.*, g.name_ar AS governorate FROM orders o JOIN customers cu ON cu.id = o.customer_id
      JOIN governorates g ON g.id = o.governorate_id WHERE o.id = $1 AND cu.user_id = $2`, [id, c.user!.id])).rows[0];
  if (!o) throw notFound('الطلب غير موجود');
  return o;
}

route('GET', '/orders', { roles: ['buyer'] }, async (c) => ({
  orders: (await c.db.query(`SELECT o.id, o.order_number, o.status, o.total, o.currency, o.created_at,
      (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) AS items_count
      FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE cu.user_id = $1 ORDER BY o.created_at DESC LIMIT 100`, [c.user!.id])).rows,
}));

route('GET', '/orders/:id', { roles: ['buyer'] }, async (c) => {
  const o = await ownOrder(c, c.params.id);
  // المشتري يرى أسعاره هو فقط: لا merchant_unit_price ولا markup
  const items = (await c.db.query('SELECT product_id, product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = $1', [o.id])).rows;
  const history = (await c.db.query('SELECT to_status, created_at FROM order_status_history WHERE order_id = $1 ORDER BY id', [o.id])).rows;
  const agent = o.agent_id ? (await c.db.query('SELECT u.full_name, u.phone FROM delivery_agents a JOIN users u ON u.id = a.user_id WHERE a.id = $1', [o.agent_id])).rows[0] : null;
  const { agent_id, idempotency_key, customer_id, is_demo, ...safe } = o;
  return { order: safe, items, history, agent };
});

route('POST', '/orders/:id/cancel', { roles: ['buyer'] }, async (c) => {
  const o = await ownOrder(c, c.params.id);
  if (!['new', 'pending_confirmation', 'confirmed'].includes(o.status)) throw bad('لا يمكن إلغاء الطلب في حالته الحالية');
  await c.db.tx(t => t.query(`SELECT change_order_status($1, 'cancelled', $2, 'إلغاء من المشتري')`, [o.id, c.user!.id]), { userId: c.user!.id });
  return { ok: true };
});

// تتبع آخر موقع للمندوب: للمشتري صاحب الطلب فقط وأثناء التوصيل النشط
route('GET', '/orders/:id/tracking', { roles: ['buyer'] }, async (c) => {
  const o = await ownOrder(c, c.params.id);
  if (o.status !== 'out_for_delivery') return { active: false, status: o.status };
  const loc = (await c.db.query('SELECT lat, lng, recorded_at FROM agent_locations WHERE order_id = $1 ORDER BY id DESC LIMIT 1', [o.id])).rows[0];
  return { active: true, status: o.status, location: loc || null };
});
