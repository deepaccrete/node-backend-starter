# Migrations

This folder is **empty on purpose**. The scaffold creates no tables — the schema
is yours to define, and what belongs in it depends entirely on the project.

## How the runner works

`scripts/migrate.js` applies every `.sql` file in this folder in filename order,
once each, and records what it has applied in a `schemamigrations` table it
creates on first run.

```bash
npm run migrate          # apply everything not yet applied
npm run migrate:status   # list applied / pending, apply nothing
```

Because ordering is by filename, **always prefix with the date** — the same
convention `create-module.js` uses when it generates one for you:

```
20260825_create_customers.sql
20260826_add_customer_phone.sql
20260901_create_orders.sql
```

Two migrations written on the same day sort by whatever follows the date. If one
depends on the other, make the names order correctly (or just write them as one
file).

## Writing your first migration

Create `<YYYYMMDD>_<what_it_does>.sql`:

```sql
CREATE TABLE IF NOT EXISTS customermaster (
    id          serial PRIMARY KEY,
    customername varchar(150) NOT NULL,
    email        varchar(150),
    createdby   integer     NOT NULL DEFAULT 1,
    createdat   timestamp   NOT NULL DEFAULT NOW(),
    updatedby   integer     NOT NULL DEFAULT 1,
    updatedat   timestamp   NOT NULL DEFAULT NOW(),
    isdeleted   smallint    NOT NULL DEFAULT 0,
    CONSTRAINT uq_customermaster_email UNIQUE (email)
);
```

## Rules that keep this folder sane

- **An applied migration is immutable.** Once a file has run anywhere other than
  your own machine, never edit it — the runner will not re-apply it, so your
  database and everyone else's silently diverge. Write a new file instead.
- **Name your constraints** (`uq_`, `fk_`, `ck_`). `src/utils/pgError.js` maps
  constraint names to human messages; an auto-named constraint cannot be mapped.
- **One concern per file.** A migration that creates three unrelated tables is
  three migrations.
- **Make them re-runnable where you can** — `IF NOT EXISTS`, `IF EXISTS` — so a
  half-applied migration is recoverable.
