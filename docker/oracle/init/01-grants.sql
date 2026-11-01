-- Pre-create MIG (normally already created by the gvenzl APP_USER convention) and
-- grant the privileges the demos use. Runs as SYSDBA at initdb time (gvenzl convention),
-- and again on every container start (docker/oracle/scripts/entrypoint.sh), so grants
-- added later also reach an existing data volume. Idempotent.
ALTER SESSION SET CONTAINER = FREEPDB1;
BEGIN
  BEGIN
    EXECUTE IMMEDIATE 'CREATE USER mig IDENTIFIED BY "MigUser2026" QUOTA UNLIMITED ON users';
  EXCEPTION WHEN OTHERS THEN
    IF SQLCODE != -1920 THEN RAISE; END IF;  -- ORA-01920: user already exists (created by image)
  END;
  EXECUTE IMMEDIATE 'ALTER USER mig QUOTA UNLIMITED ON users';
  EXECUTE IMMEDIATE 'GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE PROCEDURE,
    CREATE TRIGGER, CREATE SEQUENCE, CREATE MATERIALIZED VIEW, CREATE PROPERTY GRAPH,
    SODA_APP TO mig';
END;
/
-- Measurement helpers (lib/measure.mjs): redo size from v$mystat (D5), and
-- DBMS_XPLAN.DISPLAY_CURSOR plans of the last execution (D3, D6).
GRANT SELECT ON sys.v_$mystat TO mig;
GRANT SELECT ON sys.v_$statname TO mig;
GRANT SELECT ON sys.v_$session TO mig;
GRANT SELECT ON sys.v_$sql TO mig;
GRANT SELECT ON sys.v_$sql_plan TO mig;
GRANT SELECT ON sys.v_$sql_plan_statistics_all TO mig;
