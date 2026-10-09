---
name: db-schema
description: Design and write database tables, collections, columns, indexes and migrations in the user's own house style, for ANY database (PostgreSQL, MySQL/MariaDB, SQL Server, SQLite, MongoDB). House rules - all-lowercase names with no separators, primary key named <entity>id (usermaster -> userid) and foreign keys named the same, the five-column audit block (createdby, createdat, updatedby, updatedat, isdeleted) on every table, soft delete only, booleans as smallint 0/1, isactive separate from isdeleted, status values as text + CHECK (never ENUM types), no triggers and no cascades, re-runnable migrations with a commented rollback. Use whenever someone asks to create a database, add or change a table, collection, column, field or index, design a schema or data model, write a migration or Mongoose/collection schema, or review existing DDL against these rules.
---

# DB Schema

Writes tables and migrations that follow the user's rules, so the user never has to
repeat them. The rules are the same on every database; only the spelling changes.

- The rules: `references/conventions.md` (R1 to R24). **Read it before writing anything.**
- How each rule is spelled per database: `references/engines.md`.
- Ready table shapes (master, document, line item, map, log): `references/table-shapes.md`.
- Worked examples: `references/examples.md`.
- Migration skeletons: `templates/migration.sql.tmpl` (SQL) and `templates/mongo-migration.js.tmpl` (MongoDB).
- Mechanical check: `scripts/verify-ddl.js` (run last, always).

`<skill>` below means this skill's own folder (the folder holding this SKILL.md).

## The rules that matter most (full list in conventions.md)

1. Table, collection, column and field names: **all lowercase, no separators** (`usermaster`, `createdat`).
2. Primary key: **`<entity>id`**, where entity = table name without a trailing `master`.
   `usermaster` -> `userid`, `invoicelineitem` -> `invoicelineitemid`. Never a bare `id`.
3. A foreign key column has **the same name as the key it points to**: a column pointing at `usermaster` is `userid`.
   So `userrolemap` holds `userid` + `roleid`, and its own key is `userrolemapid`.
4. **Every table ends with these five columns**, in this order:
   ```
   createdby  integer   DEFAULT 1     NOT NULL,
   createdat  timestamp DEFAULT now() NOT NULL,
   updatedby  integer   DEFAULT 1     NOT NULL,
   updatedat  timestamp DEFAULT now() NOT NULL,
   isdeleted  smallint  DEFAULT 0     NOT NULL
   ```
   Only exception: a strictly append-only log table keeps `createdby` + `createdat` only, with a comment saying so.
5. **Soft delete only.** A delete is an UPDATE setting `isdeleted = 1`. No `DELETE`, no cascades.
6. **Booleans are smallint 0/1**, never a boolean type.
7. **`isactive` is separate from `isdeleted`** and belongs on master tables only.

These rules win over whatever an existing project does. If an existing schema breaks
them, do not copy the break and do not silently fix old tables: write the new work
correctly and list the existing differences for the user.

## Steps

### 1. Find out the target

- Which database (PostgreSQL, MySQL, SQL Server, SQLite, MongoDB)? Look at the project
  (`package.json` drivers such as `pg`, `mysql2`, `mssql`, `mongoose`/`mongodb`; existing
  migrations) before asking.
- Where migrations live and how they are applied (a `migrations/` folder, a runner script).
- Is the project multi-tenant? Only then does R16 (`organizationid`) apply. Ask if unclear.
- If tables already exist, read two neighbouring ones so new columns sit beside them sensibly.

### 2. Get the content from the user

The skill decides the **form**; the user decides the **content**. Never invent tables,
columns, statuses or business rules. If the user names only a table, ask for:
the fields, which are required, which must be unique, the allowed status values, and
what it links to. One table asked for is one table.

### 3. Pick the shape and write it

- Pick the shape from `references/table-shapes.md` (master, document, line item, map, log).
- Spell it for the target database using `references/engines.md`.
- SQL: one dated migration file `YYYYMMDD_<what>.sql` from `templates/migration.sql.tmpl`.
- MongoDB: one collection spec `<collection>.collection.json` plus, if the project uses
  migrations, a migration from `templates/mongo-migration.js.tmpl`. If the project uses
  Mongoose, also write the model, following the same spec.

### 4. Verify

```bash
node <skill>/scripts/verify-ddl.js <file.sql | file.collection.json> [--dialect postgres|mysql|mssql|sqlite]
```

Fix every ERROR. Each WARN is either fixed or explained to the user in one line.
Then do the judgement pass a script cannot: are the statuses the real ones, do the
indexes match the filters the screens will use, is any NOT NULL column without a
default going to be omitted by the app?

### 5. Hand back

Give the user the file(s), the verify result, and the exact apply command for their
project (for example `pnpm migrate`). **Never apply a migration or connect to a
database yourself** unless the user explicitly asks.

## Changing an existing table

- Changes are additive and re-runnable: add a column with `IF NOT EXISTS` where the database supports it (see engines.md).
- A new column on a table with rows is nullable or has a default. Tightening to NOT NULL is a later, separate migration after the backfill.
- Renaming a column breaks every client that reads it: add the new one, backfill, switch the code, then drop the old one, in separate migrations.
- A migration that has already run anywhere except the author's machine is never edited. Write a new one.

## What NOT to do

- No triggers, no `ON UPDATE CURRENT_TIMESTAMP`, no `ON DELETE CASCADE / SET NULL`. The app writes `updatedat` on every update.
- No boolean types, no ENUM types, no `timestamptz` / MySQL `TIMESTAMP` type, no unbounded varchar.
- No JSON blob columns because the shape is unclear: ask what the fields are.
- No tables, columns or indexes the user did not ask for.
