# Migrations

Plain `.sql` files, applied in filename order by `scripts/migrate.ts`.

| File                       | What it creates                                                     |
| -------------------------- | ------------------------------------------------------------------- |
| `20261008_auth_tables.sql` | `usermaster` (dashboard users) and `authsession` (sign-in sessions) |

TPJP's business tables are not here yet: each is added with the feature that needs it.

## How the runner works

```bash
pnpm migrate          # apply everything not yet applied
pnpm migrate:status   # list applied / pending, apply nothing
```

Each file runs in its own transaction and is recorded, with a checksum, in the
`schemamigrations` table (created on first run). A file is never re-run, and an
applied file that was later edited stops the runner with an error.

In a container: `node dist/scripts/migrate.js up`.

## Naming

Prefix with the date so files sort in the order they were written:

```
20261008_auth_tables.sql
20261015_create_distributormaster.sql
```

## Writing one

Follow the house conventions (also in the README):

```sql
CREATE TABLE IF NOT EXISTS customermaster (
    id            serial       PRIMARY KEY,
    customername  varchar(150) NOT NULL,
    customercode  varchar(20)  NOT NULL,
    isactive      smallint     NOT NULL DEFAULT 1,
    isdeleted     smallint     NOT NULL DEFAULT 0,
    createdby     int          NOT NULL DEFAULT 0,
    createdat     timestamptz  NOT NULL DEFAULT NOW(),
    updatedby     int          NOT NULL DEFAULT 0,
    updatedat     timestamptz  NOT NULL DEFAULT NOW()
);

-- Partial: a soft-deleted row must not reserve its code forever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_customermaster_code
    ON customermaster (customercode) WHERE isdeleted = 0;
```

## Rules

- **An applied migration is immutable.** Once a file has run anywhere other than
  your own machine, never edit it. Write a new file instead.
- **Name your constraints** (`uq_`, `fk_`, `ck_`) and register each in
  `src/utils/pgError.ts`, which maps the name to a message a user can act on.
- **One concern per file.**
- **Make them re-runnable where you can** (`IF NOT EXISTS`), so a half-applied
  migration is recoverable.
