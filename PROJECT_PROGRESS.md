# وسيطك — سجل التقدم (PROJECT_PROGRESS.md)

آخر تحديث: 2026-11-21

## الوصف
منصة تجارة إلكترونية ووساطة رقمية عربية (RTL) للسوق اليمني: تاجر ↔ مشتري، والمنصة تضيف نسبة (افتراضياً 20%) على سعر التاجر ولا تظهر للمشتري.

## التقنيات (قرارات مثبتة)
- قاعدة البيانات: PostgreSQL 16 (ترحيلات SQL في db/migrations)، المنطق المالي داخل دوال/محفزات DB. للإنتاج: Neon (مجاني).
- الخادم: TypeScript بمعالجات Web-standard (`dispatch(Request)→Response`)؛ محلياً سائق pgwire خاص (WASITAK_LOCAL_DRIVER=1)، وفي الإنتاج حزمة `pg`.
- الواجهة: React 19 + CSS خاص (RTL، جوال أولاً) — بدلاً من Tailwind لعدم توفر npm. PWA (manifest + sw.js لا يخزن /api).
- النشر: Vercel Hobby عبر `app/api/index.ts` + `app/vercel.json`؛ صور عبر Vercel Blob (`BLOB_READ_WRITE_TOKEN`) — كلاهما **غير مختبر على Vercel بعد**.
- خرائط: Leaflet + OpenStreetMap (CDN). التتبع الحي للمندوب فقط أثناء «خرج للتوصيل».

## هيكل الملفات
- db/migrations/001..007, db/tests/001..003, db/rebuild_test_db.sh, db/run_tests.sh
- app/src/server (core, db, pgwire, storage, handlers/{public,buyer,merchant,admin,agent})
- app/src/ui (common, buyer, merchant, admin, agent, shell, main, styles.css)
- app/scripts (build-ui, dev-server, create-admin, seed-demo, e2e.mjs), app/tests/api.test.ts

## المنجز فعلاً ومختبر
- DB: 96 تأكيد ناجح (سلامة مالية، عمليات، تسعير لحظي snapshot).
- API: 13 اختبار تكامل ناجح.
- E2E متصفح (Playwright، سطح مكتب + iPhone 13 + Pixel 7): 38/38 — تصفح/سلة/إتمام طلب COD، إدارة الحالات والإسناد، مراجعة المنتجات، تسليم المندوب مع موقع حقيقي يظهر للمشتري، مالية التاجر، حراسة الأدوار.
- أدوار: مشتري، تاجر، مدير/موظفون، مندوب؛ توجيه تلقائي حسب الدور.
- بيانات تجريبية معزولة (is_demo + seed-demo بشرط ALLOW_DEMO_SEED=1 وقاعدة منفصلة).

## غير مكتمل (بصدق)
- عزل RLS على مستوى DB (حالياً مفروض في استعلامات الخادم).
- واجهات/APIs: المرتجعات والاسترداد للمشتري، التقييمات، الشكاوى والدعم، محادثة مشتري–مندوب (DB جاهز)، إدارة الإعلانات، الإشعارات وWeb Push، إدارة المناطق/العملات (واجهة)، شركات التوصيل.
- المحافظ (كريمي/جوالي/ون كاش): غير مدمجة — COD فقط مفعّل.
- «وسيطك الذكي»: جداول DB + بطاقة فقط؛ لا واجهة اشتراكات ولا مزود AI؛ معطّل افتراضياً.
- تصدير PDF للسندات، عكس قيود المرتجعات في دفتر التاجر، تسعير حسب المنطقة وقت الطلب، فرض تراخيص الفئات المقيّدة.
- نشر Vercel/Neon/GitHub (يتطلب تسجيل دخول المستخدم بنفسه)، اختبار الجوال الحقيقي، جدولة النسخ الاحتياطي.
- تحسين بسيط: جدول عناصر الطلب في نافذة الإدارة (عُدّل العرض، يحتاج مراجعة بصرية).

## تشغيل واختبار (انظر PROJECT_SETUP.md)
- `pg_ctlcluster 16 main start` ثم `db/run_tests.sh`
- `cd app && WASITAK_LOCAL_DRIVER=1 tsx --test tests/api.test.ts`
- E2E: تشغيل dev-server على 3100 ثم `node scripts/e2e.mjs`

## الخطوة التالية
1) المرتجعات/التقييمات/الشكاوى (API+UI) 2) محادثة المندوب 3) الإعلانات والإشعارات 4) RLS 5) واجهة اشتراكات وسيطك الذكي 6) النشر.
