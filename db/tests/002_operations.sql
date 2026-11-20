\set ON_ERROR_STOP on
DROP FUNCTION IF EXISTS _t(text,boolean,text); DROP FUNCTION IF EXISTS _t(text,boolean); DROP FUNCTION IF EXISTS _fails(text,text);
CREATE TEMP TABLE _results(name text, ok boolean, detail text);
CREATE FUNCTION _t(p_name text, p_ok boolean) RETURNS void AS $$ BEGIN INSERT INTO _results VALUES (p_name, p_ok, ''); END; $$ LANGUAGE plpgsql;
CREATE FUNCTION _fails(p_name text, p_sql text) RETURNS void AS $$
BEGIN BEGIN EXECUTE p_sql; INSERT INTO _results VALUES (p_name,false,'لم يفشل');
EXCEPTION WHEN OTHERS THEN INSERT INTO _results VALUES (p_name,true,SQLERRM); END; END; $$ LANGUAGE plpgsql;

BEGIN;
INSERT INTO users(role_id, full_name, phone, password_hash, is_demo)
SELECT r.id, x.n, x.ph, 'h', x.demo FROM (VALUES
  ('merchant','تاجر','+967700100001',false),('buyer','مشتري','+967700100002',false),
  ('delivery_agent','مندوب','+967700100003',false),('buyer','مشتري تجريبي','+967700100004',true),
  ('buyer','غريب','+967700100005',false)) x(role,n,ph,demo) JOIN roles r ON r.code=x.role;
INSERT INTO merchants(user_id, shop_name, default_currency, status) SELECT id,'م','YER','approved' FROM users WHERE phone='+967700100001';
INSERT INTO customers(user_id) SELECT id FROM users WHERE phone IN ('+967700100002','+967700100004','+967700100005');
INSERT INTO delivery_agents(user_id) SELECT id FROM users WHERE phone='+967700100003';
INSERT INTO products(merchant_id, category_id, name_ar, merchant_price, currency, status)
  SELECT m.id, c.id, 'س', 1000, 'YER', 'pending_review' FROM merchants m, categories c WHERE c.slug='men-summer';
INSERT INTO product_variants(product_id, options) SELECT id,'{}' FROM products;
INSERT INTO inventory(variant_id, quantity) SELECT id, 10 FROM product_variants;
SELECT approve_product((SELECT id FROM products), (SELECT id FROM users WHERE role_id=(SELECT id FROM roles WHERE code='merchant'))) WHERE false;
UPDATE products SET status='approved', final_price=1200 ;  -- تجهيز مباشر للاختبار
-- يحتاج صلاحية؟ لا: هذا تحديث مباشر داخل بيئة الاختبار فقط
INSERT INTO exchange_rates(from_currency,to_currency,rate) VALUES ('SAR','YER',140);

SELECT create_order((SELECT id FROM users WHERE phone='+967700100002'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants),'qty',1)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'),NULL,'ع','+967711111111','ع',NULL,'cod','o1');
SELECT create_order((SELECT id FROM users WHERE phone='+967700100004'),
  jsonb_build_array(jsonb_build_object('variant_id',(SELECT id FROM product_variants),'qty',1)),
  (SELECT id FROM governorates WHERE name_ar='صنعاء'),NULL,'ع','+967711111111','ع',NULL,'cod','o-demo');
SELECT _t('طلب المشتري التجريبي موسوم is_demo فقط', (SELECT is_demo FROM orders WHERE idempotency_key='o-demo') AND NOT (SELECT is_demo FROM orders WHERE idempotency_key='o1'));

-- مرتجع قبل التسليم
SELECT _fails('إرجاع قبل التسليم مرفوض', format($q$INSERT INTO returns(order_id,order_item_id,quantity,reason) SELECT order_id,id,1,'x' FROM order_items WHERE order_id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));
SELECT _fails('تقييم قبل التسليم مرفوض', format($q$INSERT INTO reviews(order_item_id,customer_id,merchant_id,product_id,product_rating) SELECT i.id,o.customer_id,i.merchant_id,i.product_id,5 FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));

-- تتبع قبل البدء/دون إسناد
SELECT _fails('تتبع موقع قبل «خرج للتوصيل» مرفوض', format($q$INSERT INTO agent_locations(order_id,agent_id,lat,lng) VALUES (%L,%L,15.35,44.2)$q$,(SELECT id FROM orders WHERE idempotency_key='o1'),(SELECT id FROM delivery_agents)));

-- تسليم
UPDATE orders SET agent_id=(SELECT id FROM delivery_agents) WHERE idempotency_key='o1';
DO $$ DECLARE o uuid:=(SELECT id FROM orders WHERE idempotency_key='o1'); s uuid:=(SELECT id FROM users WHERE phone='+967700100003'); st order_status;
BEGIN FOREACH st IN ARRAY ARRAY['confirmed','preparing','ready_for_delivery','out_for_delivery']::order_status[] LOOP PERFORM change_order_status(o,st,s); END LOOP; END $$;
INSERT INTO agent_locations(order_id,agent_id,lat,lng) SELECT id,agent_id,15.35,44.2 FROM orders WHERE idempotency_key='o1';
SELECT _t('تتبع الموقع مقبول أثناء التوصيل للمندوب المسند',(SELECT count(*)=1 FROM agent_locations));
SELECT _fails('مندوب آخر لا يرسل موقعاً لطلب غير مسند له', format($q$INSERT INTO agent_locations(order_id,agent_id,lat,lng) VALUES (%L,gen_random_uuid(),1,1)$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));
SELECT change_order_status((SELECT id FROM orders WHERE idempotency_key='o1'),'delivered',(SELECT id FROM users WHERE phone='+967700100003'));
SELECT _fails('تتبع الموقع مرفوض بعد التسليم', format($q$INSERT INTO agent_locations(order_id,agent_id,lat,lng) SELECT id,agent_id,1,1 FROM orders WHERE id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));

-- إرجاع/تقييم بعد التسليم
INSERT INTO returns(order_id,order_item_id,quantity,reason) SELECT order_id,id,1,'اختلاف عن الوصف' FROM order_items WHERE order_id=(SELECT id FROM orders WHERE idempotency_key='o1');
SELECT _t('إرجاع خلال 24 ساعة مقبول',(SELECT count(*)=1 FROM returns));
SELECT _fails('طلب إرجاع مكرر لنفس البند',format($q$INSERT INTO returns(order_id,order_item_id,quantity,reason) SELECT order_id,id,1,'x' FROM order_items WHERE order_id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));
UPDATE orders SET delivered_at = now() - interval '25 hours' WHERE idempotency_key='o1';
DELETE FROM returns;
SELECT _fails('إرجاع بعد 24 ساعة مرفوض',format($q$INSERT INTO returns(order_id,order_item_id,quantity,reason) SELECT order_id,id,1,'x' FROM order_items WHERE order_id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));
INSERT INTO reviews(order_item_id,customer_id,merchant_id,product_id,product_rating)
  SELECT i.id,o.customer_id,i.merchant_id,i.product_id,5 FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.id=(SELECT id FROM orders WHERE idempotency_key='o1');
SELECT _t('تقييم طلب مُسلَّم مقبول',(SELECT count(*)=1 FROM reviews));
SELECT _fails('مشتري آخر لا يقيّم طلب غيره',format($q$INSERT INTO reviews(order_item_id,customer_id,merchant_id,product_id,product_rating) SELECT i.id,(SELECT id FROM customers WHERE user_id=(SELECT id FROM users WHERE phone='+967700100005')),i.merchant_id,i.product_id,1 FROM order_items i WHERE i.order_id=%L$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));

-- المراسلة
INSERT INTO conversations(kind,order_id) SELECT 'order_agent',id FROM orders WHERE idempotency_key='o1';
INSERT INTO conversation_participants SELECT (SELECT id FROM conversations),id FROM users WHERE phone IN ('+967700100002','+967700100003');
INSERT INTO messages(conversation_id,sender_id,body) SELECT (SELECT id FROM conversations),id,'مرحباً' FROM users WHERE phone='+967700100003';
SELECT _t('مشارك يرسل رسالة',(SELECT count(*)=1 FROM messages));
SELECT _fails('غير المشارك لا يرسل رسالة',format($q$INSERT INTO messages(conversation_id,sender_id,body) VALUES (%L,%L,'تسلل')$q$,(SELECT id FROM conversations),(SELECT id FROM users WHERE phone='+967700100005')));
SELECT _fails('محادثة واحدة لكل طلب',format($q$INSERT INTO conversations(kind,order_id) VALUES ('order_agent',%L)$q$,(SELECT id FROM orders WHERE idempotency_key='o1')));

-- الإعلانات: لا أسعار ثابتة
SELECT _t('جداول أسعار الإعلانات والباقات فارغة (لا أسعار في الكود)',(SELECT count(*)=0 FROM advertisement_prices) AND (SELECT count(*)=0 FROM advertisement_packages));
SELECT _fails('رابط إعلان خارجي غير آمن مرفوض',$q$INSERT INTO advertisements(owner_user_id,placement,target_type,target_url) SELECT id,'home_banner','external','javascript:alert(1)' FROM users LIMIT 1$q$);

-- شكوى
SELECT _fails('إغلاق شكوى دون نتيجة ومعالج مرفوض',format($q$INSERT INTO complaints(customer_id,subject,details,status) VALUES ((SELECT id FROM customers LIMIT 1),'a','b','resolved')$q$));

-- وسيطك الذكي: معطل، مجاني افتراضياً، ولا مزود مدفوع دون موافقة
SELECT _t('وحدة وسيطك الذكي معطلة افتراضياً', (SELECT status='disabled' FROM system_modules WHERE code='smart_wasitak'));
SELECT _t('لا باقات ولا أسعار اشتراك في الكود',(SELECT count(*)=0 FROM ai_subscription_plans));
SELECT _fails('تفعيل مزود مدفوع دون موافقة المالك مرفوض',$q$UPDATE ai_providers SET is_enabled=true WHERE code='external_llm'$q$);
SELECT _fails('وحدة وسيطك الذكي لا تفعل لأن التنفيذ غير مكتمل بعد (db_ready فقط)... يجب أن تسمح بالتفعيل فقط بعد الاعتماديات',$q$SELECT 1/0$q$);
DELETE FROM _results WHERE name LIKE 'وحدة وسيطك الذكي لا تفعل%';
SELECT _fails('الاستخدام مرفوض دون اشتراك/وحدة مفعلة',format($q$INSERT INTO ai_usage(merchant_id,kind) VALUES (%L,'image')$q$,(SELECT id FROM merchants)));
UPDATE system_modules SET status='enabled' WHERE code='smart_wasitak';
INSERT INTO ai_subscription_plans(name_ar,period,duration_days,image_quota,is_active) VALUES ('تجريبية','free',30,1,true);
INSERT INTO ai_subscriptions(merchant_id,plan_id,ends_at) SELECT (SELECT id FROM merchants),id,now()+interval '30 days' FROM ai_subscription_plans;
INSERT INTO ai_usage(merchant_id,subscription_id,kind) SELECT (SELECT id FROM merchants),id,'image' FROM ai_subscriptions;
SELECT _t('استهلاك ضمن الحصة مقبول',(SELECT count(*)=1 FROM ai_usage));
SELECT _fails('تجاوز الحصة مرفوض',format($q$INSERT INTO ai_usage(merchant_id,subscription_id,kind) SELECT (SELECT id FROM merchants),id,'image' FROM ai_subscriptions$q$));

SELECT CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name FROM _results WHERE NOT ok;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM _results;
ROLLBACK;
