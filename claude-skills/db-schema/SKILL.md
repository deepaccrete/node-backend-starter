---
name: db-schema
description: Design and write PostgreSQL databases, tables, columns and migrations in this organisation's house style — lowercase unseparated identifiers, `id` serial/bigserial primary keys, `organizationid` tenancy with a hand-named FK, the five-column audit block, soft delete via `isdeleted smallint`, booleans as `int2` 0/1, varchar+CHECK instead of Postgres ENUMs, no triggers and no ON DELETE cascades, partial indexes on `isdeleted = 0`, and hand-applied idempotent migration files with a header block and a commented rollback. Detects an existing schema's real conventions first, generates the DDL from the matching table shape (master / document / lineitem / map / log), then lints the result mechanically. Use whenever someone asks to create a database, add or alter a table or column, design a schema, write a migration, add an index or constraint, or review DDL for a Node/Express + PostgreSQL project.
---

# DB Schema

For creating databases, tables and columns that a reviewer recognises as ours.
Writing the API on top of them is a different job — that is `new-api`. Creating
the project folder is `backend-scaffold`, which deliberately ships **no** tables;
this skill is where the schema comes from.

The problem this solves: a table written from general PostgreSQL knowledge will
be *correct* and *foreign* — `created_at` instead of `createdat`, `BOOLEAN`
instead of `int2`, a real `ENUM`, an `ON DELETE CASCADE`, a trigger that
maintains `updated_at`. Each one is defensible in isolation and each one breaks
something concrete here: the column name is the JSON key the frontend receives,
`flag === 1` returns false for a real boolean, and a cascade in a soft-delete
schema is dead code that becomes live the day someone hard-deletes.

The house rules are not preferences. They are measured from 111 tables and 2 061
columns — every rule in `references/conventions.md` carries its adherence count,
and the evidence is in `references/dms-audit.md`.

## The rule that governs everything else

**The database is the authority on its own conventions.** Where the target
schema and this skill disagree, match the schema and raise the difference
separately — one more convention is worse than an imperfect one.

Two exceptions, both from the deviation register:

- **Do not propagate a known deviation.** A single `boolean`, a single
  `timestamptz`, `usermaster_id`-style FK names, a globally-unique document
  number. They exist, they are load-bearing where they are, and they must not
  spread. `references/conventions.md` §6 lists all nine.
- **Do not replicate a tenancy hole.** A table carrying `organizationid` with no
  FK, or a unique constraint that is not org-scoped, is a defect. Write yours
  correctly and tell the user the existing one needs the same treatment.

## Nothing in this database is maintained by the database

**Zero triggers across 111 tables.** This is the assumption most likely to
produce a broken design:

- `updatedat` is written **by the application** on every UPDATE. No trigger will
  do it. A model that forgets is silently wrong.
- Deletes are **application UPDATEs** setting `isdeleted = 1`. Rows are never
  physically removed.
- Derived totals are either `GENERATED … STORED` columns (5 of them) or
  recomputed in a model. Never a trigger.
- Document numbers are minted by `src/utils/docNumber.js` under
  `pg_advisory_xact_lock`, **not** by a sequence.

Any sentence beginning "the database will handle it" is wrong here. If you catch
yourself proposing a trigger, propose the application change instead.

## The four steps — do not skip step 1

### 1. DETECT — measure the schema before adding to it

```bash
node <skill>/scripts/detect-db-conventions.js --ddl <path-to-dump.sql> [--migrations <dir>]
```

> `<skill>` is this skill's own directory — the folder containing this SKILL.md
> (`~/.claude/skills/db-schema` when installed personally). There is no folder
> literally named `<skill>`.

It reads a `pg_dump`-style DDL file (and optionally a migrations directory) and
reports what the schema *actually* does: PK types, audit-block coverage, the
tenancy column and how consistently it carries an FK, boolean representation,
timestamp types, the varchar length ladder, naming style, index and constraint
prefixes, and trigger count. A drifted schema shows as a split ("57 serial4,
52 bigserial") rather than a confident wrong answer.

Then **read two neighbouring tables** — ideally from the closest domain, and
prefer the most recently added, because in a drifted schema the newest tables
are the live convention. `grnlinebatch` and `invoicelinebatch` carry
`organizationid` where older line items do not; the new ones are right.

If there is no dump, point `--migrations` at the migrations folder alone.

### 2. PLAN — state the shape and the columns before writing DDL

Write this out, and get it confirmed if anything is ambiguous:

- **Table name** — `<domain><role>`, lowercase, singular, no separators, suffix
  from the taxonomy (`*master` / `*lineitem` / `*map` / `*log` / `*history`).
- **Shape** — which of the five templates it is. This decides the PK type, the
  audit block, and whether it gets `isactive`.
- **Tenancy** — `organizationid`, or a stated reason it is platform-level.
- **Every column** — name, type from the dictionary, nullability, default.
- **States** — the exact allowed token list for every status-ish column.
- **Relationships** — each FK, its target, and its hand-name.
- **Uniqueness** — what is unique, and per what (almost always per org).
- **Access paths** — the queries this table will serve, which decide the indexes.

**Do not invent columns.** If the user has not said what the entity holds, ask.
A guessed schema gets applied and then lived with; an obvious gap gets filled.
Business rules — what a status means, whether a quantity may be zero — are the
user's to state, not yours to assume.

### 3. WRITE — generate the migration, then finish it by hand

```bash
node <skill>/scripts/new-table.js --spec <spec.json> --out <migrations-dir>
```

The spec format and a worked example are in `references/templates.md`. The
generator emits a complete house-style migration — header block, aligned
long-form DDL, hand-named FKs, CHECK constraints, the partial unique index, the
tenant index, and a commented-out rollback.

For anything it does not cover — an `ALTER`, an EXCLUDE constraint, a generated
column, a backfill — write it by hand from `references/templates.md` and
`references/migrations.md`.

Non-negotiable regardless of the schema:

1. **`id` is the primary key, always** — `serial` for a master or reference
   table, `bigserial` for anything transactional (documents, line items,
   ledgers, logs, stock movements). Never composite, never hand-named.
2. **Identifiers are lowercase with no underscores.** `productname`,
   `totaltaxamount`, `organizationid`. There is no ORM and no naming layer — the
   column name is the exact JSON key the frontend receives, so it is public API.
3. **`organizationid integer NOT NULL` is the second column**, with
   `CONSTRAINT fk_<table>_org … REFERENCES organizationmaster(id)`. On child
   tables too — the newest ones carry it, and it costs 4 bytes to remove a whole
   class of tenancy bug.
4. **Flags are `int2 DEFAULT 0|1 NOT NULL`**, named `is*` / `can*` / `allow*`.
   Never `boolean`.
5. **States are `varchar(20|30)`** holding `lower_snake_case` tokens, **with** a
   `chk_<entity>_status` CHECK. Never `CREATE TYPE … AS ENUM`.
6. **Timestamps are `timestamp` without time zone**; business dates are `date`.
7. **The five-column audit block, verbatim, at the end** — `createdby`,
   `createdat`, `updatedby`, `updatedat`, `isdeleted`. An append-only log takes
   `createdby` + `createdat` only, and says why in a comment.
8. **FKs are hand-named `fk_<table>_<target>` and carry no `ON DELETE` clause.**
   Not one of the 304 existing FKs cascades, and that is the safety net.
9. **Bound every `varchar`** from the length ladder in
   `references/conventions.md` §3. A `varchar(37)` will look wrong.
10. **Everything additive and idempotent** — `CREATE TABLE IF NOT EXISTS`,
    `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. The file is applied
    by hand and may be applied twice.

The five table shapes, in full: **`references/templates.md`**.

### 4. VERIFY — mechanically, then by eye

```bash
node <skill>/scripts/verify-ddl.js <file.sql> [more.sql ...]
```

Lints authored DDL against the house rules and the deviation register: uppercase
or underscored identifiers, `boolean`, `timestamptz`, unbounded `varchar`,
`CREATE TYPE … AS ENUM`, triggers, `ON DELETE` clauses, a PK that is not `id`, a
missing or partial audit block, `organizationid` without an FK, a status column
with no CHECK, a non-org-scoped unique constraint, unnamed FKs, a missing tenant
index, and non-idempotent DDL.

It exits non-zero on errors. **Do not report the work as done until it passes**,
or until you can say precisely why a finding is a false positive — several rules
have legitimate exceptions (a platform-level table has no `organizationid`, an
append-only log has no `isdeleted`), and the linter names them so you can justify
rather than silence them.

Then the judgement pass in **`references/review.md`** — the things a script
cannot check: whether the states are the real states, whether the indexes match
the queries the table will actually serve, whether a nullable column should be
`NOT NULL DEFAULT`, and whether the model layer will honour the soft delete.

## Creating a brand-new database

```sql
CREATE DATABASE <name> WITH ENCODING 'UTF8';
-- objects live in schema public; all DDL is written as public.<table>
```

Then **stop and let the user name the tables.** A new database is not a licence
to design their domain — the same rule `backend-scaffold` follows. What is worth
saying in one line: every `fk_<table>_org` needs `organizationmaster(id)` to
exist, so a multi-tenant database starts with that table plus a `usermaster` for
the `createdby` / `updatedby` references. Build them when asked.

Connection settings are never guessed and no `.env` is written — that is
`backend-scaffold`'s contract, and it holds here too.

## Altering an existing table

Additive and idempotent, always, so the migration can be applied ahead of the
code deploy:

```sql
ALTER TABLE public.<table> ADD COLUMN IF NOT EXISTS <col> <type>;
```

- A new column is **nullable or defaulted**. `NOT NULL` with no default on a
  populated table fails on apply.
- Tightening to `NOT NULL` is a **second** migration, after the backfill and
  after the code that writes the column is live.
- Widening a state machine is an app change plus a `DROP CONSTRAINT` /
  `ADD CONSTRAINT` pair on the CHECK — never `ALTER TYPE`, because there are no
  enum types.
- Renaming a column is a breaking API change: the name is the JSON key. Add,
  backfill, dual-write, then drop — in separate migrations.
- An index on a large hot table wants `CREATE INDEX CONCURRENTLY`, which **cannot
  run inside a transaction block** — put it in its own section, with a comment
  saying so.

## What NOT to do

- Do not add triggers. Not for `updatedat`, not for audit, not for totals.
- Do not add `ON DELETE CASCADE` or `ON DELETE SET NULL`.
- Do not create Postgres `ENUM` types, or `boolean` columns.
- Do not use `timestamptz`, or `timestamp` for a business date.
- Do not reach for `jsonb` because the shape is unclear — there are exactly two
  columns of it in 2 061. Ask what the fields are and make them columns.
- Do not create tables that were not asked for. One entity asked for is one
  table, not a schema.
- Do not "fix" existing deviations while adding something else. Report them.
- Do not apply the migration yourself — hand back the file and the apply step. How
  it is applied depends on the project: the legacy DMS-Backend has no runner (apply
  by hand, then re-run `scripts/gen_db_schema.py`); a project scaffolded with
  `backend-scaffold` registers the file through its runner (`npm run migrate`,
  tracked in `schemamigrations`). The file conventions in this skill — idempotent
  DDL, header block, commented rollback — are the same either way.

## Files in this skill

| Path                               | What it is                                             |
| ---------------------------------- | ------------------------------------------------------ |
| `scripts/detect-db-conventions.js` | Measures an existing schema — run FIRST                 |
| `scripts/new-table.js`             | Generates a house-style migration from a spec           |
| `scripts/verify-ddl.js`            | Lints authored DDL against the rules — run LAST         |
| `templates/migration.sql.tmpl`     | The migration file skeleton, header block and rollback  |
| `references/conventions.md`        | The house rules with adherence counts — read before DDL |
| `references/templates.md`          | The five table shapes + the generator's spec format     |
| `references/migrations.md`         | Migration file style, ordering, and risky operations    |
| `references/review.md`             | The judgement pass a script cannot do                   |
| `references/dms-audit.md`          | The source audit — the evidence behind every rule       |
