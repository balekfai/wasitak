// إعلانات الصفحة الرئيسية (بانر): عرض عام + تتبع الظهور والنقر + إدارة من لوحة الإدارة.
import { z } from 'zod';
import crypto from 'node:crypto';
import { route, HttpError, bad, notFound, rateLimit } from '../core.js';
import { saveImage } from '../storage.js';

const P = { perm: 'ads.manage' };
const imgUrl = z.string().max(500).regex(/^(\/uploads\/[A-Za-z0-9._-]+|https:\/\/[^\s]+)$/, 'رابط صورة غير صحيح');

// ---------- عام: الإعلانات الفعّالة ضمن مدتها (تنتهي وحدها بانتهاء التاريخ) ----------
route('GET', '/public/ads', 'none', async (c) => {
  const rows = (await c.db.query(`SELECT a.id, a.image_url, a.text_ar, a.shop_name, a.target_id AS merchant_id
      FROM advertisements a
      JOIN merchants m ON m.id = a.target_id AND m.status = 'approved'
      WHERE a.status = 'active' AND a.placement = 'home_banner' AND a.target_type = 'store' AND a.image_url IS NOT NULL
        AND (a.starts_at IS NULL OR a.starts_at <= now()) AND (a.ends_at IS NULL OR a.ends_at > now())
      ORDER BY a.starts_at DESC NULLS LAST LIMIT 6`)).rows;
  return { ads: rows };
});

route('POST', '/public/ads/:id/event', 'none', async (c) => {
  rateLimit('adev:' + c.ip, 200, 600_000);
  const b = z.object({ event: z.enum(['impression', 'click']) }).parse(c.body);
  const id = z.string().uuid().parse(c.params.id);
  await c.db.query(`INSERT INTO advertisement_events(ad_id, event, user_id)
      SELECT a.id, $2::text, $3::uuid FROM advertisements a WHERE a.id = $1::uuid AND a.status = 'active'`, [id, b.event, c.user?.id ?? null]);
  return { ok: true };
});

// ---------- الإدارة ----------
route('GET', '/admin/ads', P, async (c) => {
  const [ads, merchants] = await Promise.all([
    c.db.query(`SELECT a.id, a.shop_name, a.image_url, a.text_ar, a.status, a.payment_status, a.amount_due, a.currency, a.starts_at, a.ends_at, a.created_at,
        (a.status = 'active' AND a.ends_at IS NOT NULL AND a.ends_at <= now()) AS ended,
        (SELECT count(*)::int FROM advertisement_events e WHERE e.ad_id = a.id AND e.event = 'impression') AS impressions,
        (SELECT count(*)::int FROM advertisement_events e WHERE e.ad_id = a.id AND e.event = 'click') AS clicks
      FROM advertisements a WHERE a.placement = 'home_banner' ORDER BY a.created_at DESC LIMIT 200`),
    c.db.query(`SELECT id, shop_name FROM merchants WHERE status = 'approved' ORDER BY shop_name`),
  ]);
  return { ads: ads.rows, merchants: merchants.rows };
});

route('POST', '/admin/ads', P, async (c) => {
  const b = z.object({
    merchant_id: z.string().uuid(), image_url: imgUrl, text_ar: z.string().trim().max(120).optional(),
    days: z.number().int().min(1).max(365), starts_at: z.string().max(40).optional(),
    amount_due: z.number().min(0).max(1e10).default(0), payment_status: z.enum(['unpaid', 'paid', 'waived']).default('unpaid'),
  }).parse(c.body);
  const start = b.starts_at ? new Date(b.starts_at) : new Date();
  if (Number.isNaN(start.getTime())) throw bad('تاريخ البدء غير صحيح');
  const id = await c.db.tx(async t => {
    const m = (await t.query(`SELECT id, user_id, shop_name FROM merchants WHERE id = $1 AND status = 'approved'`, [b.merchant_id])).rows[0];
    if (!m) throw notFound('التاجر غير موجود أو غير معتمد');
    const r = await t.query(`INSERT INTO advertisements(owner_user_id, shop_name, placement, image_url, text_ar, starts_at, ends_at, target_type, target_id, status, amount_due, currency, payment_status, reviewed_by, reviewed_at)
        VALUES ($1, $2, 'home_banner', $3, $4, $5::timestamptz, $5::timestamptz + make_interval(days => $6::int), 'store', $7, 'active', $8, (SELECT code FROM currencies WHERE is_base), $9, $10, now()) RETURNING id`,
      [m.user_id, m.shop_name, b.image_url, b.text_ar || null, start.toISOString(), b.days, m.id, b.amount_due, b.payment_status, c.user!.id]);
    return r.rows[0].id as string;
  }, { userId: c.user!.id });
  return { id };
});

route('PATCH', '/admin/ads/:id', P, async (c) => {
  const id = z.string().uuid().parse(c.params.id);
  const b = z.object({
    status: z.enum(['active', 'paused']).optional(), payment_status: z.enum(['unpaid', 'paid', 'waived']).optional(),
    extend_days: z.number().int().min(1).max(365).optional(),
  }).parse(c.body);
  const sets = ['reviewed_by = $2', 'reviewed_at = now()']; const p: any[] = [id, c.user!.id];
  if (b.status) { p.push(b.status); sets.push(`status = $${p.length}`); }
  if (b.payment_status) { p.push(b.payment_status); sets.push(`payment_status = $${p.length}`); }
  if (b.extend_days) { p.push(b.extend_days); sets.push(`ends_at = GREATEST(COALESCE(ends_at, now()), now()) + make_interval(days => $${p.length}::int)`); }
  if (sets.length === 2) throw bad('لا يوجد تغيير');
  const n = await c.db.tx(async t => (await t.query(`UPDATE advertisements SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, p)).rows.length, { userId: c.user!.id });
  if (!n) throw notFound('الإعلان غير موجود');
  return { ok: true };
});

// رفع صورة الإعلان (جسم ثنائي خام، نفس فحوصات صور المنتجات)
route('POST', '/admin/ads/upload', P, async (c) => {
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length === 0) throw bad('لا يوجد ملف');
  if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'الصورة أكبر من 5 ميغابايت');
  return { url: await saveImage(buf, 'ad-' + crypto.randomBytes(12).toString('hex')) };
}, { raw: true });
