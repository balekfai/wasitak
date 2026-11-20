-- اختبارات السلامة المالية والمخزنية والصلاحيات على مستوى قاعدة البيانات
-- التشغيل: db/run_tests.sh   (يفشل بأول اختبار خاطئ)
\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE TEMP TABLE _results(name text, ok boolean, detail text);

CREATE FUNCTION _t(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void AS $$
BEGIN INSERT INTO _results VALUES (p_name, p_ok, p_detail); END; $$ LANGUAGE plpgsql;

-- يتوقع فشل أمر SQL
CREATE FUNCTION _fails(p_name text, p_sql text) RETURNS void AS $$
BEGIN
  BEGIN EXECUTE p_sql; PERFORM _t(p_name, false, 'لم يفشل كما هو متوقع');
  EXCEPTION WHEN OTHERS THEN PERFORM _t(p_name, true, SQLERRM); END;
END; $$ LANGUAGE plpgsql;

-- ================= تجهيز بيانات اختبار معزولة (في معاملة تُلغى في النهاية) =================
BEGIN;

CREATE TEMP TABLE _ids(k text PRIMARY KEY, v uuid);

INSERT INTO users(role_id, full_name, phone, password_hash)
SELECT r.id, x.n, x.ph, 'test-hash' FROM (VALUES
  ('super_admin','مدير','+967700000001'),('product_reviewer','مراجع','+967700000002'),
  ('accountant','محاسب','+967700000003'),('order_staff','موظف طلبات','+967700000004'),
  ('merchant','تاجر أ','+967700000005'),('merchant','تاجر ب','+967700000006'),
  ('buyer','مشتري','+967700000007'),('delivery_agent','مندوب','+967700000008')
) x(role,n,ph) JOIN roles r ON r.code = x.role;

INSERT INTO _ids SELECT 'admin', id FROM users WHERE phone='+967700000001';
INSERT INTO _ids SELECT 'reviewer', id FROM users WHERE phone='+967700000002';
INSERT INTO _ids SELECT 'acc', id FROM users WHERE phone='+967700000003';
INSERT INTO _ids SELECT 'staff', id FROM users WHERE phone='+967700000004';
INSERT INTO _ids SELECT 'mA_user', id FROM users WHERE phone='+967700000005';
INSERT INTO _ids SELECT 'mB_user', id FROM users WHERE phone='+967700000006';
INSERT INTO _ids SELECT 'buyer_user', id FROM users WHERE phone='+967700000007';
INSERT INTO _ids SELECT 'agent_user', id FROM users WHERE phone='+967700000008';

INSERT INTO merchants(user_id, shop_name, default_currency, status, governorate_id)
SELECT (SELECT v FROM _ids WHERE k='mA_user'), 'محل أ', 'YER', 'approved', (SELECT id FROM governorates WHERE name_ar='صنعاء');
INSERT INTO merchants(user_id, shop_name, default_currency, status)
SELECT (SELECT v FROM _ids WHERE k='mB_user'), 'محل ب', 'YER', 'approved';
INSERT INTO customers(user_id, governorate_id) SELECT (SELECT v FROM _ids WHERE k='buyer_user'), (SELECT id FROM governorates WHERE name_ar='صنعاء');
INSERT INTO delivery_agents(user_id) SELECT (SELECT v FROM _ids WHERE k='agent_user');

-- سعر صرف: 1 SAR = 140 YER (اختباري فقط ضمن المعاملة)
INSERT INTO exchange_rates(from_currency, to_currency, rate) VALUES ('SAR','YER',140);

-- رسوم توصيل صنعاء 1000 ريال
INSERT INTO delivery_zones(governorate_id, fee, currency) SELECT id, 1000, 'YER' FROM governorates WHERE name_ar='صنعاء';

-- منتج بسعر تاجر 5000 (المثال في المتطلبات)
INSERT INTO products(merchant_id, category_id, name_ar, merchant_price, currency, status)
SELECT m.id, c.id, 'منتج اختبار', 5000, 'YER', 'pending_review'
FROM merchants m, categories c WHERE m.shop_name='محل أ' AND c.slug='men-summer';

INSERT INTO product_variants(product_id, options) SELECT id, '{}' FROM products WHERE name_ar='منتج اختبار';
INSERT INTO inventory(variant_id, quantity) SELECT id, 5 FROM product_variants;

-- ================= 1) التسعير =================
SELECT _t('تسعير: 5000 -> 6000 (زيادة 20% على سعر التاجر)',
  (SELECT final_price = 6000 AND markup_amount = 1000 AND markup_percent = 20
   FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));

-- الأكثر تخصيصاً يغلب: قاعدة تاجر 10% ثم قسم 30% ثم منتج 50%
INSERT INTO pricing_rules(scope, merchant_id, markup_percent) SELECT 'merchant', id, 10 FROM merchants WHERE shop_name='محل أ';
SELECT _t('أولوية: التاجر 10% يغلب العام 20%',
  (SELECT markup_percent = 10 FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));
INSERT INTO pricing_rules(scope, category_id, markup_percent) SELECT 'category', id, 30 FROM categories WHERE slug='men-clothing';
SELECT _t('أولوية: قسم الأب 30% يغلب التاجر 10%',
  (SELECT markup_percent = 30 FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));
INSERT INTO pricing_rules(scope, product_id, markup_percent) SELECT 'product', id, 50 FROM products WHERE name_ar='منتج اختبار';
SELECT _t('أولوية: المنتج 50% الأعلى تخصيصاً',
  (SELECT final_price = 7500 FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));
INSERT INTO pricing_rules(scope, product_id, is_excluded) SELECT 'product', id, true FROM products WHERE name_ar='منتج اختبار';
SELECT _t('استثناء المنتج يعيد للقاعدة الأعم (القسم 30%)',
  (SELECT markup_percent = 30 FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));
-- نظف القواعد الخاصة للمتابعة بالـ 20% العامة
DELETE FROM pricing_rules WHERE scope <> 'global';
SELECT _t('بعد حذف القواعد الخاصة: يعود 20%',
  (SELECT final_price = 6000 FROM compute_price((SELECT id FROM products WHERE name_ar='منتج اختبار'))));

-- ================= 2) المراجعة والصلاحيات =================
SELECT _fails('موظف طلبات لا يستطيع اعتماد منتج',
  format('SELECT approve_product(%L, %L)', (SELECT id FROM products WHERE name_ar='منتج اختبار'), (SELECT v FROM _ids WHERE k='staff')));
SELECT _fails('تاجر لا يستطيع اعتماد منتجه',
  format('SELECT approve_product(%L, %L)', (SELECT id FROM products WHERE name_ar='منتج اختبار'), (SELECT v FROM _ids WHERE k='mA_user')));
SELECT _fails('منتج غير معتمد لا يمكن شراؤه',
  format($q$SELECT create_order(%L, %L::jsonb, %L, NULL, 'م','+967711111111','عنوان',NULL,'cod','k-unapproved')$q$,
    (SELECT v FROM _ids WHERE k='buyer_user'),
    jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',1))::text,
    (SELECT id FROM governorates WHERE name_ar='صنعاء')));
SELECT approve_product((SELECT id FROM products WHERE name_ar='منتج اختبار'), (SELECT v FROM _ids WHERE k='reviewer'));
SELECT _t('المراجع يعتمد المنتج ويحفظ لقطة السعر',
  (SELECT status='approved' AND final_price=6000 AND priced_merchant_price=5000 AND markup_amount=1000 AND priced_at IS NOT NULL
   FROM products WHERE name_ar='منتج اختبار'));

-- تغيير النسبة العامة لا يغير سعر المنتج المنشور
UPDATE pricing_rules SET markup_percent = 40 WHERE scope='global';
SELECT _t('تغيير النسبة العامة لا يغير السعر المنشور تلقائياً',
  (SELECT final_price = 6000 FROM products WHERE name_ar='منتج اختبار'));
UPDATE pricing_rules SET markup_percent = 20 WHERE scope='global';

-- ================= 3) الطلب والمخزون =================
SELECT create_order((SELECT v FROM _ids WHERE k='buyer_user'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',2)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'), NULL, 'أحمد','+967711111111','شارع الستين',NULL,'cod','order-key-1');
SELECT _t('الطلب: المجموع 12000 + توصيل 1000 = 13000',
  (SELECT subtotal=12000 AND delivery_fee=1000 AND total=13000 AND status='new' FROM orders WHERE idempotency_key='order-key-1'));
SELECT _t('المخزون خُصم 5 -> 3', (SELECT quantity=3 FROM inventory));
SELECT _t('حركة المخزون سُجلت مع المنفذ والطلب',
  (SELECT count(*)=1 FROM inventory_movements WHERE reason='order_reserve' AND delta=-2 AND actor_id IS NOT NULL AND order_id IS NOT NULL));

-- تكرار الضغط: نفس المفتاح يعيد نفس الطلب ولا يخصم مرة ثانية
SELECT create_order((SELECT v FROM _ids WHERE k='buyer_user'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',2)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'), NULL, 'أحمد','+967711111111','شارع الستين',NULL,'cod','order-key-1');
SELECT _t('منع الطلب المكرر (idempotency)',
  (SELECT count(*)=1 FROM orders WHERE idempotency_key='order-key-1') AND (SELECT quantity=3 FROM inventory));

SELECT _fails('منع البيع بأكثر من المتوفر (طلب 4 والمتاح 3)',
  format($q$SELECT create_order(%L, %L::jsonb, %L, NULL, 'م','+967711111111','ع',NULL,'cod','k-oversell')$q$,
    (SELECT v FROM _ids WHERE k='buyer_user'),
    jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',4))::text,
    (SELECT id FROM governorates WHERE name_ar='صنعاء')));
SELECT _t('فشل الطلب لم يترك أثراً (المخزون ما زال 3)', (SELECT quantity=3 FROM inventory));
SELECT _fails('طريقة دفع غير مفعلة (الكريمي) مرفوضة',
  format($q$SELECT create_order(%L, %L::jsonb, %L, NULL, 'م','+967711111111','ع',NULL,'kuraimi','k-wallet')$q$,
    (SELECT v FROM _ids WHERE k='buyer_user'),
    jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',1))::text,
    (SELECT id FROM governorates WHERE name_ar='صنعاء')));
SELECT _fails('محافظة غير مفعلة (عدن) لا تستقبل طلبات',
  format($q$SELECT create_order(%L, %L::jsonb, %L, NULL, 'م','+967711111111','ع',NULL,'cod','k-gov')$q$,
    (SELECT v FROM _ids WHERE k='buyer_user'),
    jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',1))::text,
    (SELECT id FROM governorates WHERE name_ar='عدن')));
SELECT _fails('لا تعديل مباشر لمخزون بكمية سالبة',
  'UPDATE inventory SET quantity = -1');

-- تغيير سعر التاجر لاحقاً لا يغير الطلب القديم
UPDATE products SET merchant_price = 9000 WHERE name_ar='منتج اختبار';
SELECT _t('تغيير سعر المنتج لا يغير بنود الطلب القديم',
  (SELECT unit_price=6000 AND merchant_unit_price=5000 FROM order_items LIMIT 1));
UPDATE products SET merchant_price = 5000 WHERE name_ar='منتج اختبار';
SELECT _fails('لا يمكن تعديل مجاميع الطلب بعد إنشائه',
  'UPDATE orders SET total = 1 WHERE idempotency_key = ''order-key-1''');
SELECT _fails('لا يمكن تعديل بنود الطلب', 'UPDATE order_items SET quantity = 9');
SELECT _fails('لا يمكن حذف طلب', 'DELETE FROM orders');
SELECT _fails('لا يمكن حذف منتج', 'DELETE FROM products');

-- ================= 4) حالات الطلب والإلغاء =================
SELECT _fails('انتقال غير مسموح new -> delivered',
  format('SELECT change_order_status(%L,''delivered'',%L)', (SELECT id FROM orders LIMIT 1), (SELECT v FROM _ids WHERE k='staff')));

-- طلب ثانٍ للإلغاء: المخزون يعود
SELECT create_order((SELECT v FROM _ids WHERE k='buyer_user'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants LIMIT 1),'qty',1)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'), NULL, 'أحمد','+967711111111','ع',NULL,'cod','order-key-2');
SELECT _t('بعد طلب ثانٍ المخزون 2', (SELECT quantity=2 FROM inventory));
SELECT change_order_status((SELECT id FROM orders WHERE idempotency_key='order-key-2'),'cancelled',(SELECT v FROM _ids WHERE k='staff'),'اختبار إلغاء');
SELECT _t('الإلغاء أعاد المخزون إلى 3', (SELECT quantity=3 FROM inventory));
SELECT _t('الإلغاء لم ينشئ قيوداً مالية',
  (SELECT count(*)=0 FROM merchant_transactions WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='order-key-2')));

-- ================= 5) التسليم والمحاسبة =================
DO $$
DECLARE o uuid := (SELECT id FROM orders WHERE idempotency_key='order-key-1'); s uuid := (SELECT v FROM _ids WHERE k='staff');
BEGIN
  PERFORM change_order_status(o,'confirmed',s); PERFORM change_order_status(o,'preparing',s);
  PERFORM change_order_status(o,'ready_for_delivery',s); PERFORM change_order_status(o,'out_for_delivery',s);
  PERFORM change_order_status(o,'delivered',s);
END $$;
SELECT _t('تسجيل تاريخ التسليم', (SELECT delivered_at IS NOT NULL FROM orders WHERE idempotency_key='order-key-1'));
SELECT _t('سجل الحالات يحتوي كل الانتقالات مع المنفذ',
  (SELECT count(*)=6 AND bool_and(actor_id IS NOT NULL) FROM order_status_history WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='order-key-1')));
SELECT _t('مستحق التاجر = 2×5000 = 10000',
  (SELECT balance=10000 FROM merchant_balances WHERE currency='YER'));
SELECT _t('ربح وسيطك = 2×1000 = 2000 ورسوم التوصيل 1000 منفصلة',
  (SELECT sum(amount) FILTER (WHERE kind='markup_revenue')=2000 AND sum(amount) FILTER (WHERE kind='delivery_fee')=1000 FROM platform_ledger));
SELECT _t('الدفع عند الاستلام سُجل كمحصّل', (SELECT status='collected' AND amount=13000 FROM payments WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='order-key-1')));
SELECT _t('توازن: مبيعات المشتري (12000) = مستحق التاجر + ربح المنصة',
  (SELECT 12000 = (SELECT sum(amount) FROM merchant_transactions WHERE kind='sale_credit') + (SELECT sum(amount) FROM platform_ledger WHERE kind='markup_revenue')));
SELECT _fails('منع استحقاق مزدوج لنفس البند',
  'INSERT INTO merchant_transactions(merchant_id,kind,amount,currency,order_item_id) SELECT merchant_id,''sale_credit'',1,''YER'',id FROM order_items LIMIT 1');
SELECT _fails('الدفتر المالي لا يقبل التعديل', 'UPDATE merchant_transactions SET amount = 1');
SELECT _fails('الدفتر المالي لا يقبل الحذف', 'DELETE FROM merchant_transactions');
SELECT _fails('دفتر المنصة لا يقبل التعديل', 'UPDATE platform_ledger SET amount = 1');
SELECT _fails('سجل التدقيق لا يقبل الحذف', 'DELETE FROM audit_logs');

-- ================= 6) سندات الصرف والقبض =================
SELECT _fails('موظف طلبات لا يصرف مستحقات',
  format($q$SELECT issue_payment_voucher(%L,100,'YER','cash','x','{}',%L,'pv-bad')$q$,
    (SELECT id FROM merchants WHERE shop_name='محل أ'), (SELECT v FROM _ids WHERE k='staff')));
SELECT _fails('صرف أكبر من الرصيد مرفوض (10000 متاح)',
  format($q$SELECT issue_payment_voucher(%L,10001,'YER','cash','x','{}',%L,'pv-over')$q$,
    (SELECT id FROM merchants WHERE shop_name='محل أ'), (SELECT v FROM _ids WHERE k='acc')));
SELECT issue_payment_voucher((SELECT id FROM merchants WHERE shop_name='محل أ'),4000,'YER','cash','صرف جزئي',
  ARRAY[(SELECT id FROM orders WHERE idempotency_key='order-key-1')],(SELECT v FROM _ids WHERE k='acc'),'pv-1');
SELECT _t('صرف جزئي 4000 -> المتبقي 6000',(SELECT balance=6000 AND total_paid=4000 FROM merchant_balances WHERE currency='YER'));
SELECT issue_payment_voucher((SELECT id FROM merchants WHERE shop_name='محل أ'),4000,'YER','cash','صرف جزئي',
  '{}',(SELECT v FROM _ids WHERE k='acc'),'pv-1');
SELECT _t('تكرار سند الصرف بنفس المفتاح لا ينشئ سنداً ولا خصماً ثانياً',
  (SELECT count(*)=1 FROM payment_vouchers) AND (SELECT balance=6000 FROM merchant_balances WHERE currency='YER'));
SELECT _fails('تاجر آخر لا يؤكد استلام سند غيره',
  format('SELECT confirm_receipt(%L,%L)', (SELECT id FROM payment_vouchers LIMIT 1), (SELECT v FROM _ids WHERE k='mB_user')));
SELECT confirm_receipt((SELECT id FROM payment_vouchers LIMIT 1),(SELECT v FROM _ids WHERE k='mA_user'));
SELECT _t('التاجر صاحب الحساب أكد الاستلام وصار السند confirmed',
  (SELECT status='confirmed' FROM payment_vouchers LIMIT 1) AND (SELECT count(*)=1 FROM receipt_vouchers));
SELECT _fails('لا سند قبض ثانٍ لنفس سند الصرف',
  format('SELECT confirm_receipt(%L,%L)', (SELECT id FROM payment_vouchers LIMIT 1), (SELECT v FROM _ids WHERE k='mA_user')));
SELECT _fails('سند الصرف لا يحذف', 'DELETE FROM payment_vouchers');

-- قيد تصحيحي موثق
SELECT _fails('قيد تصحيحي بدون صلاحية', format($q$SELECT post_merchant_adjustment(%L,-100,'YER','ملاحظة',%L)$q$,
  (SELECT id FROM merchants WHERE shop_name='محل أ'),(SELECT v FROM _ids WHERE k='staff')));
SELECT post_merchant_adjustment((SELECT id FROM merchants WHERE shop_name='محل أ'),-500,'YER','تصحيح خطأ إدخال',(SELECT v FROM _ids WHERE k='acc'));
SELECT _t('القيد التصحيحي عدّل الرصيد بدون حذف (6000 -> 5500)',(SELECT balance=5500 FROM merchant_balances WHERE currency='YER'));

-- ================= 7) الوحدات =================
SELECT _fails('لا تعطيل لوحدة أساسية', $q$UPDATE system_modules SET status='disabled' WHERE code='orders'$q$);
SELECT _fails('لا تفعيل لوحدة لم تنفذ بعد (شركات التوصيل)', $q$UPDATE system_modules SET status='enabled' WHERE code='delivery_companies'$q$);
SELECT _fails('لا تفعيل لوحدة تعتمد على وحدة معطلة (fx_advanced تحتاج currencies_mgmt)', $q$UPDATE system_modules SET status='enabled' WHERE code='fx_advanced'$q$);
UPDATE system_modules SET status='enabled' WHERE code='currencies_mgmt';
UPDATE system_modules SET status='enabled' WHERE code='fx_advanced';
SELECT _fails('لا تعطيل وحدة يعتمد عليها وحدة مفعلة', $q$UPDATE system_modules SET status='disabled' WHERE code='currencies_mgmt'$q$);
SELECT _t('صلاحيات الوحدة تعمل فقط عند التفعيل',
  NOT user_has_permission((SELECT v FROM _ids WHERE k='admin'),'regions.manage')
  AND user_has_permission((SELECT v FROM _ids WHERE k='admin'),'fx.manage'));
UPDATE system_modules SET status='disabled' WHERE code='fx_advanced';
SELECT _t('بعد تعطيل الوحدة تختفي صلاحياتها وتبقى بياناتها',
  NOT user_has_permission((SELECT v FROM _ids WHERE k='admin'),'fx.manage') AND (SELECT count(*)>=1 FROM exchange_rates));
SELECT _t('تدقيق تفعيل/تعطيل الوحدات مسجل',(SELECT count(*)>=3 FROM audit_logs WHERE entity='system_modules'));

-- ================= 8) الصلاحيات =================
SELECT _t('محاسب بلا صلاحية مراجعة المنتجات',NOT user_has_permission((SELECT v FROM _ids WHERE k='acc'),'products.review'));
SELECT _t('مراجع منتجات بلا صلاحية الصرف',NOT user_has_permission((SELECT v FROM _ids WHERE k='reviewer'),'payouts.create'));
SELECT _t('مدير النظام لديه صلاحية إدارة الوحدات',user_has_permission((SELECT v FROM _ids WHERE k='admin'),'modules.manage'));
SELECT _t('تاجر/مشتري بلا أي صلاحية إدارية',
  NOT user_has_permission((SELECT v FROM _ids WHERE k='mA_user'),'orders.manage') AND NOT user_has_permission((SELECT v FROM _ids WHERE k='buyer_user'),'accounting.view'));
UPDATE users SET status='suspended' WHERE id=(SELECT v FROM _ids WHERE k='admin');
SELECT _t('حساب موقوف يفقد كل الصلاحيات',NOT user_has_permission((SELECT v FROM _ids WHERE k='admin'),'modules.manage'));
SELECT _fails('لا حذف فعلي للمستخدمين','DELETE FROM users');
SELECT _fails('لا حذف لدور نظام',$q$DELETE FROM roles WHERE code='buyer'$q$);

-- ================= 9) الأقسام =================
SELECT _fails('لا حذف لقسم فيه منتجات',$q$DELETE FROM categories WHERE slug='men-summer'$q$);
SELECT _fails('لا دورة في شجرة الأقسام',$q$UPDATE categories SET parent_id=(SELECT id FROM categories WHERE slug='men-summer') WHERE slug='men-clothing'$q$);

-- ================= النتيجة =================
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name FROM _results ORDER BY ok, name;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM _results;
ROLLBACK;
