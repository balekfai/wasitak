# وسيطك — الإعداد والتشغيل (PROJECT_SETUP.md)

## المتطلبات
- PostgreSQL 15+ (الاختبار تم على 16).
- لاحقاً للتطبيق: Node.js 20+.

## قاعدة البيانات
```bash
# إنشاء قاعدة جديدة وتطبيق كل الترحيلات بالترتيب
createdb wasitak
for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d wasitak -f "$f"; done
```
الترحيلات هيكلية فقط (لا بيانات وهمية). كل ملف داخل معاملة واحدة.

## الاختبار
```bash
# يعيد بناء قاعدة wasitak_test ويشغل الاختبارات (يتطلب تشغيل السكربت كمستخدم يملك صلاحية su postgres)
db/run_tests.sh
```
النتيجة المتوقعة: 66 ناجح/0 فاشل، ثم 24 ناجح/0 فاشل. الاختبارات تعمل داخل معاملة تُلغى فلا تترك بيانات.

## إنشاء حساب المدير الأول
لا تسجيل عام للمدير. بعد بناء طبقة المصادقة: سكربت لمرة واحدة ينشئ مستخدماً بدور `super_admin` بكلمة مرور مجزأة (argon2/bcrypt) تُدخلها أنت محلياً — لا تُرسل في المحادثة.

## متغيرات البيئة (مخطط)
`DATABASE_URL`, `SESSION_SECRET`, `STORAGE_*` (تخزين الصور)، `VAPID_*` (Web Push). **كل الأسرار في Vercel Environment Variables فقط، وليس في الكود ولا المحادثة.**

## النشر على حسابك في Vercel (تنفذه أنت)
1. ارفع المجلد إلى مستودع GitHub خاص.
2. في Vercel: Add New → Project → اختر المستودع (حسابك الحالي، لا حساب جديد).
3. أضف متغيرات البيئة أعلاه.
4. قاعدة PostgreSQL مجانية: Neon أو Supabase (خطة مجانية) — أنشئها من حسابك وانسخ `DATABASE_URL` إلى Vercel، ثم نفّذ الترحيلات عليها.
حدود الخطط المجانية: سعة تخزين محدودة، إيقاف القاعدة عند الخمول، وحدود طلبات — راجع صفحة خطة كل مزود قبل الإطلاق.

## النسخ الاحتياطي والاستعادة
```bash
pg_dump -Fc "$DATABASE_URL" -f wasitak_$(date +%F).dump     # نسخ
pg_restore -d "$DATABASE_URL" --clean --if-exists wasitak_YYYY-MM-DD.dump   # استعادة
```
خزّن النسخ خارج الخادم (مثلاً تنزيلها لجهازك أسبوعياً).

## الحسابات التجريبية
تُنشأ بعلامة `users.is_demo = true`؛ طلباتها تُوسم تلقائياً `orders.is_demo` وتُستبعد من `real_merchant_transactions` و`real_platform_ledger`. (إنشاؤها الفعلي مؤجل لطبقة التطبيق.)

## وسيطك الذكي (غير مفعل)
الوحدة `smart_wasitak` معطلة و`readiness=db_ready`. المزودون الخارجيون معطلون ولا يمكن تفعيل مدفوع دون تسجيل موافقتك الصريحة (قيد في القاعدة). المزود `local_rules` مجاني بلا ذكاء اصطناعي.

## تشغيل طبقة التطبيق محلياً (محدّث 2026-11-21)
```
pg_ctlcluster 16 main start
db/rebuild_test_db.sh wasitak_demo
cd app && node_modules/.bin/tsx scripts/build-ui.ts
ALLOW_DEMO_SEED=1 WASITAK_LOCAL_DRIVER=1 DATABASE_URL=... node_modules/.bin/tsx scripts/seed-demo.ts
WASITAK_LOCAL_DRIVER=1 PORT=3100 node_modules/.bin/tsx scripts/dev-server.ts
```
حسابات العرض (كلمة المرور Demo#12345): مدير +967770000001، تاجر ...02، مشتري ...03، مندوب ...04. لإنشاء مدير حقيقي: `scripts/create-admin.ts`.
الإنتاج: متغيرات DATABASE_URL (Neon) وBLOB_READ_WRITE_TOKEN؛ لا تُرفع بيانات العرض لقاعدة الإنتاج. لا تُكتب أسرار في المحادثة.
