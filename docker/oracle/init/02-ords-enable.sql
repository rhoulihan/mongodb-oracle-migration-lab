-- Documents the ORDS-enable of MIG and covers the volume-reuse case where
-- ORDS is already installed. On FIRST boot this defers: gvenzl runs initdb scripts
-- BEFORE the entrypoint installs ORDS, so ORDS_METADATA does not exist yet; the
-- entrypoint re-runs the identical ENABLE_SCHEMA right after `ords install`.
ALTER SESSION SET CONTAINER = FREEPDB1;
BEGIN
  EXECUTE IMMEDIATE q'[
    BEGIN
      ORDS_METADATA.ORDS_ADMIN.ENABLE_SCHEMA(p_enabled => TRUE, p_schema => 'MIG',
                         p_url_mapping_type => 'BASE_PATH',
                         p_url_mapping_pattern => 'mig', p_auto_rest_auth => FALSE);
      COMMIT;
    END;]';
EXCEPTION
  WHEN OTHERS THEN
    DBMS_OUTPUT.PUT_LINE('ORDS enable deferred (ORDS not installed yet): ' || SQLERRM);
END;
/
