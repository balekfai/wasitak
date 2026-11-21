// بيانات تجريبية معزولة: حسابات (مشتري/تاجر/مدير/مندوب) ومنتجات للتجربة، كلها is_demo=true.
// لا تُشغَّل على قاعدة الإنتاج: يلزم ALLOW_DEMO_SEED=1 وقاعدة منفصلة (مثلاً فرع Neon للتجربة).
import sharp from 'sharp';
import { getDb } from '../src/server/db';
import { hashPassword } from '../src/server/core';
import { saveImage } from '../src/server/storage';

if (process.env.ALLOW_DEMO_SEED !== '1') { console.error('ارفض: عيّن ALLOW_DEMO_SEED=1 وتأكد أن DATABASE_URL لقاعدة تجريبية منفصلة'); process.exit(1); }
const PW = process.env.DEMO_PASSWORD || 'Demo#12345';
const db = await getDb();
const hash = await hashPassword(PW);
const mk = async (role: string, name: string, phone: string) => (await db.query(
  `INSERT INTO users(role_id, full_name, phone, password_hash, is_demo) SELECT id,$1,$2,$3,true FROM roles WHERE code=$4 ON CONFLICT (phone) DO UPDATE SET is_demo = true RETURNING id`, [name, phone, hash, role])).rows[0].id;
const admin = await mk('super_admin', 'مدير تجريبي', '+967770000001');
const mUser = await mk('merchant', 'تاجر تجريبي', '+967770000002');
const buyer = await mk('buyer', 'مشتري تجريبي', '+967770000003');
const agent = await mk('delivery_agent', 'مندوب تجريبي', '+967770000004');
const gov = (await db.query(`SELECT id FROM governorates WHERE name_ar = 'صنعاء'`)).rows[0].id;
await db.query(`INSERT INTO merchants(user_id, shop_name, governorate_id, default_currency, status) VALUES ($1,'متجر الأناقة التجريبي',$2,'YER','approved') ON CONFLICT DO NOTHING`, [mUser, gov]);
await db.query(`INSERT INTO customers(user_id, governorate_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [buyer, gov]);
await db.query(`INSERT INTO delivery_agents(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [agent]);
await db.query(`INSERT INTO delivery_zones(governorate_id, fee, currency) VALUES ($1, 1000, 'YER') ON CONFLICT DO NOTHING`, [gov]);
const m = (await db.query('SELECT id FROM merchants WHERE user_id = $1', [mUser])).rows[0].id;

const items: [string, string, string, number, string, [string, number][]][] = [
  ['قميص رجالي قطن صيفي', 'men-summer', 'قميص قطن 100% بقصة مريحة، مناسب للصيف.', 4000, '#0f766e', [['M', 10], ['L', 8], ['XL', 0]]],
  ['فستان نسائي أنيق', 'wom-dresses', 'فستان بقماش ناعم وتطريز يدوي.', 9000, '#be185d', [['S', 4], ['M', 6]]],
  ['حذاء رياضي', 'men-sport', 'حذاء خفيف الوزن للجري والمشي.', 7500, '#1d4ed8', [['42', 5], ['43', 5]]],
  ['عباءة سوداء', 'wom-abaya', 'عباءة بتصميم عملي وقماش مريح.', 12000, '#111827', [['قياس واحد', 7]]],
  ['ملابس أطفال صيفية', 'kids-summer', 'طقم صيفي قطني للأطفال.', 3000, '#f59e0b', [['2-3 سنوات', 12], ['4-5 سنوات', 9]]],
  ['مستلزمات صحية — كمامات', 'pharm-health', 'علبة كمامات طبية (50 قطعة).', 2000, '#0891b2', [['علبة', 30]]],
];
for (const [name, slug, desc, price, color, vars] of items) {
  const png = await sharp({ create: { width: 900, height: 900, channels: 3, background: color } }).composite([{ input: Buffer.from(`<svg width="900" height="900"><text x="450" y="500" font-size="90" fill="#fff" text-anchor="middle" font-family="sans-serif">${name.slice(0, 14).replace(/[<&]/g, '')}</text></svg>`) }]).png().toBuffer();
  const url = await saveImage(png, 'demo-' + slug);
  const cat = (await db.query('SELECT id FROM categories WHERE slug = $1', [slug])).rows[0].id;
  const exists = (await db.query('SELECT id FROM products WHERE merchant_id=$1 AND name_ar=$2', [m, name])).rows[0]; if (exists) continue;
  await db.tx(async t => {
    const p = (await t.query(`INSERT INTO products(merchant_id, category_id, name_ar, description, merchant_price, currency, status) VALUES ($1,$2,$3,$4,$5,'YER','pending_review') RETURNING id`, [m, cat, name, desc, price])).rows[0];
    await t.query('INSERT INTO product_images(product_id, url) VALUES ($1,$2)', [p.id, url]);
    for (const [opt, q] of vars) { const v = (await t.query(`INSERT INTO product_variants(product_id, options) VALUES ($1,$2) RETURNING id`, [p.id, opt === 'قياس واحد' ? {} : { المقاس: opt }])).rows[0]; await t.query('INSERT INTO inventory(variant_id, quantity) VALUES ($1,$2)', [v.id, q]); }
    await t.query('SELECT approve_product($1,$2)', [p.id, admin]);
  }, { userId: admin });
}
console.log('تم تجهيز الحسابات التجريبية. كلمة المرور:', PW, '\n  مدير: +967770000001 · تاجر: +967770000002 · مشتري: +967770000003 · مندوب: +967770000004');
await db.close();
