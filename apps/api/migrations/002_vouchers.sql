-- G-06: שובר זיכוי (זיכוי חנות) — נוצר מהחזרה, ממומש כאמצעי תשלום. היתרה רק מתנועות.
-- זה התחייבות של העסק, לא הכנסה: ההכנסה כבר בוטלה בחשבונית הזיכוי, והמימוש משלם על מכירה חדשה.
-- תוקף ברירת מחדל: שנתיים (לאמת מול חוק הגנת הצרכן — docs/compliance.md).
CREATE TABLE vouchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  initial_agorot bigint NOT NULL CHECK (initial_agorot > 0),
  customer_id uuid REFERENCES customers(id),
  source_type text NOT NULL,
  source_id uuid,
  expires_at date NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE TRIGGER vouchers_ro BEFORE UPDATE OR DELETE ON vouchers FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

CREATE TABLE voucher_ledger (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  voucher_id uuid NOT NULL REFERENCES vouchers(id),
  amount_agorot bigint NOT NULL, -- חיובי = טעינה, שלילי = מימוש
  payment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER voucher_ledger_ro BEFORE UPDATE OR DELETE ON voucher_ledger FOR EACH ROW EXECUTE FUNCTION dlx_deny_change();

ALTER TABLE payments ADD COLUMN voucher_id uuid REFERENCES vouchers(id);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vouchers USING (tenant_id = dlx_tenant()) WITH CHECK (tenant_id = dlx_tenant());
ALTER TABLE voucher_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON voucher_ledger USING (tenant_id = dlx_tenant()) WITH CHECK (tenant_id = dlx_tenant());

GRANT SELECT, INSERT ON vouchers, voucher_ledger TO dlx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dlx_app;
