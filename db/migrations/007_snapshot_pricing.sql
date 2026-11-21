-- ============================================================
-- وسيطك | 007_snapshot_pricing.sql
-- إصلاح: الطلب يجب أن يستخدم لقطة السعر المعتمدة (المنشورة) لا قاعدة التسعير الحية،
-- حتى لا يختلف السعر المحاسَب عن المعروض عند تغيير النسبة العامة دون قرار إعادة تسعير.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION snapshot_price(p_product uuid, p_variant_delta numeric DEFAULT 0)
RETURNS TABLE (merchant_price numeric, currency char(3), markup_percent numeric, markup_amount numeric,
               final_price numeric, rule_id uuid) AS $$
DECLARE p products%ROWTYPE; dec smallint; base numeric;
BEGIN
  SELECT * INTO p FROM products WHERE id = p_product;
  IF NOT FOUND OR p.final_price IS NULL THEN RAISE EXCEPTION 'المنتج غير مسعّر'; END IF;
  SELECT decimals INTO dec FROM currencies WHERE code = p.priced_currency;
  merchant_price := p.priced_merchant_price + p_variant_delta;
  currency := p.priced_currency; markup_percent := p.markup_percent; rule_id := p.priced_rule_id;
  IF p_variant_delta = 0 THEN
    markup_amount := p.markup_amount; final_price := p.final_price;
  ELSE
    base := merchant_price;
    markup_amount := round(base * COALESCE(p.markup_percent, 0) / 100, dec);
    final_price := round(base, dec) + markup_amount;
  END IF;
  RETURN NEXT;
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION create_order(
  p_customer_user uuid, p_items jsonb, p_governorate uuid, p_area uuid,
  p_name text, p_phone text, p_address text, p_notes text,
  p_payment_method text, p_idempotency_key text, p_currency char(3) DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  cust customers%ROWTYPE; gov governorates%ROWTYPE; pm payment_methods%ROWTYPE;
  ord_id uuid; it jsonb; v product_variants%ROWTYPE; p products%ROWTYPE; inv inventory%ROWTYPE;
  pr record; fx numeric; odec smallint; unit numeric; qty int; sub numeric := 0; fee numeric := 0; fee_src numeric; fee_cur char(3);
  ocur char(3); existing uuid; n_items int := 0;
BEGIN
  SELECT id INTO existing FROM orders WHERE idempotency_key = p_idempotency_key;
  IF existing IS NOT NULL THEN RETURN existing; END IF;       -- نفس الطلب: نعيد الموجود

  SELECT * INTO cust FROM customers WHERE user_id = p_customer_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'المشتري غير موجود'; END IF;
  SELECT * INTO gov FROM governorates WHERE id = p_governorate;
  IF NOT FOUND OR NOT gov.is_active OR NOT gov.accepts_orders THEN
    RAISE EXCEPTION 'المحافظة لا تستقبل الطلبات حالياً';
  END IF;
  IF p_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM areas WHERE id = p_area AND is_active AND accepts_orders) THEN
    RAISE EXCEPTION 'المنطقة لا تستقبل الطلبات حالياً';
  END IF;
  SELECT * INTO pm FROM payment_methods WHERE code = p_payment_method;
  IF NOT FOUND OR NOT pm.is_enabled THEN RAISE EXCEPTION 'طريقة الدفع غير مفعلة'; END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'السلة فارغة'; END IF;

  ocur := COALESCE(p_currency, (SELECT code FROM currencies WHERE is_base));
  SELECT decimals INTO odec FROM currencies WHERE code = ocur AND is_active;
  IF odec IS NULL THEN RAISE EXCEPTION 'عملة الطلب غير متاحة'; END IF;

  -- رسوم التوصيل (المنطقة ثم المحافظة)
  SELECT z.fee, z.currency INTO fee_src, fee_cur FROM delivery_zones z
   WHERE z.is_active AND z.governorate_id = p_governorate AND (z.area_id = p_area OR z.area_id IS NULL)
   ORDER BY (z.area_id IS NOT NULL) DESC LIMIT 1;
  IF fee_src IS NOT NULL THEN
    fee := round(fee_src * get_exchange_rate(fee_cur, ocur, p_governorate), odec);
  END IF;

  PERFORM set_config('app.user_id', p_customer_user::text, true);
  INSERT INTO orders(idempotency_key, customer_id, recipient_name, recipient_phone, governorate_id, area_id,
                     address_detail, delivery_notes, currency, subtotal, delivery_fee, total, payment_method)
  VALUES (p_idempotency_key, cust.id, p_name, p_phone, p_governorate, p_area, p_address, p_notes, ocur, 0, 0, 0, p_payment_method)
  RETURNING id INTO ord_id;
  PERFORM set_config('app.order_id', ord_id::text, true);
  PERFORM set_config('app.inv_reason', 'order_reserve', true);

  -- ترتيب ثابت للأقفال لتفادي التشابك: حسب variant_id
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) ORDER BY value->>'variant_id' LOOP
    qty := (it->>'qty')::int;
    IF qty IS NULL OR qty <= 0 THEN RAISE EXCEPTION 'كمية غير صحيحة'; END IF;
    SELECT * INTO v FROM product_variants WHERE id = (it->>'variant_id')::uuid AND is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'الخيار المطلوب غير متاح'; END IF;
    SELECT * INTO p FROM products WHERE id = v.product_id;
    IF p.status <> 'approved' OR NOT p.is_available
       OR NOT EXISTS (SELECT 1 FROM merchants m WHERE m.id = p.merchant_id AND m.status = 'approved') THEN
      RAISE EXCEPTION 'المنتج % غير متاح للطلب', p.name_ar;
    END IF;
    SELECT * INTO inv FROM inventory WHERE variant_id = v.id FOR UPDATE;       -- قفل الصف
    IF NOT FOUND OR inv.quantity < qty THEN
      RAISE EXCEPTION 'الكمية المطلوبة من % غير متوفرة', p.name_ar USING ERRCODE = 'check_violation';
    END IF;
    UPDATE inventory SET quantity = quantity - qty WHERE variant_id = v.id;

    SELECT * INTO pr FROM snapshot_price(p.id, v.price_delta);   -- السعر المنشور المعتمد (لا السعر الحي) = ما رآه المشتري
    fx := get_exchange_rate(pr.currency, ocur, p_governorate);
    unit := round(pr.final_price * fx, odec);
    INSERT INTO order_items(order_id, product_id, variant_id, merchant_id, product_name, quantity,
        merchant_unit_price, merchant_currency, markup_percent, markup_unit_amount, final_unit_price_src,
        fx_rate, unit_price, line_total, pricing_rule_id)
    VALUES (ord_id, p.id, v.id, p.merchant_id, p.name_ar, qty, pr.merchant_price, pr.currency, pr.markup_percent,
        pr.markup_amount, pr.final_price, fx, unit, unit * qty, pr.rule_id);
    sub := sub + unit * qty; n_items := n_items + 1;
  END LOOP;

  -- المجاميع تُكتب مرة واحدة (بعدها يتجمد الطلب مالياً)
  UPDATE orders SET subtotal = sub, delivery_fee = fee, total = sub + fee WHERE id = ord_id;

  INSERT INTO payments(order_id, method, amount, currency) VALUES (ord_id, p_payment_method, sub + fee, ocur);
  INSERT INTO order_status_history(order_id, from_status, to_status, actor_id, note)
  VALUES (ord_id, NULL, 'new', p_customer_user, 'إنشاء الطلب');
  RETURN ord_id;
END; $$ LANGUAGE plpgsql;

COMMIT;
