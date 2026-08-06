-- Ledger invariants (spec §4, §11.1) — enforced at the database level so no
-- application bug can ever unbalance the books.

-- 1. Each line posts to exactly one side, with a positive amount.
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "line_one_side_positive"
  CHECK (debit >= 0 AND credit >= 0 AND ((debit = 0) <> (credit = 0)));

-- 2. Total Dr = total Cr per entry, checked at COMMIT (deferred), so
--    multi-line inserts settle before the rule fires.
CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE
  eid text;
  d numeric;
  c numeric;
BEGIN
  IF TG_TABLE_NAME = 'JournalLine' THEN
    eid := COALESCE(NEW."entryId", OLD."entryId");
  ELSE
    eid := NEW.id;
  END IF;
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO d, c FROM "JournalLine" WHERE "entryId" = eid;
  IF d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal entry % does not balance (Dr % / Cr %)', eid, d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "entry_balanced_lines"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- Also fire per entry so an entry with NO lines is rejected too.
CREATE CONSTRAINT TRIGGER "entry_balanced"
  AFTER INSERT ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();

-- 3. The ledger is append-only. Lines never change; entries are never
--    deleted; only the entry's state bookkeeping may be updated.
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger is append-only: % on % is forbidden (post a reversal instead)',
    TG_OP, TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_line_immutable"
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER "journal_entry_no_delete"
  BEFORE DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE OR REPLACE FUNCTION restrict_entry_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW."entityId"    IS DISTINCT FROM OLD."entityId"
  OR NEW."docId"       IS DISTINCT FROM OLD."docId"
  OR NEW.version       IS DISTINCT FROM OLD.version
  OR NEW.kind          IS DISTINCT FROM OLD.kind
  OR NEW.date          IS DISTINCT FROM OLD.date
  OR NEW.narration     IS DISTINCT FROM OLD.narration
  OR NEW.reference     IS DISTINCT FROM OLD.reference
  OR NEW."reversesId"  IS DISTINCT FROM OLD."reversesId"
  OR NEW.action        IS DISTINCT FROM OLD.action
  OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
  OR NEW."createdAt"   IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Journal entries are immutable except state (post a reversal instead)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entry_limited_update"
  BEFORE UPDATE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION restrict_entry_update();

-- 4. No posting into a locked period (spec §4). Edit/delete/undo of entries
--    in locked months is blocked here too, because each of those posts a new
--    entry dated in the locked month.
CREATE OR REPLACE FUNCTION check_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PeriodLock" pl
    WHERE pl."entityId" = NEW."entityId"
      AND pl.year  = EXTRACT(YEAR  FROM NEW.date)::int
      AND pl.month = EXTRACT(MONTH FROM NEW.date)::int
  ) THEN
    RAISE EXCEPTION 'Period %-% is locked for this entity',
      EXTRACT(YEAR FROM NEW.date)::int, EXTRACT(MONTH FROM NEW.date)::int;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "journal_entry_period_open"
  BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION check_period_open();
