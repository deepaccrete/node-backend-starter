# Migrations

Plain `.sql` files, applied in filename order by `scripts/migrate.ts`.

| File                                   | What it does                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `20261126_create_customer_masters.sql` | Customer master tables, import tables, `usermaster`, `authsession`                       |
| `20261127_drop_tse_psr_and_source.sql` | Drops `tsemaster`, `psrmaster`, the dealer links to them, and `importbatchmaster.source` |

## Commands

```bash
pnpm migrate          # apply every file not yet applied
pnpm migrate:status   # list applied / pending / MODIFIED!, apply nothing
```

They connect to the database named in `.env` (`DB_HOST`, `DB_NAME`, ...). Check which
one before running. In a container: `node dist/scripts/migrate.js up`.

Each file runs in its own transaction and is recorded, with a checksum, in the
`schemamigrations` table (created on first run). A file is never re-run, and an
applied file that was later edited stops the runner with an error.

## Rules

- **One new file per change.** Name it `<YYYYMMDD>_<what_it_does>.sql`.
- **Never edit an applied file.** Write a new one instead.
- **Follow the house naming rules** (lowercase names, `<entity>id` keys, the five
  audit columns, soft delete, `smallint` 0/1 flags, `timestamp` not `timestamptz`).
- **Name every constraint** (`uq_`, `fk_`, `chk_`) and register user-facing ones in
  `src/utils/pgError.ts`.
- **Make statements re-runnable** (`IF NOT EXISTS` / `IF EXISTS`), and never use `CASCADE`.
- **End with a commented rollback.**
- **Destructive changes** (drop a column or table, delete data): back up the data
  first and dry-run the file in a transaction that is rolled back.
