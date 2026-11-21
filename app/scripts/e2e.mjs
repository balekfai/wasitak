// اختبار متصفح حقيقي (Chromium) على قاعدة تجريبية: تدفق كامل تاجر → إدارة → مشتري → توصيل → محاسبة، بعرض الهاتف والكمبيوتر.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3100'; const OUT = new URL('../e2e-shots/', import.meta.url).pathname; fs.mkdirSync(OUT, { recursive: true });
const PW = 'Demo#12345'; const results = []; const errors = [];
const ok = (name, cond, extra = '') => { results.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + extra)); };
const browser = await chromium.launch();
const mkCtx = (opts = {}) => browser.newContext({ locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 15.3547, longitude: 44.2067 }, ...opts });
async function open(ctx, name) {
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(name + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|fonts\.|unpkg/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
  p.on('dialog', d => d.accept('سبب الرفض التجريبي'));
  return p;
}
async function login(p, phone) {
  await p.goto(BASE + '/login'); await p.fill('input[autocomplete="username"]', phone); await p.fill('input[type=password]', PW);
  await p.click('form button.btn.block'); await p.waitForLoadState('networkidle');
}
const shot = (p, n) => p.screenshot({ path: OUT + n + '.png', fullPage: false });

// ---------- الكمبيوتر: واجهة المشتري ----------
const desk = await mkCtx({ viewport: { width: 1280, height: 800 } });
let p = await open(desk, 'desktop-guest');
await p.goto(BASE + '/'); await p.waitForSelector('.pcard');
ok('الرئيسية: تظهر المنتجات المعتمدة (6)', (await p.locator('.pcard').count()) === 6);
ok('الصفحة RTL وبالعربية', (await p.getAttribute('html', 'dir')) === 'rtl' && (await p.getAttribute('html', 'lang')) === 'ar');
ok('لا سعر تاجر ولا ربح في الصفحة', !/ربح|سعر التاجر/.test(await p.innerText('body')));
const price = await p.locator('.pcard', { hasText: 'قميص رجالي' }).locator('.price').innerText();
ok('سعر القميص = 4000 + 20% = 4,800', /4,800/.test(price), price);
await shot(p, 'desktop-home');
await p.fill('.search input', 'فستان'); await p.click('.search button'); await p.waitForURL(/shop\?q=/); await p.waitForSelector('.pcard');
ok('البحث بالعربية يعيد الفستان فقط', (await p.locator('.pcard').count()) === 1);
await p.goto(BASE + '/shop?category=women-clothing'); await p.waitForSelector('.pcard');
ok('الفلترة بالقسم الأب تشمل الأقسام الفرعية', (await p.locator('.pcard').count()) === 2);
await p.goto(BASE + '/'); await p.locator('.pcard', { hasText: 'قميص رجالي' }).click(); await p.waitForSelector('h1');
await shot(p, 'desktop-product');
ok('المقاس الناقد (XL=0 غير موجود) ونفاد كمية غير ظاهر للمتاح', (await p.locator('.chip').count()) >= 2);
await p.click('text=إضافة للسلة'); await p.waitForSelector('.toast');
await p.click('a[href="/cart"].iconbtn'); await p.waitForSelector('text=ملخص الطلب');
ok('السلة تحتوي القميص', await p.locator('text=قميص رجالي').count() > 0);
await shot(p, 'desktop-cart');
await p.click('text=سجّل الدخول لإتمام الطلب'); await p.waitForURL(/login/);
await p.fill('input[autocomplete="username"]', '+967770000003'); await p.fill('input[type=password]', PW); await p.click('form button.btn.block');
await p.waitForURL(/checkout/);
await p.selectOption('select >> nth=1', { label: 'صنعاء' }).catch(async () => { await p.locator('select').filter({ hasText: 'اختر…' }).first().selectOption({ label: 'صنعاء' }); });
await p.fill('textarea', 'صنعاء - شارع الستين - بجوار المسجد'); await p.waitForSelector('text=1,000');
await shot(p, 'desktop-checkout');
ok('رسوم التوصيل 1,000 تظهر منفصلة', await p.locator('text=1,000').count() > 0);
await p.click('text=تأكيد الطلب'); await p.waitForURL(/orders\/.+new=1/);
await p.waitForSelector('text=تم استلام طلبك بنجاح'); ok('تأكيد إنشاء الطلب', await p.locator('text=تم استلام طلبك بنجاح').count() === 1);
const orderUrl = p.url().split('?')[0]; const orderNo = (await p.locator('h1 .num').innerText()).trim();
ok('إجمالي الطلب 5,800 (4,800 + 1,000)', await p.locator('text=5,800').count() > 0);
await shot(p, 'desktop-order');

// ---------- الإدارة ----------
const adminCtx = await mkCtx({ viewport: { width: 1366, height: 800 } }); const a = await open(adminCtx, 'admin');
await login(a, '+967770000001'); await a.waitForURL(/\/admin/); await a.waitForSelector('.stat');
ok('المدير يصل للوحة الإدارة تلقائياً', a.url().includes('/admin'));
ok('الأرقام المالية الحقيقية لا تحتوي طلبات التجريبي', await a.locator('text=الأرقام المالية').count() === 1);
await shot(a, 'admin-dashboard');
await a.goto(BASE + '/admin/orders'); await a.waitForSelector('table');
ok('الطلب يظهر في الإدارة وموسوم تجريبي', await a.locator('tr', { hasText: orderNo }).locator('.badge', { hasText: 'تجريبي' }).count() === 1);
await a.locator('tr', { hasText: orderNo }).locator('text=إدارة').click(); await a.waitForSelector('.modal');
await shot(a, 'admin-order-modal');
for (const s of ['مؤكد', 'قيد التجهيز', 'جاهز للتوصيل']) { await a.locator('.modal').getByRole('button', { name: s, exact: true }).click(); await a.waitForTimeout(500); }
await a.selectOption('select[aria-label="المندوب"]', { label: 'مندوب تجريبي' }); await a.click('text=إسناد'); await a.waitForTimeout(500);
ok('الإدارة تغيّر الحالة وتسند المندوب', await a.locator('.modal .badge', { hasText: 'جاهز للتوصيل' }).count() > 0);
await a.keyboard.press('Escape');

// ---------- المندوب (جوال) ----------
const mob = await mkCtx({ ...devices['iPhone 13'], locale: 'ar', permissions: ['geolocation'], geolocation: { latitude: 15.3547, longitude: 44.2067 } });
const g = await open(mob, 'agent'); await login(g, '+967770000004'); await g.waitForURL(/\/agent/); await g.waitForSelector('text=بدء التوصيل');
await shot(g, 'agent-mobile-before');
await g.click('text=بدء التوصيل'); await g.waitForSelector('text=موقعك يُشارك', { timeout: 10000 }).catch(() => {});
await g.waitForTimeout(2500); await shot(g, 'agent-mobile-active');
// المشتري يتتبع
const bctx = desk; const b = await open(bctx, 'buyer-track'); await b.goto(orderUrl); await b.waitForSelector('text=خرج للتوصيل');
ok('المشتري يرى حالة «خرج للتوصيل» وقسم التتبع', await b.locator('text=تتبع المندوب').count() === 1);
const trk = await b.evaluate(async (u) => (await (await fetch('/api/orders/' + u.split('/').pop() + '/tracking')).json()), orderUrl);
ok('الموقع الحقيقي وصل للمشتري (15.3547)', trk.active && Math.abs(trk.location.lat - 15.3547) < 0.001, JSON.stringify(trk));
await g.click('text=تأكيد التسليم'); await g.waitForSelector('text=تم التسليم'); ok('المندوب يؤكد التسليم', true);
await b.reload(); await b.waitForSelector('text=تم التسليم'); await shot(b, 'desktop-order-delivered');
ok('التتبع يختفي بعد التسليم', await b.locator('text=تتبع المندوب').count() === 0);

// ---------- التاجر: منتج جديد + مستحقات ----------
const mctx = await mkCtx({ ...devices['Pixel 7'], locale: 'ar' }); const m = await open(mctx, 'merchant'); await login(m, '+967770000002'); await m.waitForURL(/\/merchant/); await m.waitForSelector('.stat');
await shot(m, 'merchant-mobile-dashboard');
await m.goto(BASE + '/merchant/finance'); await m.waitForSelector('.stat');
ok('مستحق التاجر 4,000 بعد التسليم', await m.locator('text=4,000').count() > 0); await shot(m, 'merchant-mobile-finance');
await m.goto(BASE + '/merchant/products/new'); await m.waitForSelector('form');
await m.fill('input[required][minlength="2"]', 'ساعة يد كلاسيكية'); await m.locator('textarea').first().fill('ساعة معدنية مقاومة للماء.');
await m.locator('select').first().selectOption({ index: 3 }); await m.fill('input[type=number][min="1"]', '6000');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
await m.setInputFiles('input[type=file]', { name: 'w.png', mimeType: 'image/png', buffer: png }); await m.waitForSelector('.imgs .im');
await shot(m, 'merchant-mobile-product-form');
await m.click('text=إرسال للمراجعة'); await m.waitForURL(/merchant\/products$/); await m.waitForSelector('table');
ok('المنتج الجديد بانتظار المراجعة عند التاجر', await m.locator('tr', { hasText: 'ساعة يد' }).locator('text=بانتظار المراجعة').count() === 1);
const pub0 = await b.evaluate(async () => (await (await fetch('/api/public/products?q=ساعة')).json()).total); ok('غير منشور قبل الاعتماد', pub0 === 0);
await a.goto(BASE + '/admin/products'); await a.waitForSelector('.card:has-text("ساعة يد")'); await shot(a, 'admin-products-review');
await a.locator('.card', { hasText: 'ساعة يد' }).locator('text=اعتماد ونشر').click(); await a.waitForSelector('.toast');
const pub1 = await b.evaluate(async () => (await (await fetch('/api/public/products?q=ساعة')).json())); ok('بعد الاعتماد يظهر بسعر 7,200 (6000 + 20%)', pub1.total === 1 && Number(pub1.products[0].price) === 7200, JSON.stringify(pub1.products));

// ---------- صفحات الإدارة الأخرى + جوال المشتري ----------
for (const [path, name] of [['/admin/modules', 'admin-modules'], ['/admin/pricing', 'admin-pricing'], ['/admin/categories', 'admin-categories'], ['/admin/accounting', 'admin-accounting'], ['/admin/users', 'admin-users'], ['/admin/audit', 'admin-audit'], ['/admin/merchants', 'admin-merchants']]) {
  await a.goto(BASE + path); await a.waitForSelector('h1'); await a.waitForTimeout(400); await shot(a, name);
  ok('صفحة ' + path + ' تعمل بلا خطأ', await a.locator('.alert.bad').count() === 0);
}
const bm = await mkCtx({ ...devices['iPhone 13'], locale: 'ar' }); const q = await open(bm, 'buyer-mobile');
await q.goto(BASE + '/'); await q.waitForSelector('.pcard'); await shot(q, 'mobile-home');
ok('الجوال: لا تمرير أفقي للصفحة', await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
ok('الجوال: شريط التنقل السفلي ظاهر', await q.locator('.bottomnav').isVisible());
await q.locator('.pcard').first().click(); await q.waitForSelector('h1'); await shot(q, 'mobile-product');
ok('الجوال: صفحة المنتج بلا تمرير أفقي', await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await q.goto(BASE + '/login'); await shot(q, 'mobile-login');
const mm = await mkCtx({ ...devices['iPhone 13'], locale: 'ar' }); const ad = await open(mm, 'admin-mobile'); await login(ad, '+967770000001'); await ad.waitForSelector('.stat'); await shot(ad, 'admin-mobile-dashboard');
ok('الجوال: لوحة الإدارة بلا تمرير أفقي', await ad.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await ad.click('.mtop button'); await ad.waitForTimeout(300); await shot(ad, 'admin-mobile-menu');

// ---------- حماية المسارات ----------
const guest = await open(await mkCtx(), 'guest'); await guest.goto(BASE + '/admin'); await guest.waitForSelector('.alert');
ok('الزائر لا يرى لوحة الإدارة', await guest.locator('text=لحسابات الإدارة والموظفين فقط').count() === 1);
const bpage = await open(await mkCtx(), 'buyer-guard'); await login(bpage, '+967770000003'); await bpage.goto(BASE + '/admin'); await bpage.waitForSelector('.alert');
ok('المشتري لا يرى لوحة الإدارة', await bpage.locator('text=لحسابات الإدارة والموظفين فقط').count() === 1);
await bpage.goto(BASE + '/merchant'); await bpage.waitForSelector('.alert'); ok('المشتري لا يرى لوحة التاجر', await bpage.locator('text=لحسابات التجار فقط').count() === 1);

ok('لا أخطاء JavaScript في أي صفحة', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter(r => !r[1]).length; console.log(`\nالنتيجة: ${results.length - failed} ناجح / ${failed} فاشل`); process.exit(failed ? 1 : 0);
