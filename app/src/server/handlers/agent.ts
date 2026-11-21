import { z } from 'zod';
import { route, bad, notFound, type Ctx } from '../core';

const R = { roles: ['delivery_agent'] };
async function agentId(c: Ctx) {
  const a = (await c.db.query('SELECT id FROM delivery_agents WHERE user_id = $1 AND is_active', [c.user!.id])).rows[0];
  if (!a) throw notFound('حساب المندوب غير فعال');
  return a.id as string;
}
async function assigned(c: Ctx, aid: string) {
  const o = (await c.db.query('SELECT id, status FROM orders WHERE id = $1 AND agent_id = $2', [c.params.id, aid])).rows[0];
  if (!o) throw notFound('الطلب غير موجود');   // لا يكشف طلبات غير مسندة
  return o;
}

route('GET', '/agent/orders', R, async (c) => {
  const aid = await agentId(c);
  const orders = (await c.db.query(`SELECT o.id, o.order_number, o.status, o.total, o.currency, o.recipient_name, o.recipient_phone, o.address_detail, o.delivery_notes, o.payment_method, o.created_at, o.delivered_at, g.name_ar AS governorate,
      COALESCE((SELECT json_agg(json_build_object('name', i.product_name, 'qty', i.quantity)) FROM order_items i WHERE i.order_id = o.id), '[]'::json) AS items
      FROM orders o JOIN governorates g ON g.id = o.governorate_id WHERE o.agent_id = $1 ORDER BY (o.status IN ('ready_for_delivery','out_for_delivery')) DESC, o.created_at DESC LIMIT 100`, [aid])).rows;
  const collected = (await c.db.query(`SELECT p.currency, sum(p.amount) AS total FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.agent_id = $1 AND p.status = 'collected' AND p.collected_by = $2 GROUP BY p.currency`, [aid, c.user!.id])).rows;
  return { orders, collected };
});

// المندوب يبدأ التوصيل ويؤكد التسليم فقط (باقي الحالات للموظفين)
route('POST', '/agent/orders/:id/status', R, async (c) => {
  const aid = await agentId(c); const o = await assigned(c, aid);
  const { to } = z.object({ to: z.enum(['out_for_delivery', 'delivered']) }).parse(c.body);
  if (to === 'out_for_delivery' && o.status !== 'ready_for_delivery') throw bad('الطلب غير جاهز للتوصيل بعد');
  if (to === 'delivered' && o.status !== 'out_for_delivery') throw bad('ابدأ التوصيل أولاً');
  await c.db.tx(t => t.query('SELECT change_order_status($1, $2::order_status, $3, $4)', [o.id, to, c.user!.id, to === 'delivered' ? 'تأكيد التسليم من المندوب' : 'بدء التوصيل']), { userId: c.user!.id });
  return { ok: true };
});

// تحديث الموقع: يقبله القيد في القاعدة فقط أثناء «خرج للتوصيل» وللمندوب المسند
route('POST', '/agent/orders/:id/location', R, async (c) => {
  const aid = await agentId(c); const o = await assigned(c, aid);
  const b = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() }).parse(c.body);
  await c.db.query('INSERT INTO agent_locations(order_id, agent_id, lat, lng, accuracy_m) VALUES ($1,$2,$3,$4,$5)', [o.id, aid, b.lat, b.lng, b.accuracy ?? null]);
  return { ok: true };
});
