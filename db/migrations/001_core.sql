-- ============================================================
-- وسيطك | 001_core.sql
-- الأساس: الأدوار والصلاحيات، المستخدمون، الوحدات، الإعدادات،
-- سجل التدقيق، الجغرافيا، العملات وأسعار الصرف
-- ============================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- دالة تحديث updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- ---------- منع التعديل/الحذف (للجداول الملحقة فقط) ----------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'الجدول % للإلحاق فقط: لا يسمح بـ % (استخدم قيداً تصحيحياً)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END; $$ LANGUAGE plpgsql;

-- ================= الأدوار والصلاحيات =================
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name_ar     text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,   -- أدوار النظام لا تحذف
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER roles_upd BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION protect_system_role() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN RAISE EXCEPTION 'لا يمكن حذف دور النظام %', OLD.code; END IF;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER roles_no_del_system BEFORE DELETE ON roles FOR EACH ROW EXECUTE FUNCTION protect_system_role();

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),  -- مثال: products.review
  name_ar     text NOT NULL,
  module_code text,                                   -- الوحدة التي تتبعها (NULL = أساسية)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ================= المستخدمون =================
CREATE TYPE user_status AS ENUM ('pending','active','suspended','closed');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id       uuid NOT NULL REFERENCES roles(id),
  full_name     text NOT NULL,
  phone         text NOT NULL UNIQUE CHECK (phone ~ '^\+?[0-9]{7,15}$'),
  email         citext UNIQUE,
  password_hash text NOT NULL,                        -- argon2/bcrypt من التطبيق، لا نص صريح أبداً
  status        user_status NOT NULL DEFAULT 'active',
  failed_logins int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_idx ON users(role_id);
CREATE TRIGGER users_upd BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- لا حذف فعلي للمستخدمين (السجلات المالية مرتبطة بهم)
CREATE TRIGGER users_no_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,                   -- نخزن الهاش فقط
  user_agent  text,
  ip          inet,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- دالة فحص الصلاحية على مستوى قاعدة البيانات (تستخدمها الخدمات وسياسات RLS لاحقاً)
CREATE OR REPLACE FUNCTION user_has_permission(p_user uuid, p_perm text) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM users u
    JOIN role_permissions rp ON rp.role_id = u.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE u.id = p_user AND u.status = 'active' AND p.code = p_perm
      AND (p.module_code IS NULL OR EXISTS (
            SELECT 1 FROM system_modules m WHERE m.code = p.module_code AND m.status = 'enabled'))
  );
END; $$ LANGUAGE plpgsql STABLE;

-- ================= الجغرافيا (غير محدودة بالكود) =================
CREATE TABLE countries (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iso2    char(2) NOT NULL UNIQUE,
  name_ar text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE governorates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id  uuid NOT NULL REFERENCES countries(id),
  name_ar     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,          -- التفعيل قرار إداري
  accepts_orders boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,
  UNIQUE (country_id, name_ar)
);
CREATE TABLE districts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  governorate_id  uuid NOT NULL REFERENCES governorates(id),
  name_ar         text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  UNIQUE (governorate_id, name_ar)
);
-- مناطق/أحياء/قرى بمستويات متداخلة
CREATE TABLE areas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id  uuid NOT NULL REFERENCES districts(id),
  parent_id    uuid REFERENCES areas(id),
  kind         text NOT NULL DEFAULT 'area' CHECK (kind IN ('area','neighborhood','village')),
  name_ar      text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  accepts_orders boolean NOT NULL DEFAULT true,
  UNIQUE (district_id, parent_id, name_ar)
);

-- ================= العملات وأسعار الصرف =================
CREATE TABLE currencies (
  code        char(3) PRIMARY KEY,                     -- YER, SAR, USD ...
  name_ar     text NOT NULL,
  symbol      text NOT NULL,
  decimals    smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 4),
  is_base     boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX currencies_one_base ON currencies ((true)) WHERE is_base;

-- سعر الصرف: كم وحدة من to_currency تساوي وحدة واحدة من from_currency
CREATE TABLE exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency char(3) NOT NULL REFERENCES currencies(code),
  to_currency   char(3) NOT NULL REFERENCES currencies(code),
  governorate_id uuid REFERENCES governorates(id),     -- NULL = سعر عام
  rate          numeric(18,8) NOT NULL CHECK (rate > 0),
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX exchange_rates_lookup ON exchange_rates(from_currency, to_currency, governorate_id, valid_from DESC);

-- أسعار الصرف تاريخية: لا تعديل ولا حذف، التغيير يتم بإدخال سعر جديد
CREATE TRIGGER exchange_rates_no_delete BEFORE DELETE ON exchange_rates FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ================= وحدات النظام =================
CREATE TYPE module_status AS ENUM ('disabled','enabled');
CREATE TYPE module_readiness AS ENUM ('not_implemented','db_ready','complete');

CREATE TABLE system_modules (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name_ar      text NOT NULL,
  description  text,
  is_core      boolean NOT NULL DEFAULT false,         -- الأساسية لا تعطل
  status       module_status NOT NULL DEFAULT 'disabled',
  readiness    module_readiness NOT NULL DEFAULT 'not_implemented',  -- صدق الحالة: لا يفعل ما لم يكتمل
  settings     jsonb NOT NULL DEFAULT '{}'::jsonb,
  requirements text,
  updated_by   uuid REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_core OR status = 'enabled')
);
ALTER TABLE permissions ADD CONSTRAINT permissions_module_fk
  FOREIGN KEY (module_code) REFERENCES system_modules(code);

CREATE TABLE module_dependencies (
  module_code     text NOT NULL REFERENCES system_modules(code),
  depends_on_code text NOT NULL REFERENCES system_modules(code),
  PRIMARY KEY (module_code, depends_on_code),
  CHECK (module_code <> depends_on_code)
);

-- منع التفعيل/التعطيل المخالف للاعتماديات والجاهزية
CREATE OR REPLACE FUNCTION enforce_module_rules() RETURNS trigger AS $$
DECLARE blocker text;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'enabled' THEN
    IF NEW.readiness = 'not_implemented' THEN
      RAISE EXCEPTION 'الوحدة % لم تنفذ بعد ولا يمكن تفعيلها', NEW.code;
    END IF;
    SELECT string_agg(d.depends_on_code, ', ') INTO blocker
      FROM module_dependencies d JOIN system_modules m ON m.code = d.depends_on_code
      WHERE d.module_code = NEW.code AND m.status <> 'enabled';
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'لا يمكن تفعيل % قبل تفعيل: %', NEW.code, blocker;
    END IF;
  ELSE
    IF OLD.is_core THEN RAISE EXCEPTION 'الوحدة الأساسية % لا تعطل', NEW.code; END IF;
    SELECT string_agg(d.module_code, ', ') INTO blocker
      FROM module_dependencies d JOIN system_modules m ON m.code = d.module_code
      WHERE d.depends_on_code = NEW.code AND m.status = 'enabled';
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'لا يمكن تعطيل % لأن وحدات مفعلة تعتمد عليها: %', NEW.code, blocker;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER modules_rules BEFORE UPDATE ON system_modules FOR EACH ROW EXECUTE FUNCTION enforce_module_rules();
CREATE TRIGGER modules_no_delete BEFORE DELETE ON system_modules FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION module_enabled(p_code text) RETURNS boolean AS $$
  SELECT COALESCE((SELECT status = 'enabled' FROM system_modules WHERE code = p_code), false);
$$ LANGUAGE sql STABLE;

-- ================= إعدادات النظام =================
CREATE TABLE system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ================= سجل التدقيق (للإلحاق فقط) =================
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,                           -- مثل: price.change, module.enable
  entity      text NOT NULL,
  entity_id   text,
  old_data    jsonb,
  new_data    jsonb,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs(entity, entity_id);
CREATE INDEX audit_actor_idx ON audit_logs(actor_id, created_at DESC);
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- مشغل تدقيق عام يُربط بالجداول الحساسة (يقرأ المنفذ من app.user_id)
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE actor uuid; eid text;
BEGIN
  BEGIN actor := NULLIF(current_setting('app.user_id', true), '')::uuid; EXCEPTION WHEN others THEN actor := NULL; END;
  IF TG_OP = 'DELETE' THEN eid := to_jsonb(OLD)->>'id'; ELSE eid := to_jsonb(NEW)->>'id'; END IF;
  INSERT INTO audit_logs(actor_id, action, entity, entity_id, old_data, new_data)
  VALUES (actor, lower(TG_TABLE_NAME) || '.' || lower(TG_OP), TG_TABLE_NAME, eid,
          CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN COALESCE(NEW, OLD);
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_role_permissions AFTER INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_roles AFTER INSERT OR UPDATE OR DELETE ON roles FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_exchange_rates AFTER INSERT OR UPDATE ON exchange_rates FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_system_modules AFTER UPDATE ON system_modules FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_system_settings AFTER INSERT OR UPDATE OR DELETE ON system_settings FOR EACH ROW EXECUTE FUNCTION audit_row();

COMMIT;
