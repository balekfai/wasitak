import { z } from 'zod';
import { route, json, bad, notFound, HttpError, hashPassword, verifyPassword, normalizePhone, createSession, sessionCookie, revokeSession, rateLimit, type Ctx } from '../core.js';

const phoneZ = z.string().transform(normalizePhone).refine((p: string) => /^\+?[0-9]{7,15}$/.test(p), 'رقم الهاتف غير صحيح');
const pwZ = z.string().min(8, 'كلمة المرور 8 أحرف على الأقل').max(200);

// ================= المصادقة =================
const registerZ = z.discriminatedUnion('role', [
  z.object({ role: z.literal('buyer'), full_name: z.string().trim().min(2).max(100), phone: phoneZ, password: pwZ, governorate_id: z.string().uuid().optional() }),
  z.object({ role: z.literal('merchant'), full_name: z.string().trim().min(2).max(100), phone: phoneZ, password: pwZ,
    shop_name: z.string().trim().min(2).max(100), governorate_id: z.string().uuid().optional(), address: z.string().max(300).optional(), description: z.string().max(1000).optional() }),
]);

route('POST', '/auth/register', 'none', async (c) => {
  rateLimit('reg:' + c.ip, 10, 600_000);
  const b = registerZ.parse(c.body);
  const hash = await hashPassword(b.password);
  const userId = await c.db.tx(async t => {
    const role = (await t.query('SELECT id FROM roles WHERE code = $1', [b.role])).rows[0];
    let u;
    try {
      u = (await t.query('INSERT INTO users(role_id, full_name, phone, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [role.id, b.full_name, b.phone, hash])).rows[0];
    } catch (e: any) { if (e.code === '23505') throw new HttpError(409, 'رقم الهاتف مسجل مسبقاً'); throw e; }
    if (b.role === 'buyer') await t.query('INSERT INTO customers(user_id, governorate_id) VALUES ($1,$2)', [u.id, b.governorate_id || null]);
    else await t.query(`INSERT INTO merchants(user_id, shop_name, governorate_id, address, description, default_currency)
        VALUES ($1,$2,$3,$4,$5,(SELECT code FROM currencies WHERE is_base))`, [u.id, b.shop_name, b.governorate_id || null, b.address || null, b.description || null]);
    return u.id as string;
  });
  const token = await createSession(c.db, userId, c.ip, c.req.headers.get('user-agent') || '');
  c.setCookies.push(sessionCookie(token));
  return { ok: true, role: b.role };
});

route('POST', '/auth/login', 'none', async (c) => {
  const { identifier, password } = z.object({ identifier: z.string().trim().min(1).max(320), password: z.string().min(1).max(200) }).parse(c.body);
  rateLimit('login:' + c.ip, 20, 600_000);
  const isEmail = identifier.includes('@');
  const phone = isEmail ? null : phoneZ.parse(identifier);
  const email = isEmail ? z.string().email('البريد الإلكتروني غير صحيح').parse(identifier).toLowerCase() : null;
  const u = (await c.db.query(`SELECT u.id, u.password_hash, u.status, u.failed_logins, u.locked_until, r.code AS role
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.phone = $1 OR (u.email = $2 AND r.code IN ('super_admin','admin_staff','product_reviewer','order_staff','accountant','support_staff'))`,
    [phone, email])).rows[0];
  const fail = () => new HttpError(401, 'بيانات الدخول غير صحيحة');
  if (!u) { await verifyPassword(password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); throw fail(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(423, 'الحساب مقفل مؤقتاً بسبب محاولات خاطئة، حاول لاحقاً');
  if (!(await verifyPassword(password, u.password_hash))) {
    await c.db.query(`UPDATE users SET
        locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END WHERE id = $1`, [u.id]);
    throw fail();
  }
  if (u.status !== 'active') throw new HttpError(403, 'الحساب غير مفعل أو موقوف');
  await c.db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [u.id]);
  const token = await createSession(c.db, u.id, c.ip, c.req.headers.get('user-agent') || '');
  c.setCookies.push(sessionCookie(token));
  return { ok: true, role: u.role };
});

route('POST', '/auth/logout', 'none', async (c) => {
  await revokeSession(c.db, c.req); c.setCookies.push(sessionCookie('', 0)); return { ok: true };
});

route('GET', '/auth/me', 'none', async (c) => {
  if (!c.user) return { user: null };
  let extra: any = {};
  if (c.user.role === 'merchant') extra.merchant = (await c.db.query('SELECT id, shop_name, status, rejection_reason, default_currency FROM merchants WHERE user_id = $1', [c.user.id])).rows[0];
  const isStaff = await c.perm('admin.access');
  const perms = isStaff ? (await c.db.query(`SELECT p.code FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE u.id = $1 AND (p.module_code IS NULL OR EXISTS (SELECT 1 FROM system_modules m WHERE m.code = p.module_code AND m.status = 'enabled'))`, [c.user.id])).rows.map((r: any) => r.code) : [];
  return { user: { id: c.user.id, role: c.user.role, full_name: c.user.full_name, phone: c.user.phone, is_demo: c.user.is_demo, is_staff: isStaff, permissions: perms }, ...extra };
});

// ================= الواجهة العامة (بلا تسجيل دخول) =================
const PRODUCT_COLS = 'id, name_ar, price, currency, image_url, in_stock, avg_rating, review_count, shop_name, category_id';

route('GET', '/public/home', 'none', async (c) => {
  const [cats, latest, govs] = await Promise.all([
    c.db.query('SELECT id, name_ar, slug, image_url FROM categories WHERE is_active AND parent_id IS NULL AND show_on_home ORDER BY sort_order, name_ar'),
    c.db.query(`SELECT ${PRODUCT_COLS} FROM public_products ORDER BY created_at DESC LIMIT 12`),
    c.db.query('SELECT id, name_ar FROM governorates WHERE is_active AND accepts_orders ORDER BY sort_order'),
  ]);
  return { categories: cats.rows, latest: latest.rows, governorates: govs.rows };
});

route('GET', '/public/categories', 'none', async (c) =>
  ({ categories: (await c.db.query('SELECT id, parent_id, name_ar, slug, image_url, is_restricted FROM categories WHERE is_active ORDER BY sort_order, name_ar')).rows }));

route('GET', '/public/governorates', 'none', async (c) => {
  const g = await c.db.query('SELECT id, name_ar FROM governorates WHERE is_active AND accepts_orders ORDER BY sort_order');
  const a = await c.db.query(`SELECT a.id, a.name_ar, d.governorate_id FROM areas a JOIN districts d ON d.id = a.district_id WHERE a.is_active AND a.accepts_orders ORDER BY a.name_ar`);
  return { governorates: g.rows, areas: a.rows };
});

route('GET', '/public/products', 'none', async (c) => {
  const q = c.url.searchParams;
  const page = Math.max(1, Number(q.get('page')) || 1), limit = Math.min(48, Number(q.get('limit')) || 24);
  const where: string[] = []; const p: any[] = [];
  const term = (q.get('q') || '').trim().slice(0, 80);
  if (term) { p.push('%' + term.replace(/[%_\\]/g, m => '\\' + m) + '%'); where.push(`(name_ar ILIKE $${p.length} OR description ILIKE $${p.length} OR shop_name ILIKE $${p.length})`); }
  const cat = q.get('category');
  if (cat) {
    p.push(cat);
    where.push(`category_id IN (WITH RECURSIVE t AS (SELECT id FROM categories WHERE id::text = $${p.length} OR slug = $${p.length}
        UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t)`);
  }
  const sort = ({ new: 'created_at DESC', price_asc: 'price ASC', price_desc: 'price DESC', rating: 'avg_rating DESC NULLS LAST' } as any)[q.get('sort') || 'new'] || 'created_at DESC';
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number((await c.db.query(`SELECT count(*) AS n FROM public_products ${w}`, p)).rows[0].n);
  p.push(limit, (page - 1) * limit);
  const rows = (await c.db.query(`SELECT ${PRODUCT_COLS} FROM public_products ${w} ORDER BY ${sort} LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
  return { products: rows, total, page, pages: Math.ceil(total / limit) };
});

route('GET', '/public/products/:id', 'none', async (c) => {
  if (!/^[0-9a-f-]{36}$/i.test(c.params.id)) throw notFound('المنتج غير موجود');
  const prod = (await c.db.query('SELECT id, name_ar, description, details, category_id, shop_name, price, currency, in_stock, avg_rating, review_count FROM public_products WHERE id = $1', [c.params.id])).rows[0];
  if (!prod) throw notFound('المنتج غير موجود');
  const images = (await c.db.query('SELECT url FROM product_images WHERE product_id = $1 ORDER BY sort_order, created_at', [prod.id])).rows.map((r: any) => r.url);
  // أسعار الخيارات من لقطة السعر المعتمدة نفسها التي يُحاسب بها الطلب
  const variants = (await c.db.query(`SELECT v.id, v.options, COALESCE(i.quantity,0) AS stock,
        round(sp.final_price * safe_exchange_rate(sp.currency, b.code), b.decimals) AS price
      FROM product_variants v LEFT JOIN inventory i ON i.variant_id = v.id
      CROSS JOIN LATERAL snapshot_price(v.product_id, v.price_delta) sp
      CROSS JOIN (SELECT code, decimals FROM currencies WHERE is_base) b
      WHERE v.product_id = $1 AND v.is_active ORDER BY v.created_at`, [prod.id])).rows;
  const reviews = (await c.db.query(`SELECT r.product_rating AS rating, r.comment, r.created_at, split_part(u.full_name, ' ', 1) AS name
      FROM reviews r JOIN customers cu ON cu.id = r.customer_id JOIN users u ON u.id = cu.user_id
      WHERE r.product_id = $1 AND r.is_visible ORDER BY r.created_at DESC LIMIT 10`, [prod.id])).rows;
  const similar = (await c.db.query(`SELECT ${PRODUCT_COLS} FROM public_products WHERE category_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 8`, [prod.category_id, prod.id])).rows;
  const category = (await c.db.query('SELECT id, name_ar FROM categories WHERE id = $1', [prod.category_id])).rows[0];
  return { product: { ...prod, images, variants, category }, reviews, similar };
});

// طرق الدفع المفعلة ورسوم التوصيل التقديرية (منفصلة عن ربح وسيطك)
route('GET', '/public/payment-methods', 'none', async (c) =>
  ({ methods: (await c.db.query(`SELECT code, name_ar FROM payment_methods WHERE is_enabled AND readiness <> 'not_implemented' ORDER BY code`)).rows }));

route('GET', '/public/delivery-fee', 'none', async (c) => {
  const g = c.url.searchParams.get('governorate_id'); const a = c.url.searchParams.get('area_id');
  if (!g || !/^[0-9a-f-]{36}$/i.test(g)) throw bad('حدد المحافظة');
  const r = (await c.db.query(`SELECT round(z.fee * COALESCE(safe_exchange_rate(z.currency, b.code), 1), b.decimals) AS fee, b.code AS currency
      FROM delivery_zones z CROSS JOIN (SELECT code, decimals FROM currencies WHERE is_base) b
      WHERE z.is_active AND z.governorate_id = $1 AND (z.area_id IS NULL OR z.area_id::text = $2) ORDER BY (z.area_id IS NOT NULL) DESC LIMIT 1`, [g, a])).rows[0];
  return { fee: r ? r.fee : '0', currency: r ? r.currency : 'YER', configured: !!r };
});

route('GET', '/public/currencies', 'none', async (c) =>
  ({ currencies: (await c.db.query('SELECT code, name_ar, symbol, is_base FROM currencies WHERE is_active ORDER BY is_base DESC, code')).rows }));
