-- ============================================================
-- وسيطك | 002_catalog.sql
-- التجار، الأقسام، المنتجات، المخزون، قواعد التسعير
-- ============================================================
BEGIN;

-- ================= التجار والعملاء والموظفون =================
CREATE TYPE merchant_status AS ENUM ('pending','approved','rejected','suspended');

CREATE TABLE merchants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL UNIQUE REFERENCES users(id),
  shop_name       text NOT NULL,
  logo_url        text,
  description     text,
  governorate_id  uuid REFERENCES governorates(id),
  area_id         uuid REFERENCES areas(id),
  address         text,
  default_currency char(3) NOT NULL REFERENCES currencies(code),
  status          merchant_status NOT NULL DEFAULT 'pending',
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  rejection_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER merchants_upd BEFORE UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER merchants_no_delete BEFORE DELETE ON merchants FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_merchants AFTER UPDATE ON merchants FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id),
  governorate_id uuid REFERENCES governorates(id),
  area_id    uuid REFERENCES areas(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id),
  job_title  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ================= الأقسام (شجرة غير محدودة المستويات) =================
CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id     uuid REFERENCES categories(id),
  name_ar       text NOT NULL,
  slug          text NOT NULL UNIQUE,
  image_url     text,
  sort_order    int NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  show_on_home  boolean NOT NULL DEFAULT false,
  is_restricted boolean NOT NULL DEFAULT false,        -- أدوية/منتجات مقيدة تتطلب ترخيصاً
  requires_license boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX categories_parent_idx ON categories(parent_id, sort_order);
CREATE TRIGGER categories_upd BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- منع الدورات في شجرة الأقسام
CREATE OR REPLACE FUNCTION categories_no_cycle() RETURNS trigger AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
      UNION ALL SELECT c.id, c.parent_id FROM categories c JOIN up ON c.id = up.parent_id
    ) SELECT 1 FROM up WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'لا يمكن جعل القسم تابعاً لأحد فروعه';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER categories_cycle BEFORE UPDATE OF parent_id ON categories FOR EACH ROW EXECUTE FUNCTION categories_no_cycle();

-- حذف القسم ممنوع إن كان له منتجات (يُخفى بدلاً من ذلك) — يُفعل بعد إنشاء products

-- ================= المنتجات =================
CREATE TYPE product_status AS ENUM ('draft','pending_review','approved','rejected','archived');

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     uuid NOT NULL REFERENCES merchants(id),
  category_id     uuid NOT NULL REFERENCES categories(id),
  name_ar         text NOT NULL,
  description     text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  merchant_price  numeric(18,2) NOT NULL CHECK (merchant_price >= 0),  -- سعر التاجر (سري)
  currency        char(3) NOT NULL REFERENCES currencies(code),
  is_available    boolean NOT NULL DEFAULT true,
  status          product_status NOT NULL DEFAULT 'pending_review',
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_notes    text,
  -- لقطة التسعير المعتمدة (تُحسب عند الموافقة أو بقرار إداري صريح)
  priced_merchant_price numeric(18,2),
  priced_currency char(3) REFERENCES currencies(code),
  fx_rate_used    numeric(18,8),
  markup_percent  numeric(7,3),
  markup_amount   numeric(18,2),
  final_price     numeric(18,2),
  priced_rule_id  uuid,
  priced_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR final_price IS NOT NULL)
);
CREATE INDEX products_merchant_idx ON products(merchant_id);
CREATE INDEX products_cat_status_idx ON products(category_id, status);
CREATE TRIGGER products_upd BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_no_delete BEFORE DELETE ON products FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_products AFTER UPDATE ON products FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE OR REPLACE FUNCTION categories_block_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE category_id = OLD.id)
     OR EXISTS (SELECT 1 FROM categories WHERE parent_id = OLD.id) THEN
    RAISE EXCEPTION 'لا يمكن حذف قسم يحتوي منتجات أو أقساماً فرعية، أخفِه بدلاً من ذلك';
  END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER categories_del BEFORE DELETE ON categories FOR EACH ROW EXECUTE FUNCTION categories_block_delete();

CREATE TABLE product_images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  url         text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_images_idx ON product_images(product_id, sort_order);

-- خيارات (لون/مقاس). لكل متغير مخزونه الخاص. المنتج بلا خيارات له متغير افتراضي واحد.
CREATE TABLE product_variants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id),
  sku         text UNIQUE,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {"color":"أحمر","size":"L"}
  price_delta numeric(18,2) NOT NULL DEFAULT 0,         -- فرق سعر التاجر لهذا الخيار
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, options)
);

-- ================= المخزون =================
CREATE TABLE inventory (
  variant_id  uuid PRIMARY KEY REFERENCES product_variants(id),
  quantity    integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),   -- منع البيع بأكثر من المتوفر
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE inventory_reason AS ENUM ('initial','merchant_adjust','order_reserve','order_release','return_restock','admin_adjust');

CREATE TABLE inventory_movements (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  delta       integer NOT NULL CHECK (delta <> 0),
  qty_after   integer NOT NULL CHECK (qty_after >= 0),
  reason      inventory_reason NOT NULL,
  order_id    uuid,
  actor_id    uuid REFERENCES users(id),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inv_mov_variant_idx ON inventory_movements(variant_id, created_at DESC);
CREATE TRIGGER inv_mov_append_only BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- كل تغيير في المخزون يسجل تلقائياً مع المنفذ (app.user_id) — لا مسار لتغيير الكمية بدون سجل
CREATE OR REPLACE FUNCTION inventory_log() RETURNS trigger AS $$
DECLARE actor uuid; oid uuid; why inventory_reason;
BEGIN
  BEGIN actor := NULLIF(current_setting('app.user_id', true), '')::uuid; EXCEPTION WHEN others THEN actor := NULL; END;
  BEGIN oid := NULLIF(current_setting('app.order_id', true), '')::uuid; EXCEPTION WHEN others THEN oid := NULL; END;
  BEGIN why := NULLIF(current_setting('app.inv_reason', true), '')::inventory_reason; EXCEPTION WHEN others THEN why := NULL; END;
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity <> 0 THEN
      INSERT INTO inventory_movements(variant_id, delta, qty_after, reason, order_id, actor_id)
      VALUES (NEW.variant_id, NEW.quantity, NEW.quantity, COALESCE(why,'initial'), oid, actor);
    END IF;
  ELSIF NEW.quantity <> OLD.quantity THEN
    INSERT INTO inventory_movements(variant_id, delta, qty_after, reason, order_id, actor_id)
    VALUES (NEW.variant_id, NEW.quantity - OLD.quantity, NEW.quantity, COALESCE(why,'admin_adjust'), oid, actor);
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_log_ins AFTER INSERT ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_log();
CREATE TRIGGER inventory_log_upd BEFORE UPDATE ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_log();

-- ================= قواعد التسعير =================
CREATE TYPE pricing_scope AS ENUM ('global','merchant','category','product');

CREATE TABLE pricing_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          pricing_scope NOT NULL,
  merchant_id    uuid REFERENCES merchants(id),
  category_id    uuid REFERENCES categories(id),
  product_id     uuid REFERENCES products(id),
  governorate_id uuid REFERENCES governorates(id),     -- قيد اختياري حسب المنطقة
  currency       char(3) REFERENCES currencies(code),  -- قيد اختياري حسب العملة
  markup_percent numeric(7,3) CHECK (markup_percent >= 0),   -- زيادة على سعر التاجر
  fixed_final_price numeric(18,2) CHECK (fixed_final_price >= 0), -- سعر نهائي خاص
  is_excluded    boolean NOT NULL DEFAULT false,       -- استثناء: يستخدم قاعدة أعم
  is_active      boolean NOT NULL DEFAULT true,
  valid_from     timestamptz NOT NULL DEFAULT now(),
  valid_to       timestamptz,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),   -- ترتيب دقيق حتى داخل معاملة واحدة
  CHECK ((scope = 'global'   AND merchant_id IS NULL AND category_id IS NULL AND product_id IS NULL)
      OR (scope = 'merchant' AND merchant_id IS NOT NULL AND category_id IS NULL AND product_id IS NULL)
      OR (scope = 'category' AND category_id IS NOT NULL AND merchant_id IS NULL AND product_id IS NULL)
      OR (scope = 'product'  AND product_id  IS NOT NULL AND merchant_id IS NULL AND category_id IS NULL)),
  CHECK (is_excluded OR markup_percent IS NOT NULL OR fixed_final_price IS NOT NULL),
  CHECK (fixed_final_price IS NULL OR scope = 'product'),  -- السعر الثابت لمنتج محدد فقط
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX pricing_rules_scope_idx ON pricing_rules(scope, is_active);
CREATE TRIGGER audit_pricing_rules AFTER INSERT OR UPDATE OR DELETE ON pricing_rules FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE products ADD CONSTRAINT products_priced_rule_fk FOREIGN KEY (priced_rule_id) REFERENCES pricing_rules(id);

-- ---------- سعر الصرف المعتمد ----------
CREATE OR REPLACE FUNCTION get_exchange_rate(p_from char(3), p_to char(3), p_gov uuid DEFAULT NULL, p_at timestamptz DEFAULT now())
RETURNS numeric AS $$
DECLARE r numeric;
BEGIN
  IF p_from = p_to THEN RETURN 1; END IF;
  SELECT rate INTO r FROM exchange_rates
   WHERE from_currency = p_from AND to_currency = p_to
     AND (governorate_id = p_gov OR governorate_id IS NULL)
     AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
   ORDER BY (governorate_id IS NOT NULL) DESC, valid_from DESC LIMIT 1;
  IF r IS NULL THEN
    -- المعكوس
    SELECT 1 / rate INTO r FROM exchange_rates
     WHERE from_currency = p_to AND to_currency = p_from
       AND (governorate_id = p_gov OR governorate_id IS NULL)
       AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
     ORDER BY (governorate_id IS NOT NULL) DESC, valid_from DESC LIMIT 1;
  END IF;
  IF r IS NULL THEN
    RAISE EXCEPTION 'لا يوجد سعر صرف من % إلى %', p_from, p_to;
  END IF;
  RETURN r;
END; $$ LANGUAGE plpgsql STABLE;

-- ---------- حل قاعدة التسعير: الأكثر تخصيصاً (منتج > قسم > تاجر > عام) ----------
-- داخل المستوى الواحد: قاعدة مقيدة بمنطقة/عملة أولى من غير المقيدة، ثم الأحدث.
-- القسم: يؤخذ أقرب قسم في الشجرة له قاعدة (الفرعي قبل الأب).
-- قاعدة الاستثناء (is_excluded) على مستوى معين تعني تجاهل ذلك المستوى والانتقال للأعم.
CREATE OR REPLACE FUNCTION resolve_pricing_rule(p_product uuid, p_gov uuid DEFAULT NULL, p_at timestamptz DEFAULT now())
RETURNS pricing_rules AS $$
DECLARE
  prod products%ROWTYPE; rule pricing_rules%ROWTYPE; cat uuid;
BEGIN
  SELECT * INTO prod FROM products WHERE id = p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'المنتج غير موجود'; END IF;

  -- 1) منتج
  SELECT * INTO rule FROM pricing_rules
   WHERE scope='product' AND product_id = p_product AND is_active
     AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
     AND (governorate_id IS NULL OR governorate_id = p_gov)
     AND (currency IS NULL OR currency = prod.currency)
   ORDER BY (governorate_id IS NOT NULL) DESC, (currency IS NOT NULL) DESC, created_at DESC LIMIT 1;
  IF FOUND AND NOT rule.is_excluded THEN RETURN rule; END IF;

  -- 2) قسم (من الأدنى إلى الأعلى)
  FOR cat IN
    WITH RECURSIVE up(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM categories WHERE id = prod.category_id
      UNION ALL SELECT c.id, c.parent_id, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id
    ) SELECT id FROM up ORDER BY depth
  LOOP
    SELECT * INTO rule FROM pricing_rules
     WHERE scope='category' AND category_id = cat AND is_active
       AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
       AND (governorate_id IS NULL OR governorate_id = p_gov)
       AND (currency IS NULL OR currency = prod.currency)
     ORDER BY (governorate_id IS NOT NULL) DESC, (currency IS NOT NULL) DESC, created_at DESC LIMIT 1;
    IF FOUND AND NOT rule.is_excluded THEN RETURN rule; END IF;
    IF FOUND AND rule.is_excluded THEN EXIT; END IF;  -- استثناء على القسم: تجاوز مستوى الأقسام
  END LOOP;

  -- 3) تاجر
  SELECT * INTO rule FROM pricing_rules
   WHERE scope='merchant' AND merchant_id = prod.merchant_id AND is_active
     AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
     AND (governorate_id IS NULL OR governorate_id = p_gov)
     AND (currency IS NULL OR currency = prod.currency)
   ORDER BY (governorate_id IS NOT NULL) DESC, (currency IS NOT NULL) DESC, created_at DESC LIMIT 1;
  IF FOUND AND NOT rule.is_excluded THEN RETURN rule; END IF;

  -- 4) عام
  SELECT * INTO rule FROM pricing_rules
   WHERE scope='global' AND is_active AND NOT is_excluded
     AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
     AND (governorate_id IS NULL OR governorate_id = p_gov)
     AND (currency IS NULL OR currency = prod.currency)
   ORDER BY (governorate_id IS NOT NULL) DESC, (currency IS NOT NULL) DESC, created_at DESC LIMIT 1;
  IF FOUND THEN RETURN rule; END IF;

  RAISE EXCEPTION 'لا توجد قاعدة تسعير سارية للمنتج %', p_product;
END; $$ LANGUAGE plpgsql STABLE;

-- ---------- حساب السعر النهائي ----------
-- السعر النهائي = سعر التاجر + (سعر التاجر × النسبة/100) — زيادة على سعر التاجر لا هامش من البيع
-- النتيجة بعملة المنتج الأصلية؛ التحويل لعملة العرض يتم عبر get_exchange_rate.
CREATE OR REPLACE FUNCTION compute_price(p_product uuid, p_gov uuid DEFAULT NULL, p_variant_delta numeric DEFAULT 0)
RETURNS TABLE (merchant_price numeric, currency char(3), markup_percent numeric, markup_amount numeric,
               final_price numeric, rule_id uuid) AS $$
DECLARE prod products%ROWTYPE; rule pricing_rules%ROWTYPE; base numeric; dec smallint;
BEGIN
  SELECT * INTO prod FROM products WHERE id = p_product;
  rule := resolve_pricing_rule(p_product, p_gov);
  SELECT decimals INTO dec FROM currencies WHERE code = prod.currency;
  base := prod.merchant_price + p_variant_delta;
  merchant_price := base; currency := prod.currency; rule_id := rule.id;
  IF rule.fixed_final_price IS NOT NULL THEN
    final_price := round(rule.fixed_final_price, dec);
    markup_amount := final_price - base;
    markup_percent := CASE WHEN base = 0 THEN NULL ELSE round(markup_amount / base * 100, 3) END;
  ELSE
    markup_percent := rule.markup_percent;
    markup_amount := round(base * rule.markup_percent / 100, dec);
    final_price := round(base, dec) + markup_amount;
  END IF;
  RETURN NEXT;
END; $$ LANGUAGE plpgsql STABLE;

-- ---------- اعتماد التسعير (عند الموافقة أو بقرار إداري صريح فقط) ----------
-- تغيير نسبة عامة لا يمس المنتجات المنشورة تلقائياً؛ يجب استدعاء هذه الدالة صراحة.
CREATE OR REPLACE FUNCTION apply_pricing_to_product(p_product uuid, p_actor uuid)
RETURNS products AS $$
DECLARE pr record; prod products%ROWTYPE; fx numeric;
BEGIN
  PERFORM set_config('app.user_id', p_actor::text, true);
  SELECT * INTO pr FROM compute_price(p_product);
  fx := 1;  -- سعر الصرف المستخدم لعملة المنتج نفسها؛ تحويل العرض يحفظ في الطلب
  UPDATE products SET priced_merchant_price = pr.merchant_price, priced_currency = pr.currency,
         fx_rate_used = fx, markup_percent = pr.markup_percent, markup_amount = pr.markup_amount,
         final_price = pr.final_price, priced_rule_id = pr.rule_id, priced_at = now()
   WHERE id = p_product RETURNING * INTO prod;
  RETURN prod;
END; $$ LANGUAGE plpgsql;

-- ---------- مراجعة المنتج: لا نشر دون موافقة موظف ----------
CREATE OR REPLACE FUNCTION approve_product(p_product uuid, p_actor uuid, p_notes text DEFAULT NULL)
RETURNS products AS $$
DECLARE prod products%ROWTYPE;
BEGIN
  IF NOT user_has_permission(p_actor, 'products.review') THEN
    RAISE EXCEPTION 'لا تملك صلاحية مراجعة المنتجات' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.user_id', p_actor::text, true);
  PERFORM apply_pricing_to_product(p_product, p_actor);
  UPDATE products SET status = 'approved', reviewed_by = p_actor, reviewed_at = now(), review_notes = p_notes
   WHERE id = p_product RETURNING * INTO prod;
  RETURN prod;
END; $$ LANGUAGE plpgsql;

COMMIT;
