# Spelling the rules per database

conventions.md says what. This file says how, for PostgreSQL, MySQL/MariaDB, SQL Server,
SQLite and MongoDB. If the project uses another database, map each rule the same way and
tell the user which rows you had to decide.

## Quick map

| Rule                         | PostgreSQL                          | MySQL 8 / MariaDB                                                              | SQL Server                                                   | SQLite                                           | MongoDB                                            |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------- |
| Small key (R4)               | `serial`                            | `int AUTO_INCREMENT`                                                           | `int IDENTITY(1,1)`                                          | `INTEGER PRIMARY KEY AUTOINCREMENT`              | `int` from `sequencemaster`                        |
| Big key (R4)                 | `bigserial`                         | `bigint AUTO_INCREMENT`                                                        | `bigint IDENTITY(1,1)`                                       | `INTEGER PRIMARY KEY AUTOINCREMENT`              | `long` from `sequencemaster`                       |
| Boolean (R13)                | `smallint` + CHECK                  | `smallint` + CHECK                                                             | `smallint` + CHECK                                           | `smallint` + CHECK                               | `int`, enum [0, 1]                                 |
| Event time (R17)             | `timestamp`                         | `datetime` (not `timestamp`)                                                   | `datetime2(3)`                                               | `timestamp` (stored as text)                     | `date` (BSON Date, UTC)                            |
| `now()` default              | `DEFAULT now()`                     | `DEFAULT CURRENT_TIMESTAMP`                                                    | `DEFAULT SYSDATETIME()`                                      | `DEFAULT CURRENT_TIMESTAMP`                      | set by the app                                     |
| Business date (R17)          | `date`                              | `date`                                                                         | `date`                                                       | `date` (text `YYYY-MM-DD`)                       | `string`, pattern `YYYY-MM-DD`                     |
| Decimal (R18)                | `numeric(p,s)`                      | `decimal(p,s)`                                                                 | `decimal(p,s)`                                               | `numeric(p,s)`                                   | `decimal` (Decimal128)                             |
| Text name (R18)              | `varchar(n)`                        | `varchar(n)`                                                                   | `nvarchar(n)`                                                | `varchar(n)`                                     | `string`, maxLength n                              |
| Long text                    | `text`                              | `text`                                                                         | `nvarchar(max)`                                              | `text`                                           | `string`                                           |
| Status (R15)                 | `varchar(20)` + CHECK               | `varchar(20)` + CHECK (8.0.16+)                                                | `varchar(20)` + CHECK                                        | `varchar(20)` + CHECK                            | `string` + enum                                    |
| Unique among live rows (R20) | partial index `WHERE isdeleted = 0` | functional unique index (below)                                                | filtered index `WHERE isdeleted = 0`                         | partial index `WHERE isdeleted = 0`              | `partialFilterExpression: {isdeleted: 0}`          |
| Foreign key (R6, R11)        | `REFERENCES t(col)`                 | `REFERENCES t(col)` (InnoDB)                                                   | `REFERENCES t(col)`                                          | `REFERENCES t(col)` + `PRAGMA foreign_keys = ON` | no FK: the app checks it; index the field          |
| Re-runnable create (R23)     | `CREATE TABLE IF NOT EXISTS`        | `CREATE TABLE IF NOT EXISTS`                                                   | `IF OBJECT_ID(N'dbo.t', N'U') IS NULL`                       | `CREATE TABLE IF NOT EXISTS`                     | check `listCollections` first                      |
| Re-runnable index            | `CREATE INDEX IF NOT EXISTS`        | no `IF NOT EXISTS`: check `information_schema.statistics` first                | `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = ...)` | `CREATE INDEX IF NOT EXISTS`                     | `createIndex` is already re-runnable               |
| Add column re-runnably       | `ADD COLUMN IF NOT EXISTS`          | MariaDB: `ADD COLUMN IF NOT EXISTS`; MySQL: check `information_schema.columns` | `IF COL_LENGTH('dbo.t','c') IS NULL ALTER TABLE ... ADD`     | no IF: check `pragma_table_info`                 | add to the validator; old documents lack the field |

## PostgreSQL

- Write `public.<table>` only if the project's other migrations do.
- Never `boolean`, `timestamptz`, `CREATE TYPE ... AS ENUM`, `CREATE TRIGGER`.
- Computed stored values: `GENERATED ALWAYS AS (...) STORED` is allowed.
- Large existing table: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction; put it in its own file and say so in the header.

## MySQL / MariaDB

- Never the `TIMESTAMP` column type (it converts time zones); use `datetime`.
- Never `ON UPDATE CURRENT_TIMESTAMP` (R12: the app sets `updatedat`).
- Never the `ENUM(...)` or `BOOLEAN` / `TINYINT(1)` types; use `smallint` + CHECK.
- CHECK is enforced only from MySQL 8.0.16. On older versions say so to the user.
- Unique among live rows: MySQL has no partial index. Use a functional index; NULLs do not clash:
  ```sql
  CREATE UNIQUE INDEX uq_productmaster_code
      ON productmaster ((CASE WHEN isdeleted = 0 THEN productcode END));
  ```
- Tables: `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`.

## SQL Server

- `nvarchar(n)` for text people type (names, addresses); `varchar(n)` for codes and statuses.
- Never the `bit` type for booleans; use `smallint` + CHECK.
- Unique among live rows: `CREATE UNIQUE INDEX ... WHERE isdeleted = 0` (filtered index).
- Batch separator `GO` between statements that need it.

## SQLite

- Types are loose: still write the house type names so the intent is readable.
- Foreign keys are enforced only with `PRAGMA foreign_keys = ON` per connection; tell the user.
- `ALTER TABLE` is limited (no drop constraint); a big change is "create new table, copy, rename".

## MongoDB

MongoDB has no tables, columns or foreign keys, so three rules need a decision. These are fixed:

1. **Primary key (R3).** `_id` is required by MongoDB and stays (it is exempt from R1).
   The house key `<entity>id` is a separate integer field with a unique index, and links
   between collections use it (`userid`, not `_id`).
   It is allocated from the `sequencemaster` collection:
   ```js
   const r = await db.collection('sequencemaster').findOneAndUpdate(
     { sequencename: 'usermaster' },
     {
       $inc: { lastvalue: 1 },
       $setOnInsert: { createdby: 1, createdat: new Date(), isdeleted: 0 },
       $set: { updatedby: userid, updatedat: new Date() },
     },
     { upsert: true, returnDocument: 'after' }
   );
   const userid = r.lastvalue; // driver v6; older drivers return r.value.lastvalue
   ```
   `sequencemaster` is the one named exception to R3: it cannot number itself, so its key is
   the unique `sequencename` (index `uq_sequencemaster_sequencename`). It still has the audit fields.
2. **Foreign keys (R6, R11).** No FKs exist. The app checks a linked id exists (and has
   `isdeleted: 0`) before insert, and every link field gets an index.
3. **Field order (R7).** MongoDB does not keep a column order; write the audit fields last
   in the spec, the validator and the Mongoose model.

Other MongoDB spellings:

- Booleans: `int` with `enum: [0, 1]`. Never `bool`.
- Status: `string` with `enum`.
- Event times: BSON `date` (always UTC). Business dates: `string` with pattern `^\d{4}-\d{2}-\d{2}$`.
- Money: `decimal` (Decimal128), never a double.
- Every read filters `{ isdeleted: 0 }`.

### The collection spec (what the skill writes for MongoDB)

One file per collection, `<collection>.collection.json`. `scripts/verify-ddl.js` checks it and
`templates/mongo-migration.js.tmpl` applies it (validator + indexes).

```json
{
  "collection": "usermaster",
  "appendonly": false,
  "primarykey": "userid",
  "fields": {
    "userid": { "type": "int", "required": true },
    "username": { "type": "string", "required": true, "maxlength": 64 },
    "roleid": { "type": "int", "required": true, "ref": "rolemaster" },
    "isactive": { "type": "int", "required": true, "enum": [0, 1], "default": 1 },
    "createdby": { "type": "int", "required": true, "default": 1 },
    "createdat": { "type": "date", "required": true, "default": "now" },
    "updatedby": { "type": "int", "required": true, "default": 1 },
    "updatedat": { "type": "date", "required": true, "default": "now" },
    "isdeleted": { "type": "int", "required": true, "enum": [0, 1], "default": 0 }
  },
  "indexes": [
    { "name": "uq_usermaster_userid", "keys": { "userid": 1 }, "unique": true },
    {
      "name": "uq_usermaster_username",
      "keys": { "username": 1 },
      "unique": true,
      "partialFilterExpression": { "isdeleted": 0 }
    },
    { "name": "idx_usermaster_roleid", "keys": { "roleid": 1, "isdeleted": 1 } }
  ]
}
```

Field `type` values: `int`, `long`, `decimal`, `string`, `date`, `array`. (`bool` is refused;
`object` is warned, see R19.) Optional keys: `required`, `default`, `enum`, `maxlength`,
`pattern`, `ref`, `items` (for arrays).

### Mongoose models

Follow the same spec, and:

- `{ timestamps: false, versionKey: false }` (R12; `__v` would break R1).
- Booleans as `{ type: Number, enum: [0, 1], default: 0, required: true }`.
- Links as `{ type: Number, required: true }` named `<entity>id`, plus an index; no `ref` to `_id`.
- A pre-find hook or query helper that adds `isdeleted: 0`.
