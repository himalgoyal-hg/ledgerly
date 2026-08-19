-- Classification is mutable, money is not (Himal, 18 Aug 2026): the
-- append-only guard on JournalLine now lets an UPDATE through when ONLY
-- costCentreId changes — tier-3 tagging — so the master register's word can
-- reach already-posted lines without sleeping triggers. Amounts, account,
-- entry and memo stay immutable; DELETE stays forbidden; JournalEntry
-- triggers are untouched.

CREATE OR REPLACE FUNCTION forbid_line_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id          IS NOT DISTINCT FROM OLD.id
     AND NEW."entryId"   IS NOT DISTINCT FROM OLD."entryId"
     AND NEW."accountId" IS NOT DISTINCT FROM OLD."accountId"
     AND NEW.debit       IS NOT DISTINCT FROM OLD.debit
     AND NEW.credit      IS NOT DISTINCT FROM OLD.credit
     AND NEW.memo        IS NOT DISTINCT FROM OLD.memo THEN
    RETURN NEW; -- only costCentreId (re)classification — allowed
  END IF;
  RAISE EXCEPTION 'Ledger is append-only: % on % is forbidden (post a reversal instead)',
    TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "journal_line_immutable" ON "JournalLine";
CREATE TRIGGER "journal_line_immutable"
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_line_mutation();
