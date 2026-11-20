-- ============================================================
-- وسيطك | 003_orders_ledger.sql
-- الطلبات، حالات الطلب، الدفع، الدفتر المالي، مستحقات التجار، السندات
-- ============================================================
BEGIN;

-- ================= المندوبون ورسوم التوصيل =================
CREATE TABLE delivery_agents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- رسوم التوصيل منفصلة تماماً عن ربح وسيطك. المنطقة الأدق تغلب المحافظة.
CREATE TABLE delivery_zones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  governorate_id uuid NOT NULL REFERENCES governorates(id),
  area_id        uuid REFERENCES areas(id),
  fee            numeric(18,2) NOT NULL CHECK (fee >= 0),
  currency       char(3) NOT NULL REFERENCES currencies(code),
  is_active      boolean NOT NULL DEFAULT true,
  UNIQUE NULLS NOT DISTINCT (governorate_id, area_id)
);

-- ================= طرق الدفع (قابلة للتفعيل من الإدارة) =================
CREATE TABLE payment_methods (
  code        text PRIMARY KEY,
  name_ar     text NOT NULL,
  is_enabled  boolean NOT NULL DEFAULT false,
  readiness   module_readiness NOT NULL DEFAULT 'not_implemented',
  CHECK (NOT is_enabled OR readiness <> 'not_implemented')   -- لا تفعيل لطريقة غير منفذة
);

-- ================= الطلبات =================
CREATE TYPE order_status AS ENUM (
  'new','pending_confirmation','confirmed','preparing','ready_for_delivery','out_for_delivery',
  'delivered','cancelled','return_requested','return_processing','return_completed','refunded');

CREATE SEQUENCE order_number_seq;

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number    text NOT NULL UNIQUE DEFAULT ('WS-' || to_char(now(),'YYMMDD') || '-' || lpad(nextval('order_number_seq')::text, 6, '0')),
  idempotency_key text NOT NULL UNIQUE,                 -- يمنع تكرار الطلب عند الضغط المتكرر
  customer_id     uuid NOT NULL REFERENCES customers(id),
  status          order_status NOT NULL DEFAULT 'new',
  agent_id        uuid REFERENCES delivery_agents(id),
  -- بيانات التوصيل
  recipient_name  text NOT NULL,
  recipient_phone text NOT NULL,
  governorate_id  uuid NOT NULL REFERENCES governorates(id),
  area_id         uuid REFERENCES areas(id),
  address_detail  text NOT NULL,
  delivery_notes  text,
  -- لقطة مالية وقت الطلب (لا تتغير)
  currency        char(3) NOT NULL REFERENCES currencies(code),
  subtotal        numeric(18,2) NOT NULL CHECK (subtotal >= 0),
  delivery_fee    numeric(18,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
  total           numeric(18,2) NOT NULL CHECK (total >= 0),
  payment_method  text NOT NULL REFERENCES payment_methods(code),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (total = subtotal + delivery_fee)
);
CREATE INDEX orders_customer_idx ON orders(customer_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX orders_agent_idx ON orders(agent_id) WHERE agent_id IS NOT NULL;
CREATE TRIGGER orders_upd BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- الحقول المالية للطلب غير قابلة للتعديل بعد الإنشاء
CREATE OR REPLACE FUNCTION orders_freeze_money() RETURNS trigger AS $$
BEGIN
  IF OLD.total = 0 AND OLD.subtotal = 0 THEN RETURN NEW; END IF;   -- مرحلة التكوين الأولى داخل create_order فقط
  IF NEW.currency <> OLD.currency OR NEW.subtotal <> OLD.subtotal OR NEW.delivery_fee <> OLD.delivery_fee
     OR NEW.total <> OLD.total OR NEW.customer_id <> OLD.customer_id OR NEW.order_number <> OLD.order_number THEN
    RAISE EXCEPTION 'البيانات المالية للطلب % غير قابلة للتعديل', OLD.order_number;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER orders_freeze BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_freeze_money();

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  variant_id      uuid NOT NULL REFERENCES product_variants(id),
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  product_name    text NOT NULL,                        -- لقطة الاسم
  quantity        integer NOT NULL CHECK (quantity > 0),
  -- لقطة التسعير (بعملة المنتج الأصلية)
  merchant_unit_price numeric(18,2) NOT NULL CHECK (merchant_unit_price >= 0),
  merchant_currency   char(3) NOT NULL REFERENCES currencies(code),
  markup_percent  numeric(7,3),
  markup_unit_amount numeric(18,2) NOT NULL,
  final_unit_price_src numeric(18,2) NOT NULL,          -- بعملة المنتج
  fx_rate         numeric(18,8) NOT NULL CHECK (fx_rate > 0),  -- من عملة المنتج إلى عملة الطلب
  unit_price      numeric(18,2) NOT NULL CHECK (unit_price >= 0),   -- بعملة الطلب (الظاهر للمشتري)
  line_total      numeric(18,2) NOT NULL CHECK (line_total >= 0),
  pricing_rule_id uuid REFERENCES pricing_rules(id)
);
CREATE INDEX order_items_order_idx ON order_items(order_id);
CREATE INDEX order_items_merchant_idx ON order_items(merchant_id);
CREATE TRIGGER order_items_immutable BEFORE UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE order_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  from_status order_status,
  to_status   order_status NOT NULL,
  actor_id    uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX osh_order_idx ON order_status_history(order_id, created_at);
CREATE TRIGGER osh_append_only BEFORE UPDATE OR DELETE ON order_status_history FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- الانتقالات المسموحة بين الحالات
CREATE TABLE order_transitions (
  from_status order_status NOT NULL,
  to_status   order_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

CREATE TYPE payment_status AS ENUM ('pending','collected','failed','refunded');
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id),
  method       text NOT NULL REFERENCES payment_methods(code),
  amount       numeric(18,2) NOT NULL CHECK (amount >= 0),
  currency     char(3) NOT NULL REFERENCES currencies(code),
  status       payment_status NOT NULL DEFAULT 'pending',
  collected_by uuid REFERENCES users(id),
  collected_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_one_per_order ON payments(order_id) WHERE status <> 'failed';
CREATE TRIGGER audit_payments AFTER UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ================= الدفتر المالي (للإلحاق فقط) =================
CREATE TYPE ledger_kind AS ENUM (
  'sale_credit',        -- استحقاق التاجر عند التسليم
  'return_debit',       -- عكس استحقاق عند الإرجاع
  'payout_debit',       -- صرف مستحقات
  'adjustment');        -- قيد تصحيحي موثق

CREATE TABLE merchant_transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id  uuid NOT NULL REFERENCES merchants(id),
  kind         ledger_kind NOT NULL,
  amount       numeric(18,2) NOT NULL CHECK (amount <> 0),   -- موجب = له، سالب = عليه
  currency     char(3) NOT NULL REFERENCES currencies(code),
  order_id     uuid REFERENCES orders(id),
  order_item_id uuid REFERENCES order_items(id),
  payout_id    uuid,
  reverses_id  bigint REFERENCES merchant_transactions(id),  -- للقيود التصحيحية
  note         text,
  actor_id     uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'adjustment' OR (note IS NOT NULL AND actor_id IS NOT NULL))
);
CREATE INDEX mt_merchant_idx ON merchant_transactions(merchant_id, currency);
-- منع استحقاق نفس البند مرتين
CREATE UNIQUE INDEX mt_one_sale_per_item ON merchant_transactions(order_item_id) WHERE kind = 'sale_credit';
CREATE TRIGGER mt_append_only BEFORE UPDATE OR DELETE ON merchant_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- إيرادات المنصة (ربح وسيطك + رسوم التوصيل) — منفصلة عن حسابات التجار
CREATE TABLE platform_ledger (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('markup_revenue','delivery_fee','markup_reversal','adjustment')),
  amount      numeric(18,2) NOT NULL CHECK (amount <> 0),
  currency    char(3) NOT NULL REFERENCES currencies(code),
  order_id    uuid REFERENCES orders(id),
  order_item_id uuid REFERENCES order_items(id),
  note        text,
  actor_id    uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pl_one_markup_per_item ON platform_ledger(order_item_id) WHERE kind = 'markup_revenue';
CREATE UNIQUE INDEX pl_one_fee_per_order ON platform_ledger(order_id) WHERE kind = 'delivery_fee';
CREATE TRIGGER pl_append_only BEFORE UPDATE OR DELETE ON platform_ledger FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- رصيد التاجر لكل عملة (محسوب من الدفتر دائماً، لا يخزن)
CREATE VIEW merchant_balances AS
  SELECT merchant_id, currency, sum(amount) AS balance,
         sum(amount) FILTER (WHERE kind = 'sale_credit')  AS total_sales_credit,
         -sum(amount) FILTER (WHERE kind = 'payout_debit') AS total_paid
  FROM merchant_transactions GROUP BY merchant_id, currency;

-- ================= سندات الصرف والقبض =================
CREATE SEQUENCE payment_voucher_seq;
CREATE SEQUENCE receipt_voucher_seq;

CREATE TABLE payment_vouchers (   -- سند صرف (من وسيطك)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number  text NOT NULL UNIQUE DEFAULT ('PV-' || lpad(nextval('payment_voucher_seq')::text, 6, '0')),
  idempotency_key text NOT NULL UNIQUE,                  -- يمنع تكرار السند
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  amount          numeric(18,2) NOT NULL CHECK (amount > 0),
  currency        char(3) NOT NULL REFERENCES currencies(code),
  method          text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  reason          text NOT NULL,
  related_order_ids uuid[] NOT NULL DEFAULT '{}',
  issued_by       uuid NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','confirmed','disputed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pv_merchant_idx ON payment_vouchers(merchant_id);
CREATE TRIGGER pv_no_delete BEFORE DELETE ON payment_vouchers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_pv AFTER INSERT OR UPDATE ON payment_vouchers FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TABLE receipt_vouchers (   -- سند قبض (من التاجر)
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_number     text NOT NULL UNIQUE DEFAULT ('RV-' || lpad(nextval('receipt_voucher_seq')::text, 6, '0')),
  payment_voucher_id uuid NOT NULL UNIQUE REFERENCES payment_vouchers(id),   -- سند قبض واحد لكل سند صرف
  merchant_id        uuid NOT NULL REFERENCES merchants(id),
  amount             numeric(18,2) NOT NULL CHECK (amount > 0),
  currency           char(3) NOT NULL REFERENCES currencies(code),
  method             text NOT NULL CHECK (method IN ('cash','bank_transfer')),
  received_by        uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rv_append_only BEFORE UPDATE OR DELETE ON receipt_vouchers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_rv AFTER INSERT ON receipt_vouchers FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ================= إنشاء الطلب (ذري) =================
-- p_items: [{"variant_id":"...","qty":2}, ...]
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

    SELECT * INTO pr FROM compute_price(p.id, p_governorate, v.price_delta);   -- التحقق من السعر من الخادم لا من العميل
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

-- ================= تغيير حالة الطلب =================
CREATE OR REPLACE FUNCTION change_order_status(p_order uuid, p_to order_status, p_actor uuid, p_note text DEFAULT NULL)
RETURNS void AS $$
DECLARE o orders%ROWTYPE; it record;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'الطلب غير موجود'; END IF;
  IF NOT EXISTS (SELECT 1 FROM order_transitions WHERE from_status = o.status AND to_status = p_to) THEN
    RAISE EXCEPTION 'انتقال غير مسموح من % إلى %', o.status, p_to;
  END IF;
  PERFORM set_config('app.user_id', p_actor::text, true);

  UPDATE orders SET status = p_to, delivered_at = CASE WHEN p_to = 'delivered' THEN now() ELSE delivered_at END WHERE id = p_order;
  INSERT INTO order_status_history(order_id, from_status, to_status, actor_id, note) VALUES (p_order, o.status, p_to, p_actor, p_note);

  IF p_to = 'cancelled' THEN                      -- إرجاع المخزون المحجوز
    PERFORM set_config('app.order_id', p_order::text, true);
    PERFORM set_config('app.inv_reason', 'order_release', true);
    FOR it IN SELECT variant_id, sum(quantity) q FROM order_items WHERE order_id = p_order GROUP BY variant_id ORDER BY variant_id LOOP
      UPDATE inventory SET quantity = quantity + it.q WHERE variant_id = it.variant_id;
    END LOOP;
    UPDATE payments SET status = 'failed' WHERE order_id = p_order AND status = 'pending';
  ELSIF p_to = 'delivered' THEN                   -- الاستحقاق المالي عند التسليم فقط
    FOR it IN SELECT * FROM order_items WHERE order_id = p_order LOOP
      INSERT INTO merchant_transactions(merchant_id, kind, amount, currency, order_id, order_item_id, actor_id)
      VALUES (it.merchant_id, 'sale_credit', it.merchant_unit_price * it.quantity, it.merchant_currency, p_order, it.id, p_actor);
      IF it.markup_unit_amount <> 0 THEN
        INSERT INTO platform_ledger(kind, amount, currency, order_id, order_item_id, actor_id)
        VALUES ('markup_revenue', it.markup_unit_amount * it.quantity, it.merchant_currency, p_order, it.id, p_actor);
      END IF;
    END LOOP;
    IF o.delivery_fee > 0 THEN
      INSERT INTO platform_ledger(kind, amount, currency, order_id, actor_id) VALUES ('delivery_fee', o.delivery_fee, o.currency, p_order, p_actor);
    END IF;
    UPDATE payments SET status = 'collected', collected_by = p_actor, collected_at = now() WHERE order_id = p_order AND status = 'pending';
  END IF;
END; $$ LANGUAGE plpgsql;

-- ================= صرف مستحقات التاجر =================
CREATE OR REPLACE FUNCTION issue_payment_voucher(
  p_merchant uuid, p_amount numeric, p_currency char(3), p_method text, p_reason text,
  p_orders uuid[], p_actor uuid, p_idempotency_key text
) RETURNS uuid AS $$
DECLARE bal numeric; vid uuid;
BEGIN
  IF NOT user_has_permission(p_actor, 'payouts.create') THEN
    RAISE EXCEPTION 'لا تملك صلاحية صرف المستحقات' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id INTO vid FROM payment_vouchers WHERE idempotency_key = p_idempotency_key;
  IF vid IS NOT NULL THEN RETURN vid; END IF;
  PERFORM 1 FROM merchants WHERE id = p_merchant FOR UPDATE;           -- تسلسل عمليات التاجر الواحد
  SELECT COALESCE(sum(amount),0) INTO bal FROM merchant_transactions WHERE merchant_id = p_merchant AND currency = p_currency;
  IF p_amount > bal THEN
    RAISE EXCEPTION 'المبلغ % أكبر من الرصيد المستحق %', p_amount, bal USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('app.user_id', p_actor::text, true);
  INSERT INTO payment_vouchers(idempotency_key, merchant_id, amount, currency, method, reason, related_order_ids, issued_by)
  VALUES (p_idempotency_key, p_merchant, p_amount, p_currency, p_method, p_reason, COALESCE(p_orders,'{}'), p_actor)
  RETURNING id INTO vid;
  INSERT INTO merchant_transactions(merchant_id, kind, amount, currency, payout_id, actor_id, note)
  VALUES (p_merchant, 'payout_debit', -p_amount, p_currency, vid, p_actor, 'سند صرف');
  RETURN vid;
END; $$ LANGUAGE plpgsql;

-- سند القبض: ينشئه التاجر نفسه صاحب المستحق، ومرة واحدة لكل سند صرف
CREATE OR REPLACE FUNCTION confirm_receipt(p_voucher uuid, p_merchant_user uuid) RETURNS uuid AS $$
DECLARE pv payment_vouchers%ROWTYPE; m merchants%ROWTYPE; rid uuid;
BEGIN
  SELECT * INTO pv FROM payment_vouchers WHERE id = p_voucher FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'سند الصرف غير موجود'; END IF;
  SELECT * INTO m FROM merchants WHERE id = pv.merchant_id;
  IF m.user_id <> p_merchant_user THEN
    RAISE EXCEPTION 'هذا السند ليس لحسابك' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pv.status = 'confirmed' THEN RAISE EXCEPTION 'تم تأكيد استلام هذا السند مسبقاً'; END IF;
  PERFORM set_config('app.user_id', p_merchant_user::text, true);
  INSERT INTO receipt_vouchers(payment_voucher_id, merchant_id, amount, currency, method, received_by)
  VALUES (pv.id, pv.merchant_id, pv.amount, pv.currency, pv.method, p_merchant_user) RETURNING id INTO rid;
  UPDATE payment_vouchers SET status = 'confirmed' WHERE id = pv.id;
  RETURN rid;
END; $$ LANGUAGE plpgsql;

-- قيد تصحيحي موثق بدل الحذف
CREATE OR REPLACE FUNCTION post_merchant_adjustment(p_merchant uuid, p_amount numeric, p_currency char(3),
  p_note text, p_actor uuid, p_reverses bigint DEFAULT NULL) RETURNS bigint AS $$
DECLARE id bigint;
BEGIN
  IF NOT user_has_permission(p_actor, 'accounting.adjust') THEN
    RAISE EXCEPTION 'لا تملك صلاحية القيود التصحيحية' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.user_id', p_actor::text, true);
  INSERT INTO merchant_transactions(merchant_id, kind, amount, currency, reverses_id, note, actor_id)
  VALUES (p_merchant, 'adjustment', p_amount, p_currency, p_reverses, p_note, p_actor) RETURNING merchant_transactions.id INTO id;
  INSERT INTO audit_logs(actor_id, action, entity, entity_id, new_data)
  VALUES (p_actor, 'ledger.adjustment', 'merchant_transactions', id::text, jsonb_build_object('amount', p_amount, 'note', p_note));
  RETURN id;
END; $$ LANGUAGE plpgsql;

COMMIT;
