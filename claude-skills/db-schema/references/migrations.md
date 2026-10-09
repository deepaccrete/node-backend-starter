# Migration file conventions

**In the legacy DMS-Backend there is no migration runner** — files in
`migrations/` are applied by hand (DBeaver / psql). A project scaffolded with
`backend-scaffold` instead applies them through its runner (`npm run migrate`,
tracked in `schemamigrations`). Either way the file conventions below are the
same: the file must be safe to run twice, safe to run before the code that uses
it, and readable by whoever reviews it.

Ad-hoc fix-ups go in `scripts/` with a plain descriptive name instead.

## Filename

```
migrations/YYYYMMDD_<snake_case_topic>.sql
```

`20260813_session_hardening.sql`, `20260807_supplier_debit_note.sql`. Underscores
are correct **here** — the no-underscore rule is about SQL identifiers, not
filenames.

## The five properties every migration has

### 1. A header block that explains itself

The house style is a long `--` header, visible in
`20260813_session_hardening.sql` and `20260807_supplier_debit_note.sql`:

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT THIS IS
--   Stock transfer between warehouses — document master + line items.
--
-- WHY
--   Branch stock moves are currently recorded as a paired sale + purchase,
--   which double-counts revenue. This gives them their own document.
--
-- DECISIONS LOCKED
--   - Transfers are org-scoped; cross-org movement is out of scope.  (Accrete)
--   - `in_transit` is a real state, not a derived one.                (Accrete)
--
-- BEHAVIOUR-NEUTRAL ON ITS OWN
--   Yes. Nothing reads these tables until the API ships.
--
-- Apply by hand (there is no migration runner), then re-run
-- scripts/gen_db_schema.py.
-- ═══════════════════════════════════════════════════════════════════════════
```

**"Behaviour-neutral on its own"** is the most useful line in the block and the
one most often skipped. It tells whoever applies the file whether they have just
changed production behaviour. If the answer is no, say exactly what changes.

### 2. Numbered sections, separated by rules

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TABLES
-- ═══════════════════════════════════════════════════════════════════════════
```

One concern per section: tables, then constraints, then indexes, then backfill,
then rollback. A reader applying it in pieces needs the boundaries.

### 3. Additive and idempotent, always

```sql
CREATE TABLE IF NOT EXISTS ...
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...
CREATE INDEX IF NOT EXISTS ...
```

New columns are **nullable or defaulted**, so the script can be applied ahead of
the code that populates them.

`ADD CONSTRAINT` has no `IF NOT EXISTS` in PostgreSQL. Guard it:

```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_st_status'
    ) THEN
        ALTER TABLE public.stocktransfermaster
            ADD CONSTRAINT chk_st_status CHECK (...);
    END IF;
END $$;
```

### 4. Long-form DDL, visually aligned, with per-column comments

`integer`, `smallint`, `bigint`, `character varying(50)`,
`timestamp without time zone` — not the `int4` / `varchar(50)` forms `pg_dump`
prints. Align the type and constraint columns. Comment anything non-obvious:

```sql
    reconciliationstatus character varying(30)
                         DEFAULT 'pending'::character varying NOT NULL,  -- vs vansessionmaster.status: settlement, not lifecycle
```

### 5. A rollback section at the end, commented out

```sql
-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK  (commented — uncomment only if this migration must be undone)
-- ═══════════════════════════════════════════════════════════════════════════
-- DROP INDEX IF EXISTS public.idx_stocktransfermaster_org;
-- DROP TABLE IF EXISTS public.stocktransferlineitem;
-- DROP TABLE IF EXISTS public.stocktransfermaster;
```

Commented, always — an uncommented rollback at the bottom of a file that gets
pasted whole is a data-loss incident. Reverse order of creation.

Where a rollback would lose data, say so instead of writing it:

```sql
-- ROLLBACK: none. Dropping `settledamount` loses the settlement history that
-- has no other home. Undo by ignoring the column, not by dropping it.
```

## Cutover steps

Anything that must run at **deploy** time rather than **apply** time goes
commented and labelled:

```sql
-- CUTOVER (run at deploy, AFTER the new code is live — not now):
-- ALTER TABLE public.invoicemaster ALTER COLUMN pdfpath SET NOT NULL;
```

## Ordering within a multi-table migration

1. Parent tables before children (the FK needs its target).
2. All tables, then all constraints that cross tables.
3. Indexes last — they are the slowest part and the safest to interrupt.
4. Backfills after the structure, in their own section, with a row-count comment.

## Operations that need care

| Operation                         | Why it bites                                          | Do this instead                                            |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| `ADD COLUMN … NOT NULL` no default| Fails on any populated table                          | Nullable now, backfill, tighten in a later migration        |
| `ALTER COLUMN … TYPE`             | Full table rewrite, holds an ACCESS EXCLUSIVE lock     | New column + backfill + dual-write + drop, across migrations|
| `CREATE INDEX` on a hot table     | Blocks writes for the duration                        | `CREATE INDEX CONCURRENTLY` — **cannot be in a transaction**, own section |
| Renaming a column                 | The name is the JSON key the frontend receives        | Add + backfill + dual-write + drop, in separate migrations  |
| Widening a state machine          | There are no enum types to alter                      | `DROP CONSTRAINT` + `ADD CONSTRAINT` on the CHECK, plus the app change |
| Adding a unique index             | Fails on existing duplicates                          | Run the duplicate-finding SELECT first, in a comment        |
| Dropping a column                 | Any query still selecting it errors instantly         | Confirm with a grep across `src/models/**` first            |

For the unique-index case, ship the check with the migration:

```sql
-- Before applying, confirm this returns zero rows:
--   SELECT organizationid, transfernumber, COUNT(*)
--     FROM public.stocktransfermaster
--    GROUP BY 1, 2 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_st_org_number
    ON public.stocktransfermaster (organizationid, transfernumber) WHERE isdeleted = 0;
```

## After applying

Re-dump the schema and re-run `scripts/gen_db_schema.py` — the existing
migrations already say so, and the audit found the snapshot 7 tables and 3
`ALTER`s behind because it was skipped. A stale `DB_SCHEMA.md` is worse than
none: it is confidently wrong, and the next person to write a table against it
will miss the tables that are already there.

**Do not apply the migration yourself.** Hand back the file path and the command:

```bash
psql -h <host> -U <user> -d <db> -f migrations/20260826_stock_transfer.sql
```
