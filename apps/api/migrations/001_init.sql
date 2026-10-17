-- DLX — סכמה ראשונית. רצה כבעלים (dlx_owner); השרת מתחבר כ-dlx_app, כך ש-RLS נאכף תמיד (D02, ADM-01, QA-19).
-- כל טבלה עסקית: tenant_id + מדיניות RLS. רשומות פיסקליות ותנועות: append-only ברמת ה-DB (ACC-01, QA-03).

-- gen_random_uuid() מובנה ב-Postgres 13+ (אין צורך ב-pgcrypto)

-- ===== עזרים =====
CREATE OR REPLACE FUNCTION dlx_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION dlx_deny_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DLX_IMMUTABLE: % on % is not allowed (append-only record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END $$;

CREATE OR REPLACE FUNCTION dlx_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ===== עסקים, סניפים, קופות, משתמשים =====
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  legal_name text NOT NULL,
  trade_name text,
  tax_id text NOT NULL,
  tax_status text NOT NULL CHECK (tax_status IN ('murshe','company','patur')),
  tax_status_from date NOT NULL DEFAULT current_date,
  address text, phone text, email text,
  allow_negative_stock boolean NOT NULL DEFAULT false,      -- D07
  return_days int NOT NULL DEFAULT 14,                      -- RET / G-05
  return_policy text,
  receipt_footer text,
  computerized_docs_enabled boolean NOT NULL DEFAULT false, -- D05: כבוי עד אישור יועץ מס
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','read_only','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  address text,
  tax_zone text NOT NULL DEFAULT 'regular' CHECK (tax_zone IN ('regular','eilat')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE registers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  email text,
  password_hash text,
  pin_hash text,
  role text NOT NULL CHECK (role IN ('owner','manager','cashier','warehouse','purchaser','accountant')),
  branch_id uuid REFERENCES branches(id), -- null = כל הסניפים
  active boolean NOT NULL DEFAULT true,
  token_version int NOT NULL DEFAULT 0,   -- IAM-02: השבתה מבטלת אסימונים קיימים
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION dlx_touch();

-- ===== קטלוג =====
CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku text NOT NULL,
  name text NOT NULL,
  description text,
  category_id uuid REFERENCES categories(id),
  brand text,
  unit_measure text NOT NULL DEFAULT 'unit' CHECK (unit_measure IN ('unit','kg','g','liter','ml','meter')),
  sold_by_weight boolean NOT NULL DEFAULT false,
  price_agorot bigint NOT NULL CHECK (price_agorot >= 0),       -- כולל מע"מ (D09)
  cost_agorot bigint NOT NULL DEFAULT 0 CHECK (cost_agorot >= 0), -- ממוצע נע ליחידה (D06)
  tax_category text NOT NULL DEFAULT 'standard' CHECK (tax_category IN ('standard','zero','exempt')),
  restriction text NOT NULL DEFAULT 'none' CHECK (restriction IN ('none','age18','alcohol','tobacco')),
  deposit_agorot bigint NOT NULL DEFAULT 0 CHECK (deposit_agorot >= 0),
  unit_price_basis text,           -- G-14: "ל-100 גרם" / "לליטר"
  unit_price_factor_milli bigint,  -- כמה יחידות בסיס באריזה (אלפיות)
  track_stock boolean NOT NULL DEFAULT true,
  min_stock_milli bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  scale_code text, -- קוד פריט במאזניים (5 ספרות)
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
CREATE UNIQUE INDEX products_scale_code ON products (tenant_id, scale_code) WHERE scale_code IS NOT NULL;
CREATE INDEX products_name ON products (tenant_id, lower(name));
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION dlx_touch();

-- PRD-02, PRD-05: ברקוד אחד = מוצר אחד פעיל באותו עסק
CREATE TABLE barcodes (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  barcode text NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  unit_factor_milli bigint NOT NULL DEFAULT 1000 CHECK (unit_factor_milli > 0), -- קרטון של 12 = 12000
  kind text NOT NULL DEFAULT 'unit' CHECK (kind IN ('unit','pack','carton','internal')),
  PRIMARY KEY (tenant_id, barcode)
);
CREATE INDEX barcodes_product ON barcodes (tenant_id, product_id);

-- PRI-01: מחיר סניף עם תוקף
CREATE TABLE branch_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  price_agorot bigint NOT NULL CHECK (price_agorot >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX branch_prices_lookup ON branch_prices (tenant_id, product_id, branch_id, valid_from DESC);

-- היסטוריית שינויי מחיר (O-06: מדבקות מדף, ו-PRI-05)
CREATE TABLE price_changes (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  branch_id uuid REFERENCES branches(id),
  old_price bigint, new_price bigint NOT NULL,
  actor_id uuid,
  label_printed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== ספקים ורכש =====
CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  tax_id text,
  contact_name text, phone text, email text, address text,
  payment_terms text,
  withholding_cert_until date, -- G-19: אישור ניכוי מס במקור
  withholding_rate_bp int,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number int NOT NULL,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','ordered','partial','received','closed','cancelled')),
  expected_at date,
  notes text,
  created_by uuid, approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  po_id uuid NOT NULL REFERENCES purchase_orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_cost_agorot bigint NOT NULL CHECK (unit_cost_agorot >= 0), -- לפני מע"מ
  received_qty_milli bigint NOT NULL DEFAULT 0
);

CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number int NOT NULL,
  po_id uuid REFERENCES purchase_orders(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','counting','verified','posted')),
  supplier_doc_ref text,   -- מספר תעודת משלוח / חשבונית ספק
  supplier_invoice_total_agorot bigint, -- PUR-07: להתאמה
  reason text,             -- RCV-02: קליטה בלי הזמנה — חובה
  created_by uuid, posted_by uuid, posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  receipt_id uuid NOT NULL REFERENCES goods_receipts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  po_line_id uuid REFERENCES purchase_order_lines(id),
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_cost_agorot bigint NOT NULL CHECK (unit_cost_agorot >= 0),
  condition text NOT NULL DEFAULT 'ok' CHECK (condition IN ('ok','damaged'))
);

-- ===== מלאי: יומן תנועות append-only (INV-01, INV-04) =====
CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  product_id uuid NOT NULL REFERENCES products(id),
  location text NOT NULL DEFAULT 'sale' CHECK (location IN ('sale','damaged','transit')),
  qty_delta_milli bigint NOT NULL CHECK (qty_delta_milli <> 0),
  unit_cost_agorot bigint NOT NULL DEFAULT 0,
  source_type text NOT NULL CHECK (source_type IN ('sale','return','goods_receipt','supplier_return','adjustment','count','transfer','opening')),
  source_id uuid,
  reason text,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_prod ON stock_movements (tenant_id, product_id, branch_id, location, created_at);
CREATE INDEX stock_movements_src ON stock_movements (tenant_id, source_type, source_id);
CREATE TRIGGER stock_movements_ro BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number int NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','counted','reviewed','posted')),
  scope text,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid, posted_by uuid, posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE inventory_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  count_id uuid NOT NULL REFERENCES inventory_counts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  expected_milli bigint NOT NULL,
  counted_milli bigint,
  UNIQUE (count_id, product_id)
);

-- ===== לקוחות =====
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'private' CHECK (kind IN ('private','business')),
  tax_id text,
  phone text, email text, address text,
  credit_limit_agorot bigint NOT NULL DEFAULT 0,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_phone ON customers (tenant_id, phone);

-- CRM-05, G-04: הסכמה — רשומה לכל שינוי, עם הנוסח והמקור
CREATE TABLE consents (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  kind text NOT NULL CHECK (kind IN ('marketing_sms','marketing_email','computerized_docs')),
  granted boolean NOT NULL,
  source text NOT NULL,
  text_version text NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER consents_ro BEFORE UPDATE OR DELETE ON consents FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

-- CRM-04: יתרת לקוח רק מתנועות
CREATE TABLE customer_ledger (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  amount_agorot bigint NOT NULL, -- חיובי = חוב הלקוח גדל
  source_type text NOT NULL,
  source_id uuid,
  document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_ledger_ro BEFORE UPDATE OR DELETE ON customer_ledger FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

-- ===== משמרות וקופה =====
CREATE TABLE cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  number int NOT NULL,              -- מספר Z רץ לעסק
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('opening','active','closing','closed')),
  opened_by uuid NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float_agorot bigint NOT NULL DEFAULT 0,
  closed_by uuid, closed_at timestamptz,
  expected_cash_agorot bigint, counted_cash_agorot bigint, variance_agorot bigint,
  variance_reason text, variance_approved_by uuid,
  z_report jsonb,
  UNIQUE (tenant_id, number)
);
-- CSH-01: אין משמרת פתוחה כפולה לקופה
CREATE UNIQUE INDEX cash_sessions_one_open ON cash_sessions (register_id) WHERE status <> 'closed';

CREATE TABLE cash_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  session_id uuid NOT NULL REFERENCES cash_sessions(id),
  kind text NOT NULL CHECK (kind IN ('paid_in','drop','expense','no_sale','bank_deposit')),
  amount_agorot bigint NOT NULL DEFAULT 0,
  reason text,
  actor_id uuid NOT NULL,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cash_events_ro BEFORE UPDATE OR DELETE ON cash_events FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

-- ===== מכירות =====
CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  register_id uuid NOT NULL REFERENCES registers(id),
  session_id uuid NOT NULL REFERENCES cash_sessions(id),
  cashier_id uuid NOT NULL,
  customer_id uuid REFERENCES customers(id),
  status text NOT NULL DEFAULT 'payment_pending' CHECK (status IN ('draft','payment_pending','exception','finalized','cancelled')),
  tax_date date NOT NULL,
  gross_agorot bigint NOT NULL, discount_agorot bigint NOT NULL, total_agorot bigint NOT NULL,
  net_agorot bigint NOT NULL, vat_agorot bigint NOT NULL,
  cart_discount_agorot bigint NOT NULL DEFAULT 0,
  rounding_agorot bigint NOT NULL DEFAULT 0, change_agorot bigint NOT NULL DEFAULT 0,
  age_verified_by uuid,
  discount_approved_by uuid,
  document_id uuid,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz
);
CREATE INDEX sales_day ON sales (tenant_id, branch_id, created_at);

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sale_id uuid NOT NULL REFERENCES sales(id),
  line_no int NOT NULL,
  kind text NOT NULL DEFAULT 'item' CHECK (kind IN ('item','deposit')),
  product_id uuid REFERENCES products(id),
  sku text, name text NOT NULL, barcode text,
  qty_milli bigint NOT NULL,
  unit_price_agorot bigint NOT NULL,
  list_price_agorot bigint NOT NULL,   -- PRI-05: מחיר הקטלוג ברגע המכירה
  unit_cost_agorot bigint NOT NULL DEFAULT 0,
  line_discount_agorot bigint NOT NULL DEFAULT 0,
  cart_discount_agorot bigint NOT NULL DEFAULT 0,
  total_agorot bigint NOT NULL,
  rate_bp int NOT NULL, net_agorot bigint NOT NULL, vat_agorot bigint NOT NULL,
  tax_category text NOT NULL,
  UNIQUE (sale_id, line_no)
);

-- POS-02: אחרי סגירת מכירה — אי אפשר לשנות אותה או את השורות שלה
CREATE OR REPLACE FUNCTION dlx_sale_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: sales are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('finalized','cancelled') THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: sale % is %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_guard BEFORE UPDATE OR DELETE ON sales FOR EACH ROW EXECUTE FUNCTION dlx_sale_guard();

CREATE OR REPLACE FUNCTION dlx_sale_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM sales WHERE id = COALESCE(OLD.sale_id, NEW.sale_id);
  IF st IN ('finalized','cancelled') THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: lines of a % sale' , st USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sale_lines_guard BEFORE UPDATE OR DELETE ON sale_lines FOR EACH ROW EXECUTE FUNCTION dlx_sale_line_guard();

-- PAY-02, PAY-03: תשלום עם מפתח idempotency ייחודי ומצבים מוגדרים
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sale_id uuid REFERENCES sales(id),
  return_id uuid,
  customer_id uuid REFERENCES customers(id),
  session_id uuid REFERENCES cash_sessions(id),
  direction text NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
  method text NOT NULL CHECK (method IN ('cash','card','check','transfer','bit','credit_note','customer_account')),
  amount_agorot bigint NOT NULL CHECK (amount_agorot > 0),
  status text NOT NULL CHECK (status IN ('initiated','pending','captured','failed','voided','refunded_partial','refunded_full')),
  provider text NOT NULL DEFAULT 'none',
  provider_ref text,
  approval_code text,
  card_last4 text CHECK (card_last4 IS NULL OR card_last4 ~ '^\d{4}$'), -- אף פעם לא מספר מלא (SEC-03)
  card_brand text,
  installments int,
  check_number text, check_bank text, check_date date,
  idempotency_key text NOT NULL,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE UNIQUE INDEX payments_provider_ref ON payments (tenant_id, provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION dlx_touch();

CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  number int NOT NULL,
  sale_id uuid REFERENCES sales(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  session_id uuid NOT NULL REFERENCES cash_sessions(id),
  cashier_id uuid NOT NULL,
  approved_by uuid,
  reason text NOT NULL,
  total_agorot bigint NOT NULL,
  net_agorot bigint NOT NULL, vat_agorot bigint NOT NULL,
  refund_method text NOT NULL,
  document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE TRIGGER returns_ro BEFORE UPDATE OR DELETE ON returns FOR EACH ROW
  WHEN (OLD.document_id IS NOT NULL) EXECUTE FUNCTION dlx_deny_change();

CREATE TABLE return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  return_id uuid NOT NULL REFERENCES returns(id),
  sale_line_id uuid REFERENCES sale_lines(id),
  product_id uuid REFERENCES products(id),
  name text NOT NULL,
  qty_milli bigint NOT NULL CHECK (qty_milli > 0),
  unit_price_agorot bigint NOT NULL,
  total_agorot bigint NOT NULL,
  rate_bp int NOT NULL, net_agorot bigint NOT NULL, vat_agorot bigint NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('restock','damaged','supplier','none'))
);
CREATE TRIGGER return_lines_ro BEFORE UPDATE OR DELETE ON return_lines FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

-- ===== מסמכים (FIS-01..FIS-10) =====
-- ACC-02, FIS-02: מספור רץ לכל סוג מסמך בעסק. נעילת שורה בעדכון = אין מספר כפול גם בשתי קופות במקביל (QA-01)
CREATE TABLE document_sequences (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  doc_type text NOT NULL,
  next_serial bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, doc_type)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  doc_type text NOT NULL,
  doc_code int NOT NULL,
  serial bigint NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  tax_date date NOT NULL,
  branch_id uuid REFERENCES branches(id),
  register_id uuid REFERENCES registers(id),
  issuer jsonb NOT NULL,     -- TEN-04: פרטי העסק כפי שהיו ברגע ההפקה
  customer jsonb,
  lines jsonb NOT NULL,
  payments jsonb NOT NULL DEFAULT '[]',
  totals jsonb NOT NULL,
  net_agorot bigint NOT NULL, vat_agorot bigint NOT NULL, total_agorot bigint NOT NULL,
  original_document_id uuid REFERENCES documents(id), -- זיכוי → המקור (RET-05, FIS-10)
  source_type text NOT NULL, source_id uuid,
  allocation_number text,
  allocation_status text NOT NULL DEFAULT 'not_required' CHECK (allocation_status IN ('not_required','pending','approved','failed')),
  content_hash text NOT NULL, -- sha256 של התוכן הקבוע
  print_count int NOT NULL DEFAULT 0,
  public_token text UNIQUE,
  created_by uuid NOT NULL,
  UNIQUE (tenant_id, doc_type, serial)
);
CREATE INDEX documents_date ON documents (tenant_id, issued_at);
CREATE INDEX documents_source ON documents (tenant_id, source_type, source_id);

-- FIS-03, QA-03: מסמך שהופק לא משתנה ולא נמחק. מותר רק: מונה הדפסות, מספר הקצאה וקישור צפייה
CREATE OR REPLACE FUNCTION dlx_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: issued documents are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.doc_type, NEW.doc_code, NEW.serial, NEW.status, NEW.issued_at, NEW.tax_date, NEW.branch_id,
      NEW.register_id, NEW.issuer, NEW.customer, NEW.lines, NEW.payments, NEW.totals, NEW.net_agorot, NEW.vat_agorot,
      NEW.total_agorot, NEW.original_document_id, NEW.source_type, NEW.source_id, NEW.content_hash, NEW.created_by)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.doc_type, OLD.doc_code, OLD.serial, OLD.status, OLD.issued_at, OLD.tax_date, OLD.branch_id,
      OLD.register_id, OLD.issuer, OLD.customer, OLD.lines, OLD.payments, OLD.totals, OLD.net_agorot, OLD.vat_agorot,
      OLD.total_agorot, OLD.original_document_id, OLD.source_type, OLD.source_id, OLD.content_hash, OLD.created_by) THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: issued document % cannot be changed', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.print_count < OLD.print_count THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: print count only grows' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.allocation_number IS NOT NULL AND NEW.allocation_number IS DISTINCT FROM OLD.allocation_number THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: allocation number already set' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER documents_guard BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION dlx_document_guard();

CREATE TABLE document_prints (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  mark text NOT NULL,
  format text NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER document_prints_ro BEFORE UPDATE OR DELETE ON document_prints FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

-- API-03: בקשות מספר הקצאה — סטטוס, ניסיונות, תשובה
CREATE TABLE allocation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid REFERENCES documents(id),
  draft jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','failed')),
  attempts int NOT NULL DEFAULT 0,
  request_id text NOT NULL,
  response jsonb,
  allocation_number text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER allocation_requests_touch BEFORE UPDATE ON allocation_requests FOR EACH ROW EXECUTE FUNCTION dlx_touch();

-- ===== ביקורת, idempotency, outbox =====
-- IAM-05, ACC-08, NFR-10: יומן ביקורת append-only עם שרשרת hash (tamper-evident)
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id uuid,
  action text NOT NULL,
  target_type text, target_id text,
  result text NOT NULL DEFAULT 'ok',
  details jsonb NOT NULL DEFAULT '{}',
  ip text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX audit_events_tenant ON audit_events (tenant_id, id);
CREATE TRIGGER audit_events_ro BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  route text NOT NULL,
  request_hash text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

-- ===== RLS לכל הטבלאות העסקיות =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','registers','users','categories','products','barcodes','branch_prices','price_changes',
    'suppliers','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines','stock_movements',
    'inventory_counts','inventory_count_lines','customers','consents','customer_ledger','cash_sessions','cash_events',
    'sales','sale_lines','payments','returns','return_lines','document_sequences','documents','document_prints',
    'allocation_requests','audit_events','idempotency_keys','outbox_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = dlx_tenant()) WITH CHECK (tenant_id = dlx_tenant())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = dlx_tenant()) WITH CHECK (id = dlx_tenant());

-- ===== פונקציות "לפני זיהוי עסק" (SECURITY DEFINER, מחזירות רק את המינימום) =====
CREATE OR REPLACE FUNCTION dlx_login_lookup(p_slug text, p_email text)
RETURNS TABLE (tenant_id uuid, user_id uuid, password_hash text, active boolean, tenant_status text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, u.id, u.password_hash, u.active, t.status
  FROM tenants t JOIN users u ON u.tenant_id = t.id
  WHERE t.slug = lower(p_slug) AND lower(u.email) = lower(p_email)
$$;

CREATE OR REPLACE FUNCTION dlx_pin_lookup(p_slug text)
RETURNS TABLE (tenant_id uuid, user_id uuid, pin_hash text)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, u.id, u.pin_hash
  FROM tenants t JOIN users u ON u.tenant_id = t.id
  WHERE t.slug = lower(p_slug) AND u.active AND u.pin_hash IS NOT NULL AND t.status IN ('active')
$$;

CREATE OR REPLACE FUNCTION dlx_slug_taken(p_slug text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE slug = lower(p_slug))
$$;

-- קישור צפייה ציבורי במסמך (D05): לפי אסימון אקראי בלבד
CREATE OR REPLACE FUNCTION dlx_public_document(p_token text) RETURNS TABLE (tenant_id uuid, document_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT d.tenant_id, d.id FROM documents d WHERE d.public_token = p_token AND length(p_token) >= 32
$$;

-- ===== הרשאות לתפקיד השרת (dlx_app — בלי BYPASSRLS, בלי TRUNCATE) =====
GRANT USAGE ON SCHEMA public TO dlx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dlx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dlx_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO dlx_app;
