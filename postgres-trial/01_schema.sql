BEGIN;

CREATE SCHEMA barmanager;
SET LOCAL search_path = barmanager, pg_catalog;

CREATE TABLE venues (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    responsible_user_id uuid NOT NULL,
    name text NOT NULL CHECK (btrim(name) <> ''),
    low_stock_days integer NOT NULL DEFAULT 3 CHECK (low_stock_days > 0)
);

CREATE TABLE locations (
    venue_id uuid NOT NULL REFERENCES venues(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    time_zone text NOT NULL DEFAULT 'Europe/Moscow',
    PRIMARY KEY (venue_id, id)
);

CREATE TABLE items (
    venue_id uuid NOT NULL REFERENCES venues(id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (btrim(name) <> ''),
    base_unit text NOT NULL CHECK (base_unit IN ('l', 'kg', 'pcs')),
    PRIMARY KEY (venue_id, id)
);

CREATE TABLE documents (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_namespace text NOT NULL CHECK (btrim(source_namespace) <> ''),
    source_key text NOT NULL CHECK (btrim(source_key) <> ''),
    kind text NOT NULL CHECK (kind IN ('invoice', 'inventory', 'stock', 'usage')),
    PRIMARY KEY (venue_id, location_id, id),
    FOREIGN KEY (venue_id, location_id) REFERENCES locations,
    UNIQUE (venue_id, location_id, source_namespace, source_key)
);

CREATE TABLE document_versions (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    document_id uuid NOT NULL,
    version_no integer NOT NULL CHECK (version_no > 0),
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    document_date date NOT NULL,
    active boolean NOT NULL DEFAULT false,
    PRIMARY KEY (venue_id, location_id, document_id, version_no),
    FOREIGN KEY (venue_id, location_id, document_id) REFERENCES documents,
    UNIQUE (venue_id, location_id, document_id, content_hash)
);
CREATE UNIQUE INDEX one_active_version
    ON document_versions (venue_id, location_id, document_id) WHERE active;

-- Проверенные строки. В тесте все количества приведены к базовой единице.
-- Прайс и накладная хранят рубли на одинаковой налоговой базе, включая скидки.
CREATE TABLE observations (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    document_id uuid NOT NULL,
    version_no integer NOT NULL,
    line_no integer NOT NULL CHECK (line_no > 0),
    item_id uuid NOT NULL,
    supplier_key text,
    quantity numeric(20,6) CHECK (quantity >= 0),
    book_quantity numeric(20,6) CHECK (book_quantity >= 0),
    unit_price_rub numeric(20,6) CHECK (unit_price_rub >= 0),
    period_start date,
    PRIMARY KEY (venue_id, location_id, document_id, version_no, line_no),
    FOREIGN KEY (venue_id, location_id, document_id, version_no) REFERENCES document_versions,
    FOREIGN KEY (venue_id, item_id) REFERENCES items
);
CREATE INDEX observations_by_item ON observations (venue_id, location_id, item_id);

CREATE TABLE supplier_prices (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    item_id uuid NOT NULL,
    supplier_key text NOT NULL CHECK (btrim(supplier_key) <> ''),
    effective_from date NOT NULL,
    unit_price_rub numeric(20,6) NOT NULL CHECK (unit_price_rub > 0),
    PRIMARY KEY (venue_id, location_id, item_id, supplier_key, effective_from),
    FOREIGN KEY (venue_id, location_id) REFERENCES locations,
    FOREIGN KEY (venue_id, item_id) REFERENCES items
);

CREATE TABLE legacy_imports (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, location_id, id),
    FOREIGN KEY (venue_id, location_id) REFERENCES locations,
    UNIQUE (venue_id, location_id, content_hash)
);

CREATE TABLE legacy_records (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    import_id uuid NOT NULL,
    kind text NOT NULL,
    source_key text NOT NULL,
    original jsonb NOT NULL CHECK (jsonb_typeof(original) = 'object'),
    PRIMARY KEY (venue_id, location_id, import_id, kind, source_key),
    FOREIGN KEY (venue_id, location_id, import_id) REFERENCES legacy_imports
);

CREATE TABLE audit_events (
    venue_id uuid NOT NULL,
    location_id uuid NOT NULL,
    import_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    action text NOT NULL CHECK (action = 'legacy_backup_staged'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (venue_id, location_id, import_id, action),
    FOREIGN KEY (venue_id, location_id, import_id) REFERENCES legacy_imports
);

-- Контекст задаёт доверенный сервер после проверки сессии, в пределах транзакции.
-- Прикладная роль используется только через сервер, прямого доступа у клиента нет.
CREATE FUNCTION session_user_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$
    SELECT nullif(current_setting('barmanager.user_id', true), '')::uuid
$$;

ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE venues FORCE ROW LEVEL SECURITY;
CREATE POLICY responsible_venue ON venues FOR SELECT
    USING (responsible_user_id = barmanager.session_user_id());

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'locations', 'items', 'documents', 'document_versions', 'observations',
        'supplier_prices', 'legacy_imports', 'legacy_records', 'audit_events'
    ] LOOP
        EXECUTE format('ALTER TABLE barmanager.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE barmanager.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY venue_scope ON barmanager.%I
             USING (venue_id IN (SELECT id FROM barmanager.venues))
             WITH CHECK (venue_id IN (SELECT id FROM barmanager.venues))',
            table_name
        );
    END LOOP;
END $$;

-- Переносит только data из v2 в область проверки. Пароли, профиль, чат, роли
-- и старые решения не импортируются. Ничего из буфера не влияет на расчёты.
CREATE FUNCTION stage_v2_backup(target_venue uuid, target_location uuid, backup jsonb)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, barmanager
AS $$
DECLARE
    data jsonb := backup -> 'data';
    fingerprint bytea;
    batch_id uuid;
    entry_kind text;
    expected_shape text;
BEGIN
    IF backup -> 'v' IS DISTINCT FROM '2'::jsonb
        OR jsonb_typeof(data) IS DISTINCT FROM 'object'
        OR backup ->> 'mode' IS DISTINCT FROM 'own' THEN
        RAISE EXCEPTION 'Expected a v2 backup from own-bar mode';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM locations WHERE venue_id = target_venue AND id = target_location
    ) THEN
        RAISE EXCEPTION 'Location unavailable';
    END IF;

    FOR entry_kind, expected_shape IN
        SELECT * FROM (VALUES ('prices', 'object'), ('stock', 'object'),
           ('counts', 'array'), ('invoices', 'array'), ('receipts', 'array'), ('sales', 'array'),
           ('ttk', 'array'), ('writeoffs', 'array')) AS sections(kind, shape)
    LOOP
        IF data ? entry_kind AND jsonb_typeof(data -> entry_kind) <> expected_shape THEN
            RAISE EXCEPTION 'Invalid backup section: %', entry_kind;
        END IF;
    END LOOP;

    -- Хешируем только раздел, который реально переносим.
    data := data - ARRAY(SELECT jsonb_object_keys(data) EXCEPT
        SELECT unnest(ARRAY['prices', 'stock', 'counts', 'invoices', 'receipts', 'sales', 'ttk', 'writeoffs']));
    fingerprint := sha256(convert_to(data::text, 'UTF8'));
    INSERT INTO legacy_imports (venue_id, location_id, content_hash)
    VALUES (target_venue, target_location, fingerprint)
    ON CONFLICT (venue_id, location_id, content_hash) DO NOTHING
    RETURNING id INTO batch_id;

    IF batch_id IS NULL THEN
        SELECT id INTO STRICT batch_id FROM legacy_imports
        WHERE venue_id = target_venue AND location_id = target_location
          AND content_hash = fingerprint;
        RETURN batch_id;
    END IF;

    INSERT INTO legacy_records (venue_id, location_id, import_id, kind, source_key, original)
    SELECT target_venue, target_location, batch_id, section.kind, entry.key, entry.value
    FROM (VALUES ('prices'), ('stock')) AS section(kind)
    CROSS JOIN LATERAL jsonb_each(data -> section.kind) AS entry(key, value)
    UNION ALL
    SELECT target_venue, target_location, batch_id, section.kind, entry.ordinal::text, entry.value
    FROM (VALUES ('counts'), ('invoices'), ('receipts'), ('sales'), ('ttk'), ('writeoffs')) AS section(kind)
    CROSS JOIN LATERAL jsonb_array_elements(data -> section.kind)
        WITH ORDINALITY AS entry(value, ordinal);

    INSERT INTO audit_events (venue_id, location_id, import_id, actor_id, action)
    VALUES (target_venue, target_location, batch_id, session_user_id(), 'legacy_backup_staged');

    RETURN batch_id;
END $$;

CREATE VIEW price_alerts WITH (security_invoker = true) AS
SELECT o.venue_id, o.location_id, o.document_id, o.line_no, o.item_id, v.document_date,
       o.unit_price_rub AS invoice_price_rub, p.unit_price_rub AS contract_price_rub,
       round((o.unit_price_rub - p.unit_price_rub) * o.quantity, 2) AS difference_rub
FROM observations AS o
JOIN document_versions AS v USING (venue_id, location_id, document_id, version_no)
JOIN documents AS d ON (d.venue_id, d.location_id, d.id)
    = (o.venue_id, o.location_id, o.document_id)
JOIN LATERAL (
    SELECT unit_price_rub FROM supplier_prices AS p
    WHERE p.venue_id = o.venue_id AND p.location_id = o.location_id
      AND p.item_id = o.item_id AND p.supplier_key = o.supplier_key
      AND p.effective_from <= v.document_date
    ORDER BY effective_from DESC LIMIT 1
) AS p ON true
WHERE v.active AND d.kind = 'invoice' AND o.quantity > 0
  AND o.unit_price_rub > p.unit_price_rub;

CREATE VIEW monthly_price_differences WITH (security_invoker = true) AS
SELECT venue_id, location_id, date_trunc('month', document_date::timestamp)::date AS month_start,
       count(*) AS affected_lines, sum(difference_rub) AS difference_rub
FROM price_alerts
GROUP BY venue_id, location_id, date_trunc('month', document_date::timestamp)::date;

CREATE VIEW inventory_discrepancies WITH (security_invoker = true) AS
SELECT o.venue_id, o.location_id, o.document_id, o.line_no, o.item_id, v.document_date,
       o.book_quantity, o.quantity AS fact_quantity, o.quantity - o.book_quantity AS variance
FROM observations AS o
JOIN document_versions AS v USING (venue_id, location_id, document_id, version_no)
JOIN documents AS d ON (d.venue_id, d.location_id, d.id)
    = (o.venue_id, o.location_id, o.document_id)
WHERE v.active AND d.kind = 'inventory'
  AND (o.quantity IS NULL OR o.book_quantity IS NULL OR o.quantity <> o.book_quantity);

CREATE VIEW low_stock_alerts WITH (security_invoker = true) AS
WITH current_inputs AS (
    SELECT DISTINCT ON (o.venue_id, o.location_id, o.item_id, d.kind)
           o.venue_id, o.location_id, o.item_id, d.kind, o.quantity,
           o.period_start, v.document_date
    FROM observations AS o
    JOIN document_versions AS v USING (venue_id, location_id, document_id, version_no)
    JOIN documents AS d ON (d.venue_id, d.location_id, d.id)
        = (o.venue_id, o.location_id, o.document_id)
    WHERE v.active AND d.kind IN ('stock', 'usage')
    ORDER BY o.venue_id, o.location_id, o.item_id, d.kind,
             v.document_date DESC, o.document_id, o.line_no
), estimates AS (
    SELECT s.venue_id, s.location_id, s.item_id, s.quantity,
           s.document_date AS stock_date, u.period_start, u.document_date AS usage_end,
           s.quantity * (u.document_date - u.period_start + 1)
             / nullif(u.quantity, 0) AS days_left,
           v.low_stock_days
    FROM current_inputs AS s
    JOIN current_inputs AS u USING (venue_id, location_id, item_id)
    JOIN venues AS v ON v.id = s.venue_id
    WHERE s.kind = 'stock' AND u.kind = 'usage' AND u.quantity > 0
      AND s.quantity IS NOT NULL AND u.period_start <= u.document_date
      AND u.document_date = s.document_date
)
SELECT venue_id, location_id, item_id, quantity, stock_date,
       period_start, usage_end, round(days_left, 2) AS days_left
FROM estimates
WHERE days_left <= low_stock_days;

REVOKE ALL ON SCHEMA barmanager FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION barmanager.stage_v2_backup(uuid, uuid, jsonb) FROM PUBLIC;

COMMIT;
