\set ON_ERROR_STOP on
DROP FUNCTION IF EXISTS _t(text,boolean,text); DROP FUNCTION IF EXISTS _t(text,boolean); DROP FUNCTION IF EXISTS _fails(text,text);
CREATE TEMP TABLE _results(name text, ok boolean);
CREATE FUNCTION _t(p_name text, p_ok boolean) RETURNS void AS $$ BEGIN INSERT INTO _results VALUES (p_name, p_ok); END; $$ LANGUAGE plpgsql;
BEGIN;
INSERT INTO users(role_id, full_name, phone, password_hash) SELECT r.id,x.n,x.ph,'h' FROM (VALUES ('merchant','ت','+967700200001'),('buyer','م','+967700200002'),('product_reviewer','ر','+967700200003')) x(role,n,ph) JOIN roles r ON r.code=x.role;
INSERT INTO merchants(user_id,shop_name,default_currency,status) SELECT id,'م','YER','approved' FROM users WHERE phone='+967700200001';
INSERT INTO customers(user_id) SELECT id FROM users WHERE phone='+967700200002';
INSERT INTO products(merchant_id,category_id,name_ar,merchant_price,currency) SELECT m.id,c.id,'س',5000,'YER' FROM merchants m, categories c WHERE c.slug='men-summer';
INSERT INTO product_variants(product_id,options) SELECT id,'{}' FROM products;
INSERT INTO product_variants(product_id,options,price_delta) SELECT id,'{"size":"XL"}',1000 FROM products;
INSERT INTO inventory(variant_id,quantity) SELECT id,10 FROM product_variants;
INSERT INTO exchange_rates(from_currency,to_currency,rate) VALUES ('SAR','YER',140);
SELECT approve_product((SELECT id FROM products),(SELECT id FROM users WHERE phone='+967700200003'));
SELECT _t('المنتج المعتمد ظاهر في الواجهة العامة بسعر 6000', (SELECT price=6000 FROM public_products));
SELECT _t('الواجهة العامة بلا أي عمود لسعر التاجر/الربح', (SELECT count(*)=0 FROM information_schema.columns WHERE table_name='public_products' AND (column_name LIKE '%merchant_price%' OR column_name LIKE '%markup%')));
UPDATE pricing_rules SET markup_percent=40 WHERE scope='global';
SELECT _t('تغيير النسبة العامة لا يغير السعر في الواجهة العامة', (SELECT price=6000 FROM public_products));
SELECT create_order((SELECT id FROM users WHERE phone='+967700200002'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants WHERE options='{}'),'qty',1)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'),NULL,'ع','+967711111111','ع',NULL,'cod','s1');
SELECT _t('الطلب يُحاسب بالسعر المنشور (6000) لا بالنسبة الجديدة (7000)', (SELECT unit_price=6000 AND markup_percent=20 FROM order_items));
SELECT create_order((SELECT id FROM users WHERE phone='+967700200002'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants WHERE options<>'{}'),'qty',1)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'),NULL,'ع','+967711111111','ع',NULL,'cod','s2');
SELECT _t('خيار بفرق سعر 1000: (5000+1000)×1.2 = 7200', (SELECT unit_price=7200 FROM order_items WHERE unit_price<>6000));
SELECT _t('لا تسرب سعر التاجر: public_products بلا شركة تاجر خاص', (SELECT count(*)=1 FROM public_products));
SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END r, name FROM _results WHERE NOT ok;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM _results;
ROLLBACK;
