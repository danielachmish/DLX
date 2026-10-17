-- פיילוט (17.10.2026): מצב מסמכים לכל עסק וסביבת תרגול.
-- shadow — ברירת מחדל. המערכת עובדת מלא, אבל כל מסמך מודפס כ"פיילוט — לא מסמך רשמי". המסמך הרשמי יוצא מהמערכת הקיימת של הלקוח.
-- live   — מסמכים רשמיים. מותר רק אחרי רישום התוכנה ברשות המסים (DLX_SOFTWARE_REGISTRATION בשרת) ובאישור בעלים.
-- training — סביבת תרגול לקופאים: עסק נפרד, אף פעם לא live.
ALTER TABLE tenants ADD COLUMN documents_mode text NOT NULL DEFAULT 'shadow' CHECK (documents_mode IN ('shadow','live','training'));
ALTER TABLE tenants ADD COLUMN documents_mode_changed_at timestamptz;
ALTER TABLE tenants ADD COLUMN documents_mode_changed_by uuid;
ALTER TABLE tenants ADD COLUMN training_of uuid REFERENCES tenants(id);
CREATE UNIQUE INDEX tenants_training_of ON tenants (training_of) WHERE training_of IS NOT NULL;

-- מצב המסמכים נשמר גם על כל מסמך, כדי שגם בעוד שנה יהיה ברור מה היה רשמי ומה לא
ALTER TABLE documents ADD COLUMN documents_mode text NOT NULL DEFAULT 'shadow' CHECK (documents_mode IN ('shadow','live','training'));

-- הטריגר של מסמך קבוע צריך לכלול גם את מצב המסמכים
CREATE OR REPLACE FUNCTION dlx_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DLX_IMMUTABLE: issued documents are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.doc_type, NEW.doc_code, NEW.serial, NEW.status, NEW.issued_at, NEW.tax_date, NEW.branch_id,
      NEW.register_id, NEW.issuer, NEW.customer, NEW.lines, NEW.payments, NEW.totals, NEW.net_agorot, NEW.vat_agorot,
      NEW.total_agorot, NEW.original_document_id, NEW.source_type, NEW.source_id, NEW.content_hash, NEW.created_by, NEW.documents_mode)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.doc_type, OLD.doc_code, OLD.serial, OLD.status, OLD.issued_at, OLD.tax_date, OLD.branch_id,
      OLD.register_id, OLD.issuer, OLD.customer, OLD.lines, OLD.payments, OLD.totals, OLD.net_agorot, OLD.vat_agorot,
      OLD.total_agorot, OLD.original_document_id, OLD.source_type, OLD.source_id, OLD.content_hash, OLD.created_by, OLD.documents_mode) THEN
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

-- יצירת סביבת תרגול: עסק חדש שמקושר לעסק האם. רץ כבעלים כי ה-RLS לא מאפשר לעסק אחד ליצור עסק אחר.
-- מעתיק סניפים, קופות, משתמשים (כולל PIN — אותו קוד גם בתרגול), קטגוריות, מוצרים וברקודים. לא מעתיק לקוחות, מסמכים או תנועות.
CREATE OR REPLACE FUNCTION dlx_create_training(p_parent uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid := gen_random_uuid(); src tenants%ROWTYPE;
BEGIN
  -- רק העסק של הבקשה עצמה (app.tenant_id) — אי אפשר ליצור תרגול לעסק אחר
  IF p_parent IS DISTINCT FROM dlx_tenant() THEN RAISE EXCEPTION 'DLX_TRAINING: tenant mismatch'; END IF;
  SELECT * INTO src FROM tenants WHERE id = p_parent;
  IF src.id IS NULL OR src.training_of IS NOT NULL THEN RAISE EXCEPTION 'DLX_TRAINING: bad parent'; END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE training_of = p_parent) THEN
    RETURN (SELECT id FROM tenants WHERE training_of = p_parent);
  END IF;
  INSERT INTO tenants (id, slug, legal_name, trade_name, tax_id, tax_status, address, phone, email, return_days, return_policy, receipt_footer, documents_mode, training_of)
  VALUES (t, left(src.slug, 34) || '-train', src.legal_name, COALESCE(src.trade_name, src.legal_name) || ' (תרגול)', src.tax_id, src.tax_status, src.address, src.phone, src.email,
          src.return_days, src.return_policy, src.receipt_footer, 'training', p_parent);
  CREATE TEMP TABLE IF NOT EXISTS _map (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  DELETE FROM _map;
  INSERT INTO _map SELECT id, gen_random_uuid() FROM branches WHERE tenant_id = p_parent;
  INSERT INTO branches (id, tenant_id, name, address, tax_zone, active)
    SELECT m.new, t, b.name, b.address, b.tax_zone, b.active FROM branches b JOIN _map m ON m.old = b.id;
  INSERT INTO _map SELECT id, gen_random_uuid() FROM registers WHERE tenant_id = p_parent;
  INSERT INTO registers (id, tenant_id, branch_id, code, name, active)
    SELECT m.new, t, mb.new, r.code, r.name, r.active FROM registers r JOIN _map m ON m.old = r.id JOIN _map mb ON mb.old = r.branch_id;
  INSERT INTO users (tenant_id, name, email, password_hash, pin_hash, role, branch_id, active)
    SELECT t, u.name, u.email, u.password_hash, u.pin_hash, u.role, mb.new, u.active FROM users u LEFT JOIN _map mb ON mb.old = u.branch_id WHERE u.tenant_id = p_parent;
  INSERT INTO _map SELECT id, gen_random_uuid() FROM categories WHERE tenant_id = p_parent;
  INSERT INTO categories (id, tenant_id, name) SELECT m.new, t, c.name FROM categories c JOIN _map m ON m.old = c.id;
  INSERT INTO _map SELECT id, gen_random_uuid() FROM products WHERE tenant_id = p_parent AND status = 'active';
  INSERT INTO products (id, tenant_id, sku, name, description, category_id, brand, unit_measure, sold_by_weight, price_agorot, cost_agorot, tax_category,
      restriction, deposit_agorot, unit_price_basis, unit_price_factor_milli, track_stock, min_stock_milli, status, scale_code)
    SELECT m.new, t, p.sku, p.name, p.description, mc.new, p.brand, p.unit_measure, p.sold_by_weight, p.price_agorot, p.cost_agorot, p.tax_category,
      p.restriction, p.deposit_agorot, p.unit_price_basis, p.unit_price_factor_milli, false, 0, 'active', p.scale_code
    FROM products p JOIN _map m ON m.old = p.id LEFT JOIN _map mc ON mc.old = p.category_id;
  INSERT INTO barcodes (tenant_id, barcode, product_id, unit_factor_milli, kind)
    SELECT t, b.barcode, m.new, b.unit_factor_milli, b.kind FROM barcodes b JOIN _map m ON m.old = b.product_id;
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION dlx_create_training(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dlx_create_training(uuid) TO dlx_app;

-- קוד הכניסה של סביבת התרגול (ה-RLS לא מאפשר לראות שורת עסק אחר)
CREATE OR REPLACE FUNCTION dlx_training_slug(p_parent uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT slug FROM tenants WHERE training_of = p_parent AND p_parent = dlx_tenant()
$$;
GRANT EXECUTE ON FUNCTION dlx_training_slug(uuid) TO dlx_app;
