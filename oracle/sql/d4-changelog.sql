-- D4 reverse capture for the stand-in replicator (a stand-in for Oracle
-- GoldenGate): every change to a MIG collection lands in mig_changelog, which
-- replicator/reverse.mjs replays into MongoDB after the cutover.
-- Statements end with a line holding only "/", so the trigger body can carry
-- its own semicolons. replicator/capture.mjs runs this file (after D4's
-- initial load, so the load itself is never captured); it also runs as-is in
-- SQLcl: @oracle/sql/d4-changelog.sql
--
-- Loop prevention: the forward applier (MongoDB to Oracle) writes through the
-- Oracle API for MongoDB, so its writes run in ORDS sessions, and ORDS sets
-- CLIENT_INFO itself on every operation to ["<lsid>",<txn>,"<op>"], where
-- <lsid> is the MongoDB logical session id the driver sent. A CLIENT_INFO set
-- by the replicator process never reaches those sessions. So the forward
-- applier sends every write in one explicit MongoDB session and registers its
-- lsid in mig_repl_session; the trigger skips any statement whose CLIENT_INFO
-- starts with a registered lsid. Everything else (the app after the cutover,
-- Oracle's own TTL deletes) is captured.
DROP TABLE IF EXISTS mig_changelog PURGE
/
DROP TABLE IF EXISTS mig_repl_session PURGE
/
CREATE TABLE mig_repl_session (
  lsid          VARCHAR2(64) PRIMARY KEY,
  direction     VARCHAR2(8)  NOT NULL,
  registered_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
)
/
-- One row per changed document. id is the document's _id as Oracle extended
-- JSON text; doc is the document after the change (before it, for a delete).
-- seq is NOCACHE, so the only gaps come from rolled-back writes.
CREATE TABLE mig_changelog (
  seq         NUMBER GENERATED ALWAYS AS IDENTITY (NOCACHE) PRIMARY KEY,
  coll        VARCHAR2(64)  NOT NULL,
  op          CHAR(1)       NOT NULL,
  id          VARCHAR2(400) NOT NULL,
  doc         JSON,
  client_info VARCHAR2(64),
  changed_at  TIMESTAMP(6) WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
)
/
-- One compound trigger per JSON collection table (the eight in
-- 00-target-prep.sql): the skip decision once per statement, a log row per
-- changed document.
BEGIN
  FOR t IN (SELECT column_value AS coll FROM TABLE(sys.odcivarchar2list(
              'regions', 'catalog', 'accounts', 'subscribers', 'orders', 'carts', 'orderEvents', 'regionTopDevices'))) LOOP
    EXECUTE IMMEDIATE REPLACE(REPLACE(q'~
CREATE OR REPLACE TRIGGER MIG_CAP_#U#
FOR INSERT OR UPDATE OR DELETE ON "#C#"
COMPOUND TRIGGER
  skip BOOLEAN := FALSE;

  BEFORE STATEMENT IS
    n PLS_INTEGER;
  BEGIN
    SELECT COUNT(*) INTO n FROM mig_repl_session
     WHERE INSTR(SYS_CONTEXT('USERENV', 'CLIENT_INFO'), '["' || lsid || '"') = 1;
    skip := n > 0;
  END BEFORE STATEMENT;

  AFTER EACH ROW IS
    v_doc JSON;
    v_op  CHAR(1);
  BEGIN
    IF NOT skip THEN
      IF DELETING THEN v_doc := :old.data; v_op := 'D';
      ELSIF UPDATING THEN v_doc := :new.data; v_op := 'U';
      ELSE v_doc := :new.data; v_op := 'I';
      END IF;
      INSERT INTO mig_changelog (coll, op, id, doc, client_info)
      VALUES ('#C#', v_op,
              JSON_SERIALIZE(JSON_QUERY(v_doc, '$._id' RETURNING JSON) RETURNING VARCHAR2(400) EXTENDED),
              v_doc, SUBSTR(SYS_CONTEXT('USERENV', 'CLIENT_INFO'), 1, 64));
    END IF;
  END AFTER EACH ROW;
END;~', '#C#', t.coll), '#U#', UPPER(t.coll));
  END LOOP;
END;
/
