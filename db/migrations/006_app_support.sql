-- ============================================================
-- وسيطك | 006_app_support.sql
-- دعم التطبيق: واجهة عامة آمنة للمنتجات (بلا سعر التاجر)، صلاحية الدخول للإدارة
-- ============================================================
BEGIN;

-- سعر صرف آمن: يعيد NULL بدل رفع استثناء
CREATE OR REPLACE FUNCTION safe_exchange_rate(p_from char(3), p_to char(3), p_gov uuid DEFAULT NULL)
RETURNS numeric AS $$
BEGIN
  RETURN get_exchange_rate(p_from, p_to, p_gov);
EXCEPTION WHEN others THEN RETURN NULL;
END; $$ LANGUAGE plpgsql STABLE;

-- الواجهة العامة للمنتجات: لا تحتوي أي عمود لسعر التاجر أو الربح أو القواعد.
-- السعر المعروض = السعر النهائي المحفوظ عند الاعتماد، محوّلاً للعملة الأساسية.
CREATE VIEW public_products AS
SELECT p.id, p.name_ar, p.description, p.details, p.category_id,
       p.merchant_id, m.shop_name,
       round(p.final_price * safe_exchange_rate(p.priced_currency, b.code), b.decimals) AS price,
       b.code AS currency,
       (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.created_at LIMIT 1) AS image_url,
       EXISTS (SELECT 1 FROM product_variants v JOIN inventory i ON i.variant_id = v.id
               WHERE v.product_id = p.id AND v.is_active AND i.quantity > 0) AS in_stock,
       (SELECT round(avg(r.product_rating)::numeric, 1) FROM reviews r WHERE r.product_id = p.id AND r.is_visible) AS avg_rating,
       (SELECT count(*) FROM reviews r WHERE r.product_id = p.id AND r.is_visible) AS review_count,
       p.created_at
FROM products p
JOIN merchants m ON m.id = p.merchant_id AND m.status = 'approved'
JOIN categories c ON c.id = p.category_id AND c.is_active
CROSS JOIN (SELECT code, decimals FROM currencies WHERE is_base) b
WHERE p.status = 'approved' AND p.is_available AND p.final_price IS NOT NULL
  AND safe_exchange_rate(p.priced_currency, b.code) IS NOT NULL;

-- صلاحية دخول لوحة الإدارة (لكل أدوار الموظفين، ولا تمنح للتاجر/المشتري/المندوب)
INSERT INTO permissions(code, name_ar) VALUES ('admin.access','دخول لوحة الإدارة');
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p
 WHERE p.code = 'admin.access' AND r.code IN ('super_admin','admin_staff','product_reviewer','order_staff','accountant','support_staff');

COMMIT;
