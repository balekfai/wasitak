import { z } from 'zod';
import { route, HttpError, bad, notFound, forbidden, hashPassword, normalizePhone, type Ctx } from '../core';

const A = { perm: 'admin.access' };
const uuid = z.string().uuid();
const audit = (c: Ctx | any, t: any, action: string, entity: string, id: string, data: any) =>
  t.query('INSERT INTO audit_logs(actor_id, action, entity, entity_id, new_data) VALUES ($1,$2,$3,$4,$5)', [c.user.id, action, entity, id, data]);

// ================= لوحة المعلومات =================
route('GET', '/admin/stats', A, async (c) => {
  const q = (s: string, p: any[] = []) => c.db.query(s, p).then(r => r.rows);
  const [orders, counts] = await Promise.all([
    q(`SELECT status, count(*)::int AS n FROM orders WHERE NOT is_demo GROUP BY status`),
    q(`SELECT (SELECT count(*)::int FROM merchants m JOIN users u ON u.id = m.user_id WHERE NOT u.is_demo) AS merchants,
              (SELECT count(*)::int FROM merchants WHERE status = 'pending') AS merchants_pending,
              (SELECT count(*)::int FROM customers cu JOIN users u ON u.id = cu.user_id WHERE NOT u.is_demo) AS customers,
              (SELECT count(*)::int FROM products) AS products,
              (SELECT count(*)::int FROM products WHERE status = 'pending_review') AS products_pending,
              (SELECT count(*)::int FROM advertisements WHERE status = 'active') AS ads_active,
              (SELECT count(*)::int FROM complaints WHERE status IN ('open','in_progress')) AS complaints_open,
              (SELECT count(*)::int FROM returns WHERE status = 'requested') AS returns_open`),
  ]);
  const out: any = { orders, ...counts[0] };
  if (await c.perm('accounting.view')) {
    out.finance = {
      sales: await q(`SELECT currency, sum(total)::numeric AS total FROM orders WHERE status IN ('delivered','return_requested','return_processing','return_completed','refunded') AND NOT is_demo GROUP BY currency`),
      platform: await q(`SELECT kind, currency, sum(amount) AS total FROM real_platform_ledger GROUP BY kind, currency`),
      merchants_due: await q(`SELECT currency, sum(balance) AS total FROM (SELECT mt.currency, sum(mt.amount) AS balance FROM real_merchant_transactions mt GROUP BY mt.merchant_id, mt.currency) x GROUP BY currency`),
    };
  }
  return out;
});

// ================= التجار =================
route('GET', '/admin/merchants', { perm: 'merchants.review' }, async (c) => {
  const st = c.url.searchParams.get('status');
  return { merchants: (await c.db.query(`SELECT m.id, m.shop_name, m.status, m.created_at, m.rejection_reason, u.full_name, u.phone, u.is_demo, g.name_ar AS governorate,
      (SELECT count(*)::int FROM products p WHERE p.merchant_id = m.id) AS products
      FROM merchants m JOIN users u ON u.id = m.user_id LEFT JOIN governorates g ON g.id = m.governorate_id
      WHERE ($1::text IS NULL OR m.status::text = $1) ORDER BY m.created_at DESC LIMIT 300`, [st])).rows };
});
route('POST', '/admin/merchants/:id/decision', { perm: 'merchants.review' }, async (c) => {
  const b = z.object({ decision: z.enum(['approve', 'reject', 'suspend', 'reactivate']), reason: z.string().max(500).optional() }).parse(c.body);
  if (['reject', 'suspend'].includes(b.decision) && !b.reason) throw bad('اكتب السبب');
  const status = ({ approve: 'approved', reject: 'rejected', suspend: 'suspended', reactivate: 'approved' } as any)[b.decision];
  const r = await c.db.tx(t => t.query(`UPDATE merchants SET status = $2, reviewed_by = $3, reviewed_at = now(), rejection_reason = $4 WHERE id = $1`,
    [c.params.id, status, c.user!.id, b.reason || null]), { userId: c.user!.id });
  if (!r.rowCount) throw notFound('التاجر غير موجود');
  return { ok: true };
});

// ================= المنتجات (المراجعة) =================
route('GET', '/admin/products', { perm: 'products.review' }, async (c) => {
  const st = c.url.searchParams.get('status') || 'pending_review';
  const rows = (await c.db.query(`SELECT p.id, p.name_ar, p.description, p.merchant_price, p.currency, p.status, p.review_notes, p.created_at, m.shop_name, cat.name_ar AS category, cat.is_restricted,
      (SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort_order LIMIT 1) AS image_url,
      COALESCE((SELECT json_agg(url ORDER BY sort_order) FROM product_images WHERE product_id = p.id), '[]'::json) AS images,
      COALESCE((SELECT sum(i.quantity)::int FROM product_variants v JOIN inventory i ON i.variant_id = v.id WHERE v.product_id = p.id), 0) AS stock,
      p.final_price, p.markup_percent
      FROM products p JOIN merchants m ON m.id = p.merchant_id JOIN categories cat ON cat.id = p.category_id
      WHERE p.status::text = $1 ORDER BY p.created_at DESC LIMIT 200`, [st])).rows;
  // معاينة السعر الذي سيظهر للمشتري عند الاعتماد
  for (const r of rows) if (r.status === 'pending_review') {
    try { const pr = (await c.db.query('SELECT final_price, markup_percent, markup_amount FROM compute_price($1)', [r.id])).rows[0]; r.preview = pr; } catch (e: any) { r.preview = null; r.preview_error = e.message; }
  }
  return { products: rows };
});
route('POST', '/admin/products/:id/review', { perm: 'products.review' }, async (c) => {
  const b = z.object({ decision: z.enum(['approve', 'reject']), notes: z.string().max(500).optional() }).parse(c.body);
  if (b.decision === 'reject' && !b.notes) throw bad('اكتب سبب الرفض');
  await c.db.tx(async t => {
    if (b.decision === 'approve') await t.query('SELECT approve_product($1,$2,$3)', [c.params.id, c.user!.id, b.notes || null]);
    else await t.query(`UPDATE products SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_notes = $3 WHERE id = $1`, [c.params.id, c.user!.id, b.notes]);
  }, { userId: c.user!.id });
  return { ok: true };
});

// ================= الطلبات =================
route('GET', '/admin/orders', { perm: 'orders.view' }, async (c) => {
  const st = c.url.searchParams.get('status');
  return { orders: (await c.db.query(`SELECT o.id, o.order_number, o.status, o.total, o.currency, o.created_at, o.recipient_name, o.recipient_phone, o.is_demo, g.name_ar AS governorate, au.full_name AS agent
      FROM orders o JOIN governorates g ON g.id = o.governorate_id LEFT JOIN delivery_agents a ON a.id = o.agent_id LEFT JOIN users au ON au.id = a.user_id
      WHERE ($1::text IS NULL OR o.status::text = $1) ORDER BY o.created_at DESC LIMIT 300`, [st])).rows };
});
route('GET', '/admin/orders/:id', { perm: 'orders.view' }, async (c) => {
  const o = (await c.db.query(`SELECT o.*, g.name_ar AS governorate FROM orders o JOIN governorates g ON g.id = o.governorate_id WHERE o.id = $1`, [c.params.id])).rows[0];
  if (!o) throw notFound('الطلب غير موجود');
  const canFin = await c.perm('accounting.view');
  const items = (await c.db.query(`SELECT i.product_name, i.quantity, i.unit_price, i.line_total, m.shop_name${canFin ? ', i.merchant_unit_price, i.markup_unit_amount, i.markup_percent' : ''}
      FROM order_items i JOIN merchants m ON m.id = i.merchant_id WHERE i.order_id = $1`, [o.id])).rows;
  const history = (await c.db.query(`SELECT h.to_status, h.note, h.created_at, u.full_name AS actor FROM order_status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.order_id = $1 ORDER BY h.id`, [o.id])).rows;
  return { order: o, items, history };
});
route('POST', '/admin/orders/:id/status', { perm: 'orders.manage' }, async (c) => {
  const b = z.object({ to: z.string(), note: z.string().max(300).optional() }).parse(c.body);
  await c.db.tx(t => t.query('SELECT change_order_status($1, $2::order_status, $3, $4)', [c.params.id, b.to, c.user!.id, b.note || null]), { userId: c.user!.id });
  return { ok: true };
});
route('GET', '/admin/agents', { perm: 'orders.assign' }, async (c) =>
  ({ agents: (await c.db.query(`SELECT a.id, u.full_name, u.phone, a.is_active FROM delivery_agents a JOIN users u ON u.id = a.user_id WHERE u.status = 'active' ORDER BY u.full_name`)).rows }));
route('POST', '/admin/orders/:id/assign', { perm: 'orders.assign' }, async (c) => {
  const { agent_id } = z.object({ agent_id: uuid }).parse(c.body);
  await c.db.tx(async t => {
    const a = (await t.query('SELECT id FROM delivery_agents WHERE id = $1 AND is_active', [agent_id])).rows[0];
    if (!a) throw bad('المندوب غير متاح');
    const o = (await t.query(`UPDATE orders SET agent_id = $2 WHERE id = $1 AND status NOT IN ('delivered','cancelled','refunded','return_completed') RETURNING id`, [c.params.id, agent_id])).rows[0];
    if (!o) throw bad('لا يمكن إسناد هذا الطلب في حالته الحالية');
    await audit(c, t, 'order.assign', 'orders', c.params.id, { agent_id });
  }, { userId: c.user!.id });
  return { ok: true };
});

// ================= الأقسام =================
route('GET', '/admin/categories', { perm: 'categories.manage' }, async (c) =>
  ({ categories: (await c.db.query(`SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id) AS products FROM categories c ORDER BY c.parent_id NULLS FIRST, c.sort_order, c.name_ar`)).rows }));
const catZ = z.object({ name_ar: z.string().trim().min(2).max(80), slug: z.string().regex(/^[a-z0-9-]+$/).max(60), parent_id: uuid.nullish(), image_url: z.string().max(500).nullish(),
  sort_order: z.number().int().default(0), is_active: z.boolean().default(true), show_on_home: z.boolean().default(false), is_restricted: z.boolean().default(false), requires_license: z.boolean().default(false) });
route('POST', '/admin/categories', { perm: 'categories.manage' }, async (c) => {
  const b = catZ.parse(c.body);
  const r = await c.db.tx(async t => { const x = (await t.query(`INSERT INTO categories(name_ar, slug, parent_id, image_url, sort_order, is_active, show_on_home, is_restricted, requires_license)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [b.name_ar, b.slug, b.parent_id || null, b.image_url || null, b.sort_order, b.is_active, b.show_on_home, b.is_restricted, b.requires_license])).rows[0];
    await audit(c, t, 'category.create', 'categories', x.id, b); return x; }, { userId: c.user!.id });
  return { id: r.id };
});
route('PATCH', '/admin/categories/:id', { perm: 'categories.manage' }, async (c) => {
  const b = catZ.partial().parse(c.body); const sets: string[] = []; const v: any[] = [c.params.id];
  for (const [k, val] of Object.entries(b)) { v.push(val); sets.push(`${k} = $${v.length}`); }
  if (!sets.length) throw bad('لا تغييرات');
  await c.db.tx(async t => { await t.query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $1`, v); await audit(c, t, 'category.update', 'categories', c.params.id, b); }, { userId: c.user!.id });
  return { ok: true };
});
route('DELETE', '/admin/categories/:id', { perm: 'categories.manage' }, async (c) => {
  await c.db.tx(async t => { await t.query('DELETE FROM categories WHERE id = $1', [c.params.id]); await audit(c, t, 'category.delete', 'categories', c.params.id, {}); }, { userId: c.user!.id });
  return { ok: true };
});

// ================= التسعير وأسعار الصرف =================
route('GET', '/admin/pricing', { perm: 'pricing.manage' }, async (c) => {
  const rules = (await c.db.query(`SELECT r.id, r.scope, r.markup_percent, r.fixed_final_price, r.is_excluded, r.is_active, r.created_at, m.shop_name, cat.name_ar AS category, p.name_ar AS product
      FROM pricing_rules r LEFT JOIN merchants m ON m.id = r.merchant_id LEFT JOIN categories cat ON cat.id = r.category_id LEFT JOIN products p ON p.id = r.product_id ORDER BY r.is_active DESC, r.created_at DESC`)).rows;
  const rates = (await c.db.query(`SELECT e.id, e.from_currency, e.to_currency, e.rate, e.valid_from, e.valid_to, g.name_ar AS governorate, u.full_name AS by FROM exchange_rates e LEFT JOIN governorates g ON g.id = e.governorate_id LEFT JOIN users u ON u.id = e.created_by ORDER BY e.valid_from DESC LIMIT 50`)).rows;
  const currencies = (await c.db.query('SELECT code, name_ar, symbol, is_base, decimals FROM currencies WHERE is_active ORDER BY is_base DESC')).rows;
  return { rules, rates, currencies };
});
route('POST', '/admin/pricing/rules', { perm: 'pricing.manage' }, async (c) => {
  const b = z.object({ scope: z.enum(['global', 'merchant', 'category', 'product']), target_id: uuid.nullish(), markup_percent: z.number().min(0).max(500).nullish(), fixed_final_price: z.number().min(0).nullish(), is_excluded: z.boolean().default(false) }).parse(c.body);
  if (b.scope !== 'global' && !b.target_id) throw bad('حدد الهدف');
  const col = ({ merchant: 'merchant_id', category: 'category_id', product: 'product_id' } as any)[b.scope];
  const r = await c.db.tx(t => t.query(`INSERT INTO pricing_rules(scope, ${col ? col + ',' : ''} markup_percent, fixed_final_price, is_excluded, created_by) VALUES ($1, ${col ? '$2,' : ''} $${col ? 3 : 2}, $${col ? 4 : 3}, $${col ? 5 : 4}, $${col ? 6 : 5}) RETURNING id`,
    col ? [b.scope, b.target_id, b.markup_percent ?? null, b.fixed_final_price ?? null, b.is_excluded, c.user!.id] : [b.scope, b.markup_percent ?? null, b.fixed_final_price ?? null, b.is_excluded, c.user!.id]), { userId: c.user!.id });
  return { id: r.rows[0].id, note: 'القاعدة الجديدة لا تغيّر أسعار المنتجات المنشورة إلا بقرار «إعادة تسعير» صريح' };
});
route('PATCH', '/admin/pricing/rules/:id', { perm: 'pricing.manage' }, async (c) => {
  const { is_active } = z.object({ is_active: z.boolean() }).parse(c.body);
  await c.db.tx(t => t.query('UPDATE pricing_rules SET is_active = $2 WHERE id = $1', [c.params.id, is_active]), { userId: c.user!.id });
  return { ok: true };
});
// قرار صريح بإعادة التسعير: لمنتج أو لكل المنتجات المعتمدة
route('POST', '/admin/pricing/reprice', { perm: 'pricing.manage' }, async (c) => {
  const b = z.object({ product_id: uuid.optional(), all_approved: z.boolean().optional() }).parse(c.body);
  if (!b.product_id && !b.all_approved) throw bad('حدد منتجاً أو كل المنتجات');
  const n = await c.db.tx(async t => {
    const ids = b.product_id ? [b.product_id] : (await t.query(`SELECT id FROM products WHERE status = 'approved'`)).rows.map((r: any) => r.id);
    for (const id of ids) await t.query('SELECT apply_pricing_to_product($1,$2)', [id, c.user!.id]);
    await audit(c, t, 'pricing.reprice', 'products', b.product_id || 'all', { count: ids.length });
    return ids.length;
  }, { userId: c.user!.id });
  return { repriced: n };
});
route('POST', '/admin/exchange-rates', { perm: 'pricing.manage' }, async (c) => {
  const b = z.object({ from_currency: z.string().length(3), to_currency: z.string().length(3), rate: z.number().positive(), governorate_id: uuid.nullish() }).parse(c.body);
  if (b.governorate_id && !(await c.perm('fx.manage'))) throw forbidden('أسعار الصرف حسب المنطقة تتطلب تفعيل وحدة «إدارة أسعار الصرف المتقدمة»');
  await c.db.tx(async t => {
    // إنهاء السعر السابق ثم إدخال الجديد (السجلات تاريخية لا تعدل)
    await t.query(`UPDATE exchange_rates SET valid_to = now() WHERE from_currency = $1 AND to_currency = $2 AND governorate_id IS NOT DISTINCT FROM $3 AND valid_to IS NULL`, [b.from_currency, b.to_currency, b.governorate_id || null]);
    await t.query('INSERT INTO exchange_rates(from_currency, to_currency, rate, governorate_id, created_by) VALUES ($1,$2,$3,$4,$5)', [b.from_currency, b.to_currency, b.rate, b.governorate_id || null, c.user!.id]);
  }, { userId: c.user!.id });
  return { ok: true };
});

// ================= وحدات النظام =================
route('GET', '/admin/modules', { perm: 'modules.manage' }, async (c) => {
  const m = (await c.db.query(`SELECT code, name_ar, description, is_core, status, readiness, requirements, updated_at,
      COALESCE((SELECT array_agg(depends_on_code) FROM module_dependencies d WHERE d.module_code = s.code), '{}') AS depends_on,
      COALESCE((SELECT array_agg(module_code) FROM module_dependencies d WHERE d.depends_on_code = s.code), '{}') AS required_by
      FROM system_modules s ORDER BY is_core DESC, code`)).rows;
  return { modules: m };
});
route('POST', '/admin/modules/:code', { perm: 'modules.manage' }, async (c) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(c.body);
  await c.db.tx(t => t.query(`UPDATE system_modules SET status = $2::module_status, updated_by = $3 WHERE code = $1`, [c.params.code, enabled ? 'enabled' : 'disabled', c.user!.id]), { userId: c.user!.id });
  return { ok: true };
});

// ================= المستخدمون والموظفون =================
route('GET', '/admin/users', { perm: 'users.manage' }, async (c) => {
  const role = c.url.searchParams.get('role');
  return { users: (await c.db.query(`SELECT u.id, u.full_name, u.phone, u.status, u.is_demo, u.created_at, u.last_login_at, r.code AS role, r.name_ar AS role_name
      FROM users u JOIN roles r ON r.id = u.role_id WHERE ($1::text IS NULL OR r.code = $1) ORDER BY u.created_at DESC LIMIT 300`, [role])).rows,
    roles: (await c.db.query(`SELECT code, name_ar FROM roles WHERE code NOT IN ('buyer','merchant') ORDER BY name_ar`)).rows };
});
route('POST', '/admin/users', { perm: 'users.manage' }, async (c) => {
  const b = z.object({ role: z.string(), full_name: z.string().trim().min(2).max(100), phone: z.string().transform(normalizePhone).refine(p => /^\+?[0-9]{7,15}$/.test(p)), password: z.string().min(8).max(200) }).parse(c.body);
  if (['buyer', 'merchant'].includes(b.role)) throw bad('المشترون والتجار يسجلون بأنفسهم');
  if (['super_admin', 'admin_staff'].includes(b.role) && !(await c.perm('roles.manage'))) throw forbidden('إنشاء المدراء يتطلب صلاحية إدارة الأدوار');
  const hash = await hashPassword(b.password);
  const id = await c.db.tx(async t => {
    const role = (await t.query('SELECT id FROM roles WHERE code = $1', [b.role])).rows[0]; if (!role) throw bad('الدور غير موجود');
    const u = (await t.query('INSERT INTO users(role_id, full_name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [role.id, b.full_name, b.phone, hash])).rows[0];
    if (b.role === 'delivery_agent') await t.query('INSERT INTO delivery_agents(user_id) VALUES ($1)', [u.id]); else await t.query('INSERT INTO employees(user_id) VALUES ($1)', [u.id]);
    await audit(c, t, 'user.create', 'users', u.id, { role: b.role, phone: b.phone });
    return u.id;
  }, { userId: c.user!.id });
  return { id };
});
route('PATCH', '/admin/users/:id', { perm: 'users.manage' }, async (c) => {
  const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(c.body);
  if (c.params.id === c.user!.id) throw bad('لا يمكنك إيقاف حسابك');
  await c.db.tx(async t => {
    const tgt = (await t.query(`SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [c.params.id])).rows[0];
    if (!tgt) throw notFound('المستخدم غير موجود');
    if (tgt.code === 'super_admin' && !(await c.perm('roles.manage'))) throw forbidden();
    await t.query('UPDATE users SET status = $2 WHERE id = $1', [c.params.id, status]);
    if (status === 'suspended') await t.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [c.params.id]);
    await audit(c, t, 'user.' + status, 'users', c.params.id, {});
  }, { userId: c.user!.id });
  return { ok: true };
});

// ================= المحاسبة =================
route('GET', '/admin/accounting', { perm: 'accounting.view' }, async (c) => {
  const balances = (await c.db.query(`SELECT m.id AS merchant_id, m.shop_name, b.currency, b.balance, b.total_sales_credit, b.total_paid FROM merchant_balances b JOIN merchants m ON m.id = b.merchant_id ORDER BY b.balance DESC`)).rows;
  const vouchers = (await c.db.query(`SELECT pv.id, pv.voucher_number, pv.amount, pv.currency, pv.method, pv.reason, pv.status, pv.created_at, m.shop_name, u.full_name AS issued_by, rv.voucher_number AS receipt_number
      FROM payment_vouchers pv JOIN merchants m ON m.id = pv.merchant_id JOIN users u ON u.id = pv.issued_by LEFT JOIN receipt_vouchers rv ON rv.payment_voucher_id = pv.id ORDER BY pv.created_at DESC LIMIT 100`)).rows;
  const platform = (await c.db.query(`SELECT kind, currency, sum(amount) AS total FROM platform_ledger GROUP BY kind, currency ORDER BY kind`)).rows;
  return { balances, vouchers, platform };
});
route('POST', '/admin/payouts', { perm: 'payouts.create' }, async (c) => {
  const b = z.object({ merchant_id: uuid, amount: z.number().positive(), currency: z.string().length(3), method: z.enum(['cash', 'bank_transfer']), reason: z.string().trim().min(2).max(300), idempotency_key: z.string().min(8).max(80) }).parse(c.body);
  const id = await c.db.tx(async t => (await t.query('SELECT issue_payment_voucher($1,$2,$3,$4,$5,$6::uuid[],$7,$8) AS id', [b.merchant_id, b.amount, b.currency, b.method, b.reason, [], c.user!.id, b.idempotency_key])).rows[0].id, { userId: c.user!.id });
  return { id };
});

route('GET', '/admin/audit', { perm: 'audit.view' }, async (c) =>
  ({ logs: (await c.db.query(`SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.full_name AS actor, left(coalesce(a.new_data::text, ''), 300) AS data FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 200`)).rows }));
