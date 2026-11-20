-- ============================================================
-- وسيطك | 005_operations.sql
-- المرتجعات والاسترداد، التوصيل والشحنات والتتبع، المراسلة، الإعلانات،
-- التقييمات والشكاوى، الإشعارات، حسابات تجريبية، وسيطك الذكي (بنية فقط)
-- ============================================================
BEGIN;

-- ---------- عزل البيانات التجريبية ----------
ALTER TABLE users  ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN is_demo boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION orders_inherit_demo() RETURNS trigger AS $$
BEGIN
  NEW.is_demo := COALESCE((SELECT u.is_demo FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = NEW.customer_id), false);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER orders_demo BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION orders_inherit_demo();

-- أرقام الدفاتر الحقيقية فقط (تستثني التجريبي)
CREATE VIEW real_merchant_transactions AS
  SELECT t.* FROM merchant_transactions t JOIN merchants m ON m.id = t.merchant_id JOIN users u ON u.id = m.user_id WHERE NOT u.is_demo;
CREATE VIEW real_platform_ledger AS
  SELECT l.* FROM platform_ledger l LEFT JOIN orders o ON o.id = l.order_id WHERE COALESCE(NOT o.is_demo, true);

-- ---------- المرتجعات والاسترداد ----------
CREATE TYPE return_status AS ENUM ('requested','approved','rejected','received','refunded','replaced');
CREATE TYPE fault_party AS ENUM ('customer','merchant','platform');

CREATE TABLE returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  quantity      integer NOT NULL CHECK (quantity > 0),
  reason        text NOT NULL,
  details       text,
  images        text[] NOT NULL DEFAULT '{}',
  status        return_status NOT NULL DEFAULT 'requested',
  fault         fault_party,
  return_cost   numeric(18,2) CHECK (return_cost >= 0),
  decided_by    uuid REFERENCES users(id),
  decision_note text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id)
);

-- مهلة 24 ساعة من وقت تسجيل التسليم
CREATE OR REPLACE FUNCTION returns_check_window() RETURNS trigger AS $$
DECLARE o orders%ROWTYPE; qty int;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.order_id;
  IF o.delivered_at IS NULL THEN RAISE EXCEPTION 'لا يمكن طلب إرجاع قبل التسليم'; END IF;
  IF now() > o.delivered_at + interval '24 hours' THEN
    RAISE EXCEPTION 'انتهت مهلة الإرجاع (24 ساعة من التسليم)';
  END IF;
  SELECT quantity INTO qty FROM order_items WHERE id = NEW.order_item_id AND order_id = NEW.order_id;
  IF qty IS NULL THEN RAISE EXCEPTION 'البند لا يتبع هذا الطلب'; END IF;
  IF NEW.quantity > qty THEN RAISE EXCEPTION 'كمية الإرجاع أكبر من الكمية المشتراة'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER returns_window BEFORE INSERT ON returns FOR EACH ROW EXECUTE FUNCTION returns_check_window();
CREATE TRIGGER audit_returns AFTER UPDATE ON returns FOR EACH ROW EXECUTE FUNCTION audit_row();

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id    uuid NOT NULL UNIQUE REFERENCES returns(id),
  order_id     uuid NOT NULL REFERENCES orders(id),
  amount       numeric(18,2) NOT NULL CHECK (amount >= 0),
  currency     char(3) NOT NULL REFERENCES currencies(code),
  method       text NOT NULL,
  refunded_by  uuid NOT NULL REFERENCES users(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- شركات التوصيل والشحنات (بنية فقط؛ الوحدة غير مفعلة) ----------
CREATE TABLE delivery_companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar    text NOT NULL,
  phone      text,
  is_active  boolean NOT NULL DEFAULT false,
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE delivery_company_zones (
  company_id     uuid NOT NULL REFERENCES delivery_companies(id),
  governorate_id uuid NOT NULL REFERENCES governorates(id),
  area_id        uuid REFERENCES areas(id),
  fee            numeric(18,2) NOT NULL CHECK (fee >= 0),
  currency       char(3) NOT NULL REFERENCES currencies(code)
);
CREATE TYPE shipment_status AS ENUM ('assigned','picked_up','in_transit','delivered','failed','returned');
CREATE TABLE shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id),
  company_id    uuid REFERENCES delivery_companies(id),
  agent_id      uuid REFERENCES delivery_agents(id),
  tracking_no   text,
  status        shipment_status NOT NULL DEFAULT 'assigned',
  cod_collected numeric(18,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (company_id IS NOT NULL OR agent_id IS NOT NULL)
);
CREATE INDEX shipments_order_idx ON shipments(order_id);

-- ---------- تتبع موقع المندوب (فقط أثناء مهمة نشطة) ----------
CREATE TABLE agent_locations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id),
  agent_id   uuid NOT NULL REFERENCES delivery_agents(id),
  lat        double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng        double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m real,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_loc_idx ON agent_locations(order_id, recorded_at DESC);

-- لا يقبل الموقع إلا للمندوب المسند والطلب في حالة «خرج للتوصيل»
CREATE OR REPLACE FUNCTION agent_location_guard() RETURNS trigger AS $$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.order_id;
  IF o.agent_id IS DISTINCT FROM NEW.agent_id THEN RAISE EXCEPTION 'الطلب غير مسند لهذا المندوب'; END IF;
  IF o.status <> 'out_for_delivery' THEN RAISE EXCEPTION 'التتبع متاح فقط أثناء التوصيل النشط'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER agent_loc_guard BEFORE INSERT ON agent_locations FOR EACH ROW EXECUTE FUNCTION agent_location_guard();

-- ---------- المراسلة ----------
CREATE TYPE conversation_kind AS ENUM ('order_agent','support','advertiser','merchant_admin');
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       conversation_kind NOT NULL,
  order_id   uuid REFERENCES orders(id),
  ad_id      uuid,
  is_closed  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'order_agent' OR order_id IS NOT NULL)
);
CREATE UNIQUE INDEX conv_one_per_order_agent ON conversations(order_id) WHERE kind = 'order_agent';
CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  last_read_at    timestamptz,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sender_id       uuid NOT NULL REFERENCES users(id),
  body            text,
  image_url       text,
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR image_url IS NOT NULL)
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, id);
-- الرسالة لا ترسل إلا من مشارك في المحادثة
CREATE OR REPLACE FUNCTION messages_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id) THEN
    RAISE EXCEPTION 'المرسل ليس مشاركاً في هذه المحادثة' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT is_closed FROM conversations WHERE id = NEW.conversation_id) THEN RAISE EXCEPTION 'المحادثة مغلقة'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER messages_guard_t BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_guard();

-- ---------- الإعلانات ----------
CREATE TYPE ad_status AS ENUM ('draft','pending_review','approved','rejected','active','paused','expired');
CREATE TABLE advertisement_packages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar    text NOT NULL,
  placement  text NOT NULL CHECK (placement IN ('home_top_bar','home_banner','between_products','category','featured_store','specific_product')),
  duration_days int NOT NULL CHECK (duration_days > 0),
  is_active  boolean NOT NULL DEFAULT true
);
-- لا أسعار ثابتة: الجدول فارغ ويملؤه المدير. السعر قد يخص معلناً محدداً أو يحمل خصماً.
CREATE TABLE advertisement_prices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id  uuid REFERENCES advertisement_packages(id),
  placement   text,
  advertiser_user_id uuid REFERENCES users(id),
  price       numeric(18,2) NOT NULL CHECK (price >= 0),
  currency    char(3) NOT NULL REFERENCES currencies(code),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  CHECK (package_id IS NOT NULL OR placement IS NOT NULL)
);
CREATE TABLE advertisements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  shop_name     text,
  placement     text NOT NULL,
  package_id    uuid REFERENCES advertisement_packages(id),
  image_url     text,
  text_ar       text,
  whatsapp      text,
  starts_at     timestamptz,
  ends_at       timestamptz,
  target_type   text CHECK (target_type IN ('store','product','category','chat','external')),
  target_id     uuid,
  target_url    text,
  contact_options text[] NOT NULL DEFAULT '{}' CHECK (contact_options <@ ARRAY['inapp','whatsapp']),
  status        ad_status NOT NULL DEFAULT 'pending_review',
  amount_due    numeric(18,2),
  currency      char(3) REFERENCES currencies(code),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','waived','refunded')),
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (target_type <> 'external' OR target_url ~ '^https://')
);
CREATE TRIGGER audit_ads AFTER INSERT OR UPDATE ON advertisements FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TABLE advertisement_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ad_id      uuid NOT NULL REFERENCES advertisements(id),
  event      text NOT NULL CHECK (event IN ('impression','click','chat_started','whatsapp_opened')),
  user_id    uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_events_idx ON advertisement_events(ad_id, event);
-- الاسم المطلوب في المتطلبات: AdvertisementClicks
CREATE VIEW advertisement_clicks AS SELECT * FROM advertisement_events WHERE event = 'click';

-- ---------- التقييمات والشكاوى (مرتبطة بطلبات سُلمت فعلاً) ----------
CREATE TABLE reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  merchant_id   uuid NOT NULL REFERENCES merchants(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  product_rating smallint NOT NULL CHECK (product_rating BETWEEN 1 AND 5),
  merchant_rating smallint CHECK (merchant_rating BETWEEN 1 AND 5),
  comment       text,
  is_visible    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_item_id)
);
CREATE OR REPLACE FUNCTION reviews_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE i.id = NEW.order_item_id AND o.customer_id = NEW.customer_id AND o.status IN ('delivered','return_requested','return_processing','return_completed','refunded')
        AND o.delivered_at IS NOT NULL) THEN
    RAISE EXCEPTION 'لا يمكن التقييم إلا لطلب مُسلَّم يخص المشتري';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER reviews_guard_t BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION reviews_guard();

CREATE TABLE complaints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id    uuid REFERENCES orders(id),
  merchant_id uuid REFERENCES merchants(id),
  subject     text NOT NULL,
  details     text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','rejected')),
  resolution  text,
  handled_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (status NOT IN ('resolved','rejected') OR (resolution IS NOT NULL AND handled_by IS NOT NULL))
);

-- ---------- الإشعارات ----------
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  entity     text,
  entity_id  text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notif_user_idx ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE push_subscriptions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  endpoint   text NOT NULL UNIQUE,
  keys       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- المصروفات التشغيلية ----------
CREATE TABLE operating_expenses (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category   text NOT NULL,
  amount     numeric(18,2) NOT NULL CHECK (amount > 0),
  currency   char(3) NOT NULL REFERENCES currencies(code),
  note       text,
  actor_id   uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER expenses_append_only BEFORE UPDATE OR DELETE ON operating_expenses FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ============================================================
-- وسيطك الذكي (بنية فقط — غير مفعّل ولا يستدعي أي خدمة مدفوعة)
-- ============================================================
INSERT INTO system_modules(code, name_ar, description, status, readiness, requirements) VALUES
  ('smart_wasitak','وسيطك الذكي','تحسين صور وكتابة أوصاف المنتجات بالذكاء الاصطناعي للتجار (اشتراكات)',
   'disabled','db_ready','يتطلب تهيئة مزود ذكاء اصطناعي مفعّل بموافقة المالك. الواجهة والتكامل لم ينفذا بعد.');
INSERT INTO module_dependencies VALUES ('smart_wasitak','catalog');

INSERT INTO permissions(code, name_ar, module_code) VALUES
  ('smart.manage','إدارة اشتراكات وسيطك الذكي','smart_wasitak'),
  ('smart.use','استخدام وسيطك الذكي','smart_wasitak');
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p WHERE r.code='super_admin' AND p.code IN ('smart.manage','smart.use');
INSERT INTO role_permissions SELECT r.id, p.id FROM roles r, permissions p WHERE r.code='merchant' AND p.code = 'smart.use';

-- مزودو الذكاء الاصطناعي: قابلون للإضافة؛ المدفوع لا يعمل دون موافقة صريحة مسجلة
CREATE TABLE ai_providers (
  code           text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name           text NOT NULL,
  capabilities   text[] NOT NULL DEFAULT '{}',   -- image_enhance, bg_remove, text_generate, ...
  is_paid        boolean NOT NULL DEFAULT true,
  free_tier_note text,
  is_enabled     boolean NOT NULL DEFAULT false,
  paid_approved_by uuid REFERENCES users(id),     -- موافقة المالك الصريحة
  paid_approved_at timestamptz,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- بلا مفاتيح سرية: المفاتيح في متغيرات البيئة
  CHECK (NOT (is_enabled AND is_paid) OR paid_approved_by IS NOT NULL)
);
CREATE TABLE ai_subscription_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar      text NOT NULL,
  period       text NOT NULL CHECK (period IN ('monthly','yearly','free','custom')),
  duration_days int CHECK (duration_days > 0),
  price        numeric(18,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency     char(3) REFERENCES currencies(code),
  image_quota  int NOT NULL DEFAULT 0 CHECK (image_quota >= 0),
  text_quota   int NOT NULL DEFAULT 0 CHECK (text_quota >= 0),
  post_quota   int NOT NULL DEFAULT 0 CHECK (post_quota >= 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  is_active    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  plan_id     uuid NOT NULL REFERENCES ai_subscription_plans(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz NOT NULL,
  amount_paid numeric(18,2) NOT NULL DEFAULT 0,
  currency    char(3) REFERENCES currencies(code),
  created_by  uuid REFERENCES users(id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX ai_sub_merchant_idx ON ai_subscriptions(merchant_id, status);
CREATE TABLE ai_usage (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id  uuid NOT NULL REFERENCES merchants(id),
  subscription_id uuid REFERENCES ai_subscriptions(id),
  provider_code text REFERENCES ai_providers(code),
  kind         text NOT NULL CHECK (kind IN ('image','text','post')),
  units        int NOT NULL DEFAULT 1 CHECK (units > 0),
  cost_amount  numeric(18,6) NOT NULL DEFAULT 0,        -- تكلفة المزود الفعلية
  cost_currency char(3) DEFAULT 'USD',
  product_id   uuid REFERENCES products(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ai_usage_append_only BEFORE UPDATE OR DELETE ON ai_usage FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TABLE ai_drafts (   -- مسودات يراجعها التاجر ويعدلها قبل الاعتماد
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id  uuid REFERENCES products(id),
  input       jsonb NOT NULL,
  output      jsonb,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','approved','discarded','failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- استهلاك الباقة: لا استخدام دون اشتراك فعال وضمن الحصة
CREATE OR REPLACE FUNCTION ai_usage_guard() RETURNS trigger AS $$
DECLARE sub ai_subscriptions%ROWTYPE; plan ai_subscription_plans%ROWTYPE; used int; quota int;
BEGIN
  IF NOT module_enabled('smart_wasitak') THEN RAISE EXCEPTION 'وحدة وسيطك الذكي غير مفعلة'; END IF;
  SELECT * INTO sub FROM ai_subscriptions WHERE id = NEW.subscription_id AND merchant_id = NEW.merchant_id
     AND status = 'active' AND now() BETWEEN starts_at AND ends_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'لا يوجد اشتراك فعال لهذا التاجر'; END IF;
  SELECT * INTO plan FROM ai_subscription_plans WHERE id = sub.plan_id;
  quota := CASE NEW.kind WHEN 'image' THEN plan.image_quota WHEN 'text' THEN plan.text_quota ELSE plan.post_quota END;
  SELECT COALESCE(sum(units),0) INTO used FROM ai_usage WHERE subscription_id = sub.id AND kind = NEW.kind;
  IF used + NEW.units > quota THEN RAISE EXCEPTION 'تجاوزت حد الاستخدام في الباقة'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER ai_usage_guard_t BEFORE INSERT ON ai_usage FOR EACH ROW EXECUTE FUNCTION ai_usage_guard();

-- مزودون مسجلون لكن معطلون (لا مفاتيح ولا تكلفة)
INSERT INTO ai_providers(code, name, capabilities, is_paid, free_tier_note) VALUES
  ('local_rules','قوالب محلية بلا ذكاء اصطناعي',ARRAY['text_template'],false,'مجاني بالكامل؛ يعتمد على قوالب ومدخلات التاجر فقط'),
  ('external_llm','مزود نصوص خارجي (يُحدد لاحقاً)',ARRAY['text_generate','keywords','category_suggest'],true,'يحتاج مفتاحاً وربما رصيداً؛ غير مفعل'),
  ('external_image','مزود صور خارجي (يُحدد لاحقاً)',ARRAY['image_enhance','bg_remove'],true,'يحتاج مفتاحاً وربما رصيداً؛ غير مفعل');

COMMIT;
