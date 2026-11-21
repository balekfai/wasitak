import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DB = 'wasitak_api_test';
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:5432/${DB}`;
process.env.WASITAK_LOCAL_DRIVER = '1';
process.env.UPLOAD_DIR = '/tmp/wasitak-test-uploads';

const { dispatch } = await import('../src/server/index');
const { getDb } = await import('../src/server/db');
const { hashPassword } = await import('../src/server/core');

class Client {
  cookie = '';
  async call(method: string, url: string, body?: any, opts: { csrf?: boolean; raw?: Buffer } = {}) {
    const headers: Record<string, string> = { cookie: this.cookie };
    if (opts.csrf !== false) headers['x-requested-with'] = 'wasitak';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await dispatch(new Request('http://x' + url, { method, headers, body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }));
    const sc = res.headers.getSetCookie?.() || [];
    const ws = sc.find(s => s.startsWith('ws_session='));
    if (ws) this.cookie = ws.split(';')[0].replace(/^ws_session=$/, '');
    const text = await res.text();
    let j: any = {}; try { j = JSON.parse(text); } catch {}
    return { status: res.status, body: j, text };
  }
}
const ok = (r: { status: number; body: any }, msg = '') => assert.equal(r.status, 200, msg + ' → ' + JSON.stringify(r.body));
const key = () => 'k-' + Math.random().toString(36).slice(2, 12);

let adminPw = 'Admin#12345', db: any;
const admin = new Client(), mA = new Client(), mB = new Client(), buyer = new Client(), staff = new Client(), agent = new Client();
const ids: Record<string, string> = {};

before(async () => {
  execSync(`${path.resolve('../db/rebuild_test_db.sh')} ${DB}`, { stdio: 'pipe' });
  db = await getDb();
  const role = (await db.query(`SELECT id FROM roles WHERE code='super_admin'`)).rows[0].id;
  await db.query(`INSERT INTO users(role_id, full_name, phone, password_hash) VALUES ($1,'مدير الاختبار','+967700999999',$2)`, [role, await hashPassword(adminPw)]);
  ids.sanaa = (await db.query(`SELECT id FROM governorates WHERE name_ar='صنعاء'`)).rows[0].id;
  ids.cat = (await db.query(`SELECT id FROM categories WHERE slug='men-summer'`)).rows[0].id;
});

test('المصادقة: دخول المدير، رفض الخاطئ، قفل الحساب، CSRF', async () => {
  assert.equal((await admin.call('POST', '/api/auth/login', { phone: '+967700999999', password: 'wrong-pass' })).status, 401);
  assert.equal((await admin.call('POST', '/api/auth/login', { phone: '+967700999999', password: adminPw }, { csrf: false })).status, 403, 'CSRF');
  ok(await admin.call('POST', '/api/auth/login', { phone: '٠٠٩٦٧٧٠٠٩٩٩٩٩٩'.replace(/^٠٠٩٦٧/, '00967'), password: adminPw }), 'تطبيع الهاتف (00967…)');
  const me = await admin.call('GET', '/api/auth/me');
  assert.equal(me.body.user.is_staff, true); assert.ok(me.body.user.permissions.includes('modules.manage'));
  const lock = new Client();
  await db.query(`INSERT INTO users(role_id, full_name, phone, password_hash) SELECT id,'ق','+967700888888',$1 FROM roles WHERE code='buyer'`, [await hashPassword('Secret#123')]);
  for (let i = 0; i < 5; i++) assert.equal((await lock.call('POST', '/api/auth/login', { phone: '+967700888888', password: 'bad-password' })).status, 401);
  assert.equal((await lock.call('POST', '/api/auth/login', { phone: '+967700888888', password: 'Secret#123' })).status, 423, 'القفل المؤقت');
});

test('التسجيل: المشتري والتاجر فقط، ولا مدير عبر التسجيل العام', async () => {
  const r = await mA.call('POST', '/api/auth/register', { role: 'super_admin', full_name: 'هاكر', phone: '+967700111000', password: 'Password#1' });
  assert.equal(r.status, 400, 'لا تسجيل بدور مدير');
  ok(await mA.call('POST', '/api/auth/register', { role: 'merchant', full_name: 'تاجر أ', phone: '+967700111001', password: 'Password#1', shop_name: 'محل أ', governorate_id: ids.sanaa }));
  ok(await mB.call('POST', '/api/auth/register', { role: 'merchant', full_name: 'تاجر ب', phone: '+967700111002', password: 'Password#1', shop_name: 'محل ب' }));
  ok(await buyer.call('POST', '/api/auth/register', { role: 'buyer', full_name: 'أحمد المشتري', phone: '+967700111003', password: 'Password#1' }));
  assert.equal((await new Client().call('POST', '/api/auth/register', { role: 'buyer', full_name: 'مكرر', phone: '+967700111003', password: 'Password#1' })).status, 409, 'هاتف مكرر');
  assert.equal((await new Client().call('POST', '/api/auth/register', { role: 'buyer', full_name: 'ضعيف', phone: '+967700111004', password: '123' })).status, 400, 'كلمة مرور ضعيفة');
});

test('التاجر المعلّق لا يضيف منتجات حتى تقبله الإدارة', async () => {
  const body = { name_ar: 'قميص صيفي', description: 'قطن 100%', category_id: ids.cat, merchant_price: 5000, currency: 'YER', variants: [{ options: {}, quantity: 5, price_delta: 0 }] };
  assert.equal((await mA.call('POST', '/api/merchant/products', body)).status, 403);
  const list = await admin.call('GET', '/api/admin/merchants?status=pending');
  assert.equal(list.body.merchants.length, 2);
  for (const m of list.body.merchants) ok(await admin.call('POST', `/api/admin/merchants/${m.id}/decision`, { decision: 'approve' }));
});

test('منتج: إنشاء → مراجعة → نشر بسعر 6000 دون كشف سعر التاجر', async () => {
  const body = { name_ar: 'قميص صيفي', description: 'قطن 100%', category_id: ids.cat, merchant_price: 5000, currency: 'YER', variants: [{ options: {}, quantity: 5, price_delta: 0 }] };
  ok(await mA.call('POST', '/api/merchant/products', body));
  assert.equal((await new Client().call('GET', '/api/public/products')).body.total, 0, 'غير منشور قبل الاعتماد');
  const pend = await admin.call('GET', '/api/admin/products');
  assert.equal(pend.body.products.length, 1);
  assert.equal(Number(pend.body.products[0].preview.final_price), 6000, 'معاينة المراجع: 5000 + 20%');
  ids.product = pend.body.products[0].id;
  // موظف طلبات لا يراجع المنتجات
  await db.query(`INSERT INTO users(role_id, full_name, phone, password_hash) SELECT id,'موظف طلبات','+967700222001',$1 FROM roles WHERE code='order_staff'`, [await hashPassword('Staff#12345')]);
  ok(await staff.call('POST', '/api/auth/login', { phone: '+967700222001', password: 'Staff#12345' }));
  assert.equal((await staff.call('POST', `/api/admin/products/${ids.product}/review`, { decision: 'approve' })).status, 403);
  ok(await admin.call('POST', `/api/admin/products/${ids.product}/review`, { decision: 'approve' }));
  const pub = await new Client().call('GET', '/api/public/products');
  assert.equal(pub.body.total, 1); assert.equal(Number(pub.body.products[0].price), 6000);
  const det = await new Client().call('GET', `/api/public/products/${ids.product}`);
  ids.variant = det.body.product.variants[0].id;
  assert.equal(Number(det.body.product.variants[0].price), 6000);
  for (const t of [pub.text, det.text]) { assert.ok(!/merchant_price|markup|5000/.test(t), 'لا تسرب لسعر التاجر أو الربح في الاستجابات العامة'); }
  const s = await new Client().call('GET', '/api/public/products?q=' + encodeURIComponent('قميص'));
  assert.equal(s.body.total, 1, 'البحث بالعربية');
  assert.equal((await new Client().call('GET', "/api/public/products?q=%25'%3B--")).status, 200, 'لا حقن SQL');
});

test('عزل التجار: تاجر ب لا يرى ولا يعدّل منتجات تاجر أ', async () => {
  assert.equal((await mB.call('GET', '/api/merchant/products')).body.products.length, 0);
  assert.equal((await mB.call('PATCH', `/api/merchant/products/${ids.product}`, { name_ar: 'اختراق', merchant_price: 1 })).status, 404);
  assert.equal((await mB.call('PUT', `/api/merchant/products/${ids.product}/stock`, { variant_id: ids.variant, quantity: 9999 })).status, 404);
  assert.equal((await mB.call('GET', '/api/merchant/orders')).body.orders.length, 0);
  assert.equal((await mB.call('GET', '/api/admin/stats')).status, 403, 'تاجر لا يدخل الإدارة');
  assert.equal((await new Client().call('GET', '/api/merchant/me')).status, 401);
});

test('الطلب: خصم المخزون، منع التكرار، منع البيع الزائد، إخفاء بيانات التاجر', async () => {
  const k = key();
  const order = { items: [{ variant_id: ids.variant, qty: 2 }], governorate_id: ids.sanaa, name: 'أحمد', phone: '+967711000111', address: 'صنعاء - شارع الستين', payment_method: 'cod', idempotency_key: k };
  const r1 = await buyer.call('POST', '/api/orders', order); ok(r1);
  const r2 = await buyer.call('POST', '/api/orders', order); ok(r2);
  assert.equal(r1.body.order.id, r2.body.order.id, 'نفس المفتاح = نفس الطلب');
  assert.equal(Number(r1.body.order.total), 12000);
  ids.order = r1.body.order.id;
  const over = await buyer.call('POST', '/api/orders', { ...order, items: [{ variant_id: ids.variant, qty: 4 }], idempotency_key: key() });
  assert.equal(over.status, 409); assert.match(over.body.error, /غير متوفرة/);
  assert.equal((await buyer.call('POST', '/api/orders', { ...order, payment_method: 'kuraimi', idempotency_key: key() })).status, 409, 'محفظة غير مفعلة');
  const stock = (await mA.call('GET', '/api/merchant/products')).body.products[0].variants[0].quantity;
  assert.equal(stock, 3, 'المخزون 5 − 2');
  const d = await buyer.call('GET', `/api/orders/${ids.order}`);
  assert.ok(!/merchant_unit_price|markup|5000/.test(d.text), 'المشتري لا يرى سعر التاجر');
  const mo = await mA.call('GET', '/api/merchant/orders');
  assert.equal(mo.body.orders.length, 1); assert.equal(Number(mo.body.orders[0].merchant_total), 10000);
  assert.ok(!/967711000111|recipient_phone|12000/.test(mo.text), 'التاجر لا يرى هاتف المشتري ولا سعر البيع');
  const other = new Client(); ok(await other.call('POST', '/api/auth/register', { role: 'buyer', full_name: 'مشتري آخر', phone: '+967700111009', password: 'Password#1' }));
  assert.equal((await other.call('GET', `/api/orders/${ids.order}`)).status, 404, 'مشتري لا يرى طلب غيره');
});

test('التوصيل: إسناد، حالات، تتبع، تسليم، واستحقاق التاجر', async () => {
  ok(await admin.call('POST', '/api/admin/users', { role: 'delivery_agent', full_name: 'مندوب الاختبار', phone: '+967700333001', password: 'Agent#12345' }));
  const agents = (await admin.call('GET', '/api/admin/agents')).body.agents; assert.equal(agents.length, 1);
  assert.equal((await staff.call('POST', '/api/admin/users', { role: 'super_admin', full_name: 'x', phone: '+967700333002', password: 'Password#1' })).status, 403, 'موظف لا ينشئ مديراً');
  ok(await agent.call('POST', '/api/auth/login', { phone: '+967700333001', password: 'Agent#12345' }));
  assert.equal((await agent.call('GET', '/api/agent/orders')).body.orders.length, 0, 'لا طلبات قبل الإسناد');
  for (const to of ['confirmed', 'preparing', 'ready_for_delivery']) ok(await staff.call('POST', `/api/admin/orders/${ids.order}/status`, { to }), to);
  assert.equal((await staff.call('POST', `/api/admin/orders/${ids.order}/status`, { to: 'refunded' })).status, 409, 'انتقال غير مسموح');
  ok(await staff.call('POST', `/api/admin/orders/${ids.order}/assign`, { agent_id: agents[0].id }));
  assert.equal((await agent.call('GET', '/api/agent/orders')).body.orders.length, 1);
  assert.equal((await agent.call('POST', `/api/agent/orders/${ids.order}/location`, { lat: 15.35, lng: 44.2 })).status, 409, 'لا تتبع قبل بدء التوصيل');
  ok(await agent.call('POST', `/api/agent/orders/${ids.order}/status`, { to: 'out_for_delivery' }));
  ok(await agent.call('POST', `/api/agent/orders/${ids.order}/location`, { lat: 15.3547, lng: 44.2067, accuracy: 12 }));
  const tr = await buyer.call('GET', `/api/orders/${ids.order}/tracking`);
  assert.equal(tr.body.active, true); assert.equal(tr.body.location.lat, 15.3547);
  ok(await agent.call('POST', `/api/agent/orders/${ids.order}/status`, { to: 'delivered' }));
  assert.equal((await buyer.call('GET', `/api/orders/${ids.order}/tracking`)).body.active, false, 'التتبع يتوقف بعد التسليم');
  assert.equal((await agent.call('POST', `/api/agent/orders/${ids.order}/location`, { lat: 1, lng: 1 })).status, 409);
  const fin = await mA.call('GET', '/api/merchant/finance');
  assert.equal(Number(fin.body.balances[0].balance), 10000, 'مستحق التاجر = 2 × 5000');
});

test('المحاسبة: صرف جزئي، منع التكرار والزيادة، سند قبض من صاحبه فقط', async () => {
  const [m] = (await admin.call('GET', '/api/admin/accounting')).body.balances;
  const body = { merchant_id: m.merchant_id, amount: 4000, currency: 'YER', method: 'cash', reason: 'دفعة أولى', idempotency_key: key() };
  assert.equal((await staff.call('POST', '/api/admin/payouts', body)).status, 403, 'موظف طلبات لا يصرف');
  const p1 = await admin.call('POST', '/api/admin/payouts', body); ok(p1);
  assert.equal((await admin.call('POST', '/api/admin/payouts', body)).body.id, p1.body.id, 'تكرار المفتاح لا ينشئ سنداً ثانياً');
  assert.equal((await admin.call('POST', '/api/admin/payouts', { ...body, amount: 7000, idempotency_key: key() })).status, 409, 'أكبر من المتبقي 6000');
  assert.equal((await mB.call('POST', `/api/merchant/vouchers/${p1.body.id}/confirm`)).status, 403, 'تاجر آخر لا يؤكد سند غيره');
  ok(await mA.call('POST', `/api/merchant/vouchers/${p1.body.id}/confirm`));
  const fin = (await mA.call('GET', '/api/merchant/finance')).body;
  assert.equal(Number(fin.balances[0].balance), 6000); assert.equal(fin.vouchers[0].status, 'confirmed');
  const st = (await admin.call('GET', '/api/admin/stats')).body;
  assert.ok(st.finance, 'المدير يرى الأرقام المالية');
  assert.equal((await staff.call('GET', '/api/admin/stats')).body.finance, undefined, 'موظف الطلبات لا يرى المالية');
  assert.equal((await staff.call('GET', '/api/admin/accounting')).status, 403);
});

test('التسعير: النسبة الجديدة لا تغيّر المنشور إلا بإعادة تسعير صريحة', async () => {
  ok(await admin.call('POST', '/api/admin/pricing/rules', { scope: 'global', markup_percent: 30 }));
  assert.equal(Number((await new Client().call('GET', '/api/public/products')).body.products[0].price), 6000);
  const old = (await admin.call('GET', '/api/admin/pricing')).body.rules.filter((r: any) => r.scope === 'global' && r.markup_percent == 20)[0];
  ok(await admin.call('PATCH', `/api/admin/pricing/rules/${old.id}`, { is_active: false }));
  assert.equal(Number((await new Client().call('GET', '/api/public/products')).body.products[0].price), 6000, 'ما زال 6000');
  assert.equal((await admin.call('POST', '/api/admin/pricing/reprice', { all_approved: true })).body.repriced, 1);
  assert.equal(Number((await new Client().call('GET', '/api/public/products')).body.products[0].price), 6500, 'بعد القرار الصريح: 5000 + 30%');
});

test('تعديل التاجر لسعر منتج منشور يعيده للمراجعة ويخفيه', async () => {
  const r = await mA.call('PATCH', `/api/merchant/products/${ids.product}`, { merchant_price: 5500 });
  ok(r); assert.equal(r.body.sent_to_review, true);
  assert.equal((await new Client().call('GET', '/api/public/products')).body.total, 0);
});

test('الوحدات: لا تعطيل للأساسية ولا تفعيل لغير المنفذة، وصلاحيات الوحدة تتبع التفعيل', async () => {
  assert.equal((await admin.call('POST', '/api/admin/modules/orders', { enabled: false })).status, 409);
  assert.equal((await admin.call('POST', '/api/admin/modules/delivery_companies', { enabled: true })).status, 409);
  assert.equal((await admin.call('POST', '/api/admin/modules/fx_advanced', { enabled: true })).status, 409, 'يعتمد على إدارة العملات');
  ok(await admin.call('POST', '/api/admin/modules/currencies_mgmt', { enabled: true }));
  ok(await admin.call('POST', '/api/admin/modules/fx_advanced', { enabled: true }));
  assert.equal((await admin.call('POST', '/api/admin/modules/currencies_mgmt', { enabled: false })).status, 409, 'وحدة أخرى تعتمد عليها');
  assert.equal((await staff.call('GET', '/api/admin/modules')).status, 403);
  const logs = (await admin.call('GET', '/api/admin/audit')).body.logs;
  assert.ok(logs.some((l: any) => l.entity === 'system_modules'), 'التفعيل مسجل في التدقيق');
});

test('رفع الصور: يقبل الصور الحقيقية فقط', async () => {
  const bad = await mA.call('POST', '/api/merchant/uploads', undefined, { raw: Buffer.from('<?php echo 1; ?>') });
  assert.equal(bad.status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const good = await mA.call('POST', '/api/merchant/uploads', undefined, { raw: png });
  ok(good); assert.match(good.body.url, /^\/uploads\/[a-f0-9]+\.(webp|png)$/);
});

test('الخروج يُبطل الجلسة', async () => {
  ok(await buyer.call('POST', '/api/auth/logout'));
  assert.equal((await buyer.call('GET', '/api/orders')).status, 401);
});

after(async () => { await db.close(); });
