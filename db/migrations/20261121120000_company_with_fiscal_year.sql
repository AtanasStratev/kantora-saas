-- migrate:up

-- A new company starts with the current calendar year and its 12 monthly periods, so the
-- shell always has a period to show. Ledger currency follows the era rule (ADR-0004);
-- the fiscal_year CHECK constraint enforces it as well.
CREATE OR REPLACE FUNCTION app.create_company(p_name text, p_eik text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_role app.office_role := app.current_office_role();
  v_office uuid := app.current_office_id();
  v_id uuid;
  v_year int := extract(year FROM current_date)::int;
  v_fy uuid;
  m int;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'chief_accountant') THEN
    RAISE EXCEPTION 'Нямате право да създавате фирми в тази кантора.' USING ERRCODE = '42501';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) = 0 THEN
    RAISE EXCEPTION 'Въведете име на фирмата.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.company (office_id, name, eik)
  VALUES (v_office, trim(p_name), nullif(trim(p_eik), ''))
  RETURNING id INTO v_id;
  INSERT INTO app.company_access (office_id, user_id, company_id)
  VALUES (v_office, app.current_user_id(), v_id);

  INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
  VALUES (v_office, v_id, v_year, make_date(v_year, 1, 1), make_date(v_year, 12, 31),
          CASE WHEN v_year <= 2025 THEN 'BGN' ELSE 'EUR' END::app.ledger_currency)
  RETURNING id INTO v_fy;
  FOR m IN 1..12 LOOP
    INSERT INTO app.period (office_id, company_id, fiscal_year_id, month, start_date, end_date)
    VALUES (v_office, v_id, v_fy, m, make_date(v_year, m, 1),
            (make_date(v_year, m, 1) + interval '1 month - 1 day')::date);
  END LOOP;
  RETURN v_id;
END
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION app.create_company(p_name text, p_eik text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_role app.office_role := app.current_office_role();
  v_id uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'chief_accountant') THEN
    RAISE EXCEPTION 'Нямате право да създавате фирми в тази кантора.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.company (office_id, name, eik)
  VALUES (app.current_office_id(), p_name, p_eik)
  RETURNING id INTO v_id;
  INSERT INTO app.company_access (office_id, user_id, company_id)
  VALUES (app.current_office_id(), app.current_user_id(), v_id);
  RETURN v_id;
END
$$;
