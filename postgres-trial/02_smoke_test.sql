-- Запускать после 01_schema.sql в тестовой базе от роли с правом CREATE ROLE
-- и с обходом RLS. В конце откатываются роль и все тестовые строки.
BEGIN;
SET LOCAL search_path = barmanager, pg_catalog;

CREATE ROLE barmanager_trial_check NOLOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA barmanager TO barmanager_trial_check;
GRANT SELECT ON ALL TABLES IN SCHEMA barmanager TO barmanager_trial_check;
GRANT INSERT ON legacy_imports, legacy_records, audit_events TO barmanager_trial_check;
GRANT EXECUTE ON FUNCTION stage_v2_backup(uuid, uuid, jsonb) TO barmanager_trial_check;

INSERT INTO venues (id, responsible_user_id, name) VALUES
    ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Бар А'),
    ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Бар Б');
INSERT INTO locations (venue_id, id, name)
SELECT id, '30000000-0000-0000-0000-000000000001', 'Основная точка' FROM venues;
INSERT INTO items (venue_id, id, name, base_unit)
SELECT id, '40000000-0000-0000-0000-000000000001', 'Джин', 'l' FROM venues;
INSERT INTO documents (venue_id, location_id, id, source_namespace, source_key, kind)
SELECT v.id, l.id, d.id::uuid, 'pilot', d.kind, d.kind
FROM venues v JOIN locations l ON l.venue_id = v.id
CROSS JOIN (VALUES
    ('50000000-0000-0000-0000-000000000001', 'inventory'),
    ('50000000-0000-0000-0000-000000000002', 'stock'),
    ('50000000-0000-0000-0000-000000000003', 'usage'),
    ('50000000-0000-0000-0000-000000000004', 'invoice')
) AS d(id, kind);
INSERT INTO document_versions (venue_id, location_id, document_id, version_no, content_hash, document_date, active)
SELECT venue_id, location_id, id, 1, sha256(convert_to(kind, 'UTF8')), '2026-11-20', true FROM documents;

INSERT INTO observations (venue_id, location_id, document_id, version_no, line_no,
    item_id, quantity, book_quantity, supplier_key, unit_price_rub, period_start)
SELECT d.venue_id, d.location_id, d.id, 1, 1, i.id,
    CASE d.kind WHEN 'stock' THEN 4 WHEN 'usage' THEN 14 WHEN 'inventory' THEN 4 ELSE 10 END,
    CASE WHEN d.kind = 'inventory' THEN 5 END,
    CASE WHEN d.kind = 'invoice' THEN 'supplier-1' END,
    CASE WHEN d.kind = 'invoice' THEN 120 END,
    CASE WHEN d.kind = 'usage' THEN DATE '2026-11-14' END
FROM documents d JOIN items i USING (venue_id);
INSERT INTO observations (venue_id, location_id, document_id, version_no, line_no, item_id, book_quantity)
SELECT d.venue_id, d.location_id, d.id, 1, 2, i.id, 5
FROM documents d JOIN items i USING (venue_id) WHERE kind = 'inventory';
INSERT INTO supplier_prices (venue_id, location_id, item_id, supplier_key, effective_from, unit_price_rub)
SELECT l.venue_id, l.id, i.id, 'supplier-1', p.effective_from, p.unit_price
FROM locations l JOIN items i USING (venue_id)
CROSS JOIN (VALUES (DATE '2026-11-01', 100), (DATE '2026-12-01', 150)) p(effective_from, unit_price);

SET LOCAL ROLE barmanager_trial_check;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM price_alerts) THEN
        RAISE EXCEPTION 'Missing auth context must hide rows';
    END IF;
END $$;

SELECT set_config('barmanager.user_id', '20000000-0000-0000-0000-000000000001', true);

DO $$
DECLARE
    venue_a constant uuid := '10000000-0000-0000-0000-000000000001';
    venue_b constant uuid := '10000000-0000-0000-0000-000000000002';
    location_id constant uuid := '30000000-0000-0000-0000-000000000001';
    backup constant jsonb := '{
        "v": 2, "mode": "own", "user": {"phone": "omitted"},
        "data": {
          "prices": {"Джин": {"price": 100}},
          "stock": {"Джин": {"qty": 4, "unit": "л"}},
          "counts": [{"rows": [{"pos": "Джин", "book": 5, "fact": 4}]}],
          "receipts": [{"invoiceId": "test-invoice", "rows": [{"pos": "Джин", "qty": 2}]}]
        }
    }';
    batch_id uuid;
BEGIN
    IF (SELECT count(*) FROM venues) <> 1
       OR EXISTS (SELECT 1 FROM documents WHERE venue_id = venue_b) THEN
        RAISE EXCEPTION 'Venue isolation failed';
    END IF;
    IF (SELECT difference_rub FROM price_alerts) IS DISTINCT FROM 200 THEN
        RAISE EXCEPTION 'Expected exactly 200 RUB';
    END IF;
    IF (SELECT difference_rub FROM monthly_price_differences) IS DISTINCT FROM 200
       OR (SELECT month_start FROM monthly_price_differences) IS DISTINCT FROM DATE '2026-11-01' THEN
        RAISE EXCEPTION 'Unexpected monthly total';
    END IF;
    IF (SELECT days_left FROM low_stock_alerts) IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Expected 2 days left';
    END IF;
    IF (SELECT variance FROM inventory_discrepancies WHERE line_no = 1) IS DISTINCT FROM -1
       OR NOT EXISTS (SELECT 1 FROM inventory_discrepancies WHERE line_no = 2 AND variance IS NULL) THEN
        RAISE EXCEPTION 'Inventory variance or missing-value handling is wrong';
    END IF;

    batch_id := stage_v2_backup(venue_a, location_id, backup);
    IF stage_v2_backup(venue_a, location_id, backup - 'user') <> batch_id
       OR (SELECT count(*) FROM legacy_imports) <> 1
       OR (SELECT count(*) FROM legacy_records) <> 4
       OR NOT EXISTS (SELECT 1 FROM legacy_records WHERE kind = 'receipts'
                      AND original ->> 'invoiceId' = 'test-invoice')
       OR (SELECT count(*) FROM audit_events) <> 1 THEN
        RAISE EXCEPTION 'Retry created duplicate records';
    END IF;
    IF (SELECT count(*) FROM price_alerts) <> 1 THEN
        RAISE EXCEPTION 'Staged legacy data must not affect alerts';
    END IF;

    BEGIN
        PERFORM stage_v2_backup(venue_b, location_id, backup);
        RAISE EXCEPTION 'Unauthorized stage succeeded' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'Location unavailable' THEN RAISE; END IF;
    END;

    BEGIN
        PERFORM stage_v2_backup(venue_a, location_id, jsonb_set(backup, '{data,stock}', '[]'));
        RAISE EXCEPTION 'Malformed backup passed validation' USING ERRCODE = 'XX000';
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'Invalid backup section: stock' THEN RAISE; END IF;
    END;
END $$;

SELECT set_config('barmanager.user_id', '20000000-0000-0000-0000-000000000002', true);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM legacy_imports)
       OR (SELECT venue_id FROM price_alerts) IS DISTINCT FROM
          '10000000-0000-0000-0000-000000000002'::uuid THEN
        RAISE EXCEPTION 'Switching users leaked the first venue';
    END IF;
END $$;

RESET ROLE;
UPDATE document_versions SET active = false
WHERE venue_id = '10000000-0000-0000-0000-000000000001'
  AND document_id = '50000000-0000-0000-0000-000000000004';

INSERT INTO document_versions (venue_id, location_id, document_id, version_no, content_hash, document_date, active)
SELECT venue_id, location_id, document_id, 2, sha256(convert_to('confirmed correction', 'UTF8')), document_date, true
FROM document_versions
WHERE venue_id = '10000000-0000-0000-0000-000000000001'
  AND document_id = '50000000-0000-0000-0000-000000000004';
INSERT INTO observations (venue_id, location_id, document_id, version_no, line_no, item_id,
    quantity, supplier_key, unit_price_rub)
SELECT venue_id, location_id, document_id, 2, line_no, item_id, quantity, supplier_key, 125
FROM observations
WHERE venue_id = '10000000-0000-0000-0000-000000000001'
  AND document_id = '50000000-0000-0000-0000-000000000004';

SET LOCAL ROLE barmanager_trial_check;
SELECT set_config('barmanager.user_id', '20000000-0000-0000-0000-000000000001', true);
DO $$
BEGIN
    IF (SELECT difference_rub FROM monthly_price_differences) IS DISTINCT FROM 250 THEN
        RAISE EXCEPTION 'A superseded invoice version still contributes to the report';
    END IF;
END $$;

ROLLBACK;
