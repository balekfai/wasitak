-- ============================================================
-- وسيطك | 004_seed_structure.sql
-- بيانات هيكلية/إعدادية فقط (أدوار، صلاحيات، وحدات، انتقالات، عملات، محافظات).
-- لا توجد بيانات تجريبية: لا تجار ولا منتجات ولا أسعار صرف ولا أسعار إعلانات.
-- ============================================================
BEGIN;

-- ---------- العملات (الأساسية: ريال يمني قديم) ----------
INSERT INTO currencies(code, name_ar, symbol, decimals, is_base) VALUES
  ('YER','ريال يمني','ر.ي',0,true),
  ('SAR','ريال سعودي','ر.س',2,false);

INSERT INTO countries(iso2, name_ar) VALUES ('YE','اليمن');

-- ---------- المحافظات: كل محافظات الجمهورية في القاعدة، والعشر الأولى فقط مفعلة ----------
INSERT INTO governorates(country_id, name_ar, is_active, accepts_orders, sort_order)
SELECT c.id, g.name, g.active, g.active, g.ord FROM countries c, (VALUES
  ('أمانة العاصمة',true,1),('صنعاء',true,2),('إب',true,3),('تعز',true,4),('الحديدة',true,5),
  ('ذمار',true,6),('عمران',true,7),('صعدة',true,8),('حجة',true,9),('المحويت',true,10),('البيضاء',true,11),
  ('عدن',false,20),('لحج',false,21),('أبين',false,22),('شبوة',false,23),('حضرموت',false,24),
  ('المهرة',false,25),('مأرب',false,26),('الجوف',false,27),('الضالع',false,28),('ريمة',false,29),('سقطرى',false,30)
) AS g(name, active, ord) WHERE c.iso2 = 'YE';

-- ---------- الأدوار ----------
INSERT INTO roles(code, name_ar, is_system) VALUES
  ('super_admin','مدير النظام',true),('admin_staff','موظف الإدارة',true),
  ('product_reviewer','موظف مراجعة المنتجات',true),('order_staff','موظف الطلبات',true),
  ('accountant','المحاسب',true),('support_staff','موظف خدمة العملاء',true),
  ('delivery_agent','مندوب التوصيل',true),('merchant','التاجر',true),('buyer','المشتري',true);

-- ---------- الوحدات ----------
-- readiness: complete = منفذة ومختبرة؛ db_ready = قاعدة البيانات جاهزة فقط؛ not_implemented = لم تنفذ.
INSERT INTO system_modules(code, name_ar, description, is_core, status, readiness) VALUES
  ('core','النواة','المستخدمون والصلاحيات والتدقيق',true,'enabled','complete'),
  ('catalog','الكتالوج والتسعير','التجار والأقسام والمنتجات والمخزون والتسعير التلقائي',true,'enabled','complete'),
  ('orders','الطلبات','السلة والطلبات والدفع عند الاستلام',true,'enabled','complete'),
  ('accounting','المحاسبة','الدفتر ومستحقات التجار وسندات الصرف والقبض',true,'enabled','complete'),
  ('regions_ext','إدارة المحافظات والمناطق الموسعة','مديريات ومناطق وأحياء وقرى',false,'disabled','db_ready'),
  ('currencies_mgmt','إدارة العملات','إضافة عملات وتحديد العملة لكل منطقة',false,'disabled','db_ready'),
  ('fx_advanced','إدارة أسعار الصرف المتقدمة','أسعار صرف حسب المنطقة وسجل التغييرات',false,'disabled','db_ready'),
  ('delivery_companies','شركات التوصيل الخارجية','إسناد وتتبع الشحنات لدى شركات خارجية',false,'disabled','not_implemented'),
  ('payment_wallets','المحافظ الإلكترونية','الكريمي وجوالي وون كاش — لا تكامل فعلي بعد',false,'disabled','not_implemented'),
  ('ads_ext','توسع الإعلانات والباقات','باقات وخصومات وأسعار مخصصة',false,'disabled','not_implemented'),
  ('merchant_services','خدمات إضافية للتجار','',false,'disabled','not_implemented'),
  ('analytics_adv','تقارير وتحليلات متقدمة','',false,'disabled','not_implemented');

INSERT INTO module_dependencies(module_code, depends_on_code) VALUES
  ('fx_advanced','currencies_mgmt'),
  ('delivery_companies','regions_ext'),
  ('payment_wallets','accounting'),
  ('ads_ext','catalog'),
  ('analytics_adv','accounting');

-- ---------- الصلاحيات ----------
INSERT INTO permissions(code, name_ar, module_code) VALUES
  ('users.manage','إدارة المستخدمين',NULL),
  ('roles.manage','إدارة الأدوار والصلاحيات',NULL),
  ('modules.manage','إدارة وحدات النظام',NULL),
  ('merchants.review','مراجعة طلبات التجار',NULL),
  ('merchants.manage','إدارة التجار',NULL),
  ('categories.manage','إدارة الأقسام',NULL),
  ('products.review','مراجعة المنتجات',NULL),
  ('pricing.manage','إدارة قواعد التسعير',NULL),
  ('inventory.adjust','تعديل المخزون',NULL),
  ('orders.view','عرض الطلبات',NULL),
  ('orders.manage','إدارة الطلبات',NULL),
  ('orders.assign','إسناد الطلبات للمندوبين',NULL),
  ('payouts.create','صرف مستحقات التجار',NULL),
  ('accounting.view','عرض الحسابات',NULL),
  ('accounting.adjust','القيود التصحيحية',NULL),
  ('audit.view','عرض سجل التدقيق',NULL),
  ('support.manage','خدمة العملاء والشكاوى',NULL),
  ('currencies.manage','إدارة العملات','currencies_mgmt'),
  ('fx.manage','إدارة أسعار الصرف المتقدمة','fx_advanced'),
  ('regions.manage','إدارة المناطق الموسعة','regions_ext');

-- مدير النظام: كل الصلاحيات
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'super_admin';

INSERT INTO role_permissions SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN
  ('merchants.review','merchants.manage','categories.manage','orders.view','orders.manage','orders.assign','support.manage','users.manage')
  WHERE r.code = 'admin_staff';
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('products.review','categories.manage')
  WHERE r.code = 'product_reviewer';
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('orders.view','orders.manage','orders.assign')
  WHERE r.code = 'order_staff';
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('accounting.view','accounting.adjust','payouts.create','orders.view')
  WHERE r.code = 'accountant';
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN ('support.manage','orders.view')
  WHERE r.code = 'support_staff';

-- ---------- انتقالات حالات الطلب ----------
INSERT INTO order_transitions VALUES
  ('new','pending_confirmation'),('new','confirmed'),('new','cancelled'),
  ('pending_confirmation','confirmed'),('pending_confirmation','cancelled'),
  ('confirmed','preparing'),('confirmed','cancelled'),
  ('preparing','ready_for_delivery'),('preparing','cancelled'),
  ('ready_for_delivery','out_for_delivery'),('ready_for_delivery','cancelled'),
  ('out_for_delivery','delivered'),('out_for_delivery','cancelled'),
  ('delivered','return_requested'),
  ('return_requested','return_processing'),
  ('return_processing','return_completed'),
  ('return_completed','refunded');

-- ---------- طرق الدفع ----------
INSERT INTO payment_methods(code, name_ar, is_enabled, readiness) VALUES
  ('cod','الدفع عند الاستلام',true,'complete'),
  ('kuraimi','الكريمي',false,'not_implemented'),
  ('jawwali','جوالي',false,'not_implemented'),
  ('onecash','ون كاش',false,'not_implemented');

-- ---------- التسعير الافتراضي: +20% على سعر التاجر (قابلة للتعديل من الإدارة) ----------
INSERT INTO pricing_rules(scope, markup_percent) VALUES ('global', 20);

-- ---------- أقسام أولية (قابلة للتعديل/الحذف من لوحة الإدارة) ----------
INSERT INTO categories(name_ar, slug, sort_order, show_on_home, is_restricted, requires_license) VALUES
  ('الصيدليات','pharmacies',1,true,true,true),
  ('الملابس الرجالية','men-clothing',2,true,false,false),
  ('الملابس النسائية','women-clothing',3,true,false,false),
  ('ملابس الأطفال','kids-clothing',4,true,false,false),
  ('الإلكترونيات','electronics',5,true,false,false),
  ('العطور ومستحضرات التجميل','perfumes-cosmetics',6,true,false,false),
  ('الأدوات المنزلية والمطبخ','home-kitchen',7,true,false,false),
  ('المواد الغذائية','groceries',8,true,false,false),
  ('الأحذية والحقائب','shoes-bags',9,false,false,false),
  ('مستلزمات السيارات','auto-supplies',10,false,false,false);

INSERT INTO categories(parent_id, name_ar, slug, sort_order, is_restricted, requires_license)
SELECT p.id, s.name, s.slug, s.ord, s.restricted, s.restricted FROM categories p JOIN (VALUES
  ('pharmacies','الأدوية المسموح ببيعها','pharm-meds',1,true),
  ('pharmacies','المستلزمات الصحية','pharm-health',2,false),
  ('pharmacies','منتجات العناية الشخصية','pharm-care',3,false),
  ('pharmacies','مستلزمات الأطفال','pharm-kids',4,false),
  ('men-clothing','صيفية','men-summer',1,false),('men-clothing','شتوية','men-winter',2,false),
  ('men-clothing','رسمية','men-formal',3,false),('men-clothing','رياضية','men-sport',4,false),
  ('men-clothing','أحذية','men-shoes',5,false),('men-clothing','إكسسوارات','men-acc',6,false),
  ('women-clothing','صيفية','wom-summer',1,false),('women-clothing','شتوية','wom-winter',2,false),
  ('women-clothing','فساتين','wom-dresses',3,false),('women-clothing','عبايات','wom-abaya',4,false),
  ('women-clothing','ملابس منزلية','wom-home',5,false),('women-clothing','رياضية','wom-sport',6,false),
  ('women-clothing','حقائب','wom-bags',7,false),('women-clothing','أحذية','wom-shoes',8,false),
  ('kids-clothing','أولاد','kids-boys',1,false),('kids-clothing','بنات','kids-girls',2,false),
  ('kids-clothing','صيفية','kids-summer',3,false),('kids-clothing','شتوية','kids-winter',4,false)
) AS s(parent_slug, name, slug, ord, restricted) ON p.slug = s.parent_slug;

COMMIT;
