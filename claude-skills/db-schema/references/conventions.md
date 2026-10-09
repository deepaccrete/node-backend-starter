# House conventions (R1 to R24)

These are the user's rules. They apply to every database. Spellings per database are
in `engines.md`; this file says WHAT, engines.md says HOW.

"Table" also means a MongoDB collection, and "column" also means a document field.

Rules marked **[must]** are checked by `scripts/verify-ddl.js` as errors.
Rules marked **[default]** are followed unless the user says otherwise; verify warns.

---

## Names

### R1 [must] All lowercase, no separators

Table, collection, column and field names use only `a-z` and `0-9`, starting with a letter.
No uppercase, no `_`, no `-`, no camelCase.

| Right                                    | Wrong                                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| `usermaster`, `createdat`, `totalamount` | `UserMaster`, `user_master`, `createdAt`, `total_amount` |

The column name is the key the API and frontend receive, so a rename is a breaking change.
Index and constraint names are not column names: they use the prefixes in R21 and may use `_`.

### R2 [default] Table names are singular and end by role

| Suffix     | Use for                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| `master`   | any first-class entity, including documents (`usermaster`, `invoicemaster`) |
| `lineitem` | child rows of a document (`invoicelineitem`)                                |
| `map`      | many-to-many link (`rolepermissionmap`)                                     |
| `log`      | append-only records (`loginlog`)                                            |
| `history`  | point-in-time snapshots (`pricehistory`)                                    |

Default to singular. `master` does not mean "small lookup table"; pick the suffix by role.

---

## Keys

### R3 [must] Primary key is `<entity>id`

Entity = the table name with a trailing `master` removed. Nothing else is removed.

| Table               | Primary key           |
| ------------------- | --------------------- |
| `usermaster`        | `userid`              |
| `productmaster`     | `productid`           |
| `invoicelineitem`   | `invoicelineitemid`   |
| `rolepermissionmap` | `rolepermissionmapid` |
| `loginlog`          | `loginlogid`          |

Single column, never composite, never a business code. Never a bare `id`.
MongoDB keeps its required `_id` and adds this key as its own unique field (engines.md).

### R4 [default] Key type by role

- Small auto-increment integer for masters and reference data.
- Big auto-increment integer for anything that gets one row per business event:
  documents, line items, logs.
  Ask: "will this table get a new row every time something happens?" Yes -> big.

### R5 [must] A foreign key has the same name as the key it points to

A column pointing at `usermaster` is `userid`; at `productmaster`, `productid`.

Example: a map linking users to roles.

```sql
CREATE TABLE IF NOT EXISTS userrolemap (
    userrolemapid  serial   PRIMARY KEY,   -- its own key: "map" is kept, only "master" is dropped
    userid         integer  NOT NULL,      -- same name as usermaster's key
    roleid         integer  NOT NULL,      -- same name as rolemaster's key (not rolid, not role_id)
    ...audit block...
    CONSTRAINT fk_userrolemap_user FOREIGN KEY (userid) REFERENCES usermaster (userid),
    CONSTRAINT fk_userrolemap_role FOREIGN KEY (roleid) REFERENCES rolemaster (roleid)
);
```

The link column is spelled exactly like the target's key; a misspelling (`rolid`) is a bug.

- Two links to the same table: put a qualifier **in front**, keep the `<entity>id` ending:
  `parentcategoryid`, `baseunitid` / `salesunitid`, `billingaddressid`.
- A link to the user table that records who did something is `<verb>by`, not `<verb>userid`:
  `createdby`, `updatedby`, `approvedby`, `cancelledby`, `verifiedby`.

### R6 [must] Every foreign key points at the target's primary key

`REFERENCES usermaster(userid)`. Never at a code or another column, never composite.

---

## The audit block

### R7 [must] Every table ends with the five audit columns, in this order

```sql
createdby  integer   DEFAULT 1     NOT NULL,
createdat  timestamp DEFAULT now() NOT NULL,
updatedby  integer   DEFAULT 1     NOT NULL,
updatedat  timestamp DEFAULT now() NOT NULL,
isdeleted  smallint  DEFAULT 0     NOT NULL
```

They are the last five columns, `isdeleted` last. Constraints may follow them.

### R8 [must] Append-only log tables: `createdby` + `createdat` only

A table whose rows are never updated or retracted (name ends in `log`, or marked
`-- append-only` in a comment right above it) keeps only `createdby` and `createdat`
as its last two columns, with a comment saying it is append-only.

### R9 [default] `DEFAULT 1` is a fallback, not the truth

The app passes the real user id on every insert and update. Never rely on the default.

---

## Deleting and the database doing work

### R10 [must] Soft delete only

A delete is `UPDATE ... SET isdeleted = 1, updatedby = <user>, updatedat = now()`.
Rows are never physically removed. No `DELETE` statements in migrations or app code.

### R11 [must] No cascades

Foreign keys use the default (no action). No `ON DELETE CASCADE`, `ON DELETE SET NULL`,
`ON UPDATE CASCADE`. A hard delete of a parent then fails loudly, which is the safety net.

### R12 [must] Nothing is maintained by the database

No triggers. No MySQL `ON UPDATE CURRENT_TIMESTAMP`. No Mongoose `timestamps: true`.
The app sets `updatedat` (and `updatedby`) on every update. Computed stored columns
are allowed for derived values (engines.md), triggers are not.

---

## Types

### R13 [must] Booleans are smallint holding 0 or 1

Never a boolean / bool / bit type. `NOT NULL` with a default (`0` or `1`) and a CHECK
`IN (0, 1)`. Names start with `is`, `can`, `allow` or `has`.

### R14 [must] `isactive` is separate from `isdeleted`, never conflated

- `isdeleted = 1`: the row is gone and never appears in any list.
- `isactive = 0`: the row still exists and is still referenced by history, but must
  not be offered for new use.

`isactive smallint DEFAULT 1 NOT NULL` belongs on master/reference tables. Documents
do not get it; their lifecycle is their `status` column. A table with `isactive` always
also has `isdeleted`.

### R15 [must] Status and type values are text + a CHECK, never an ENUM type

`varchar(20)` for simple states, `varchar(30)` for longer lists. Values are lowercase
snake_case (`partially_received`, `on_leave`). Uppercase only for external codes
(`GET`, `FIFO`). **Every `status` column has a CHECK** listing its allowed values.
Adding a value later = an app change + replacing the CHECK, never altering a type.

### R17 [must] Timestamps without time zone; business dates as dates

Event times (`*at`) are timestamp without time zone, stored in one agreed zone.
Business dates (`invoicedate`, `duedate`, `effectivefrom`) are a date type, not a timestamp.

### R18 [default] Type dictionary and varchar ladder

| Meaning                    | Type                          |
| -------------------------- | ----------------------------- |
| Money, totals, tax amounts | decimal(14,2)                 |
| Quantities, unit prices    | decimal(14,4)                 |
| Percentages                | decimal(5,2)                  |
| Latitude / longitude       | decimal(10,8) / decimal(11,8) |
| Free text, notes, remarks  | text                          |
| Person or party names      | varchar(150)                  |
| Product or long names      | varchar(200)                  |
| Short codes                | varchar(20)                   |
| Document numbers           | varchar(50)                   |
| Email                      | varchar(150)                  |
| Phone / mobile             | varchar(20)                   |
| Tax ids, pincodes          | varchar(20)                   |
| Address line               | varchar(200)                  |
| City, state, country       | varchar(100)                  |
| URLs, file paths           | varchar(500)                  |
| SHA-256 hex hash           | varchar(64)                   |
| Sort order                 | smallint DEFAULT 0 NOT NULL   |

Varchar lengths come only from this ladder: **20, 30, 50, 64, 100, 150, 200, 255, 500**.
Never an unbounded varchar.

### R19 [default] No JSON blobs

Avoid json/jsonb (or a free-form object in MongoDB). If the shape is unclear, ask
the user for the fields and make them real columns.

---

## Tenancy

### R16 [must when multi-tenant] `organizationid` on every tenant table

Only when the project is multi-tenant. Then:

- `organizationid integer NOT NULL` is the second column, right after the primary key.
- It always has a foreign key to `organizationmaster(organizationid)`.
- Child tables carry it too, not only through their parent.
- Index `(organizationid, isdeleted)`; every unique rule includes `organizationid`.
  Platform tables (users, roles, permissions, the organization table itself) do not carry it.

---

## Constraints and indexes

### R20 [default] Unique rules ignore deleted rows

A unique code or number is unique among rows with `isdeleted = 0`, so a deleted row
does not block reusing the code. (Document numbers that must never be reissued are
the exception: unique across all rows.) Spelling per database: engines.md.

### R21 [default] Indexes for real filters, named by prefix

- One index per filter the screens actually use (status + date for documents, the parent id for line items).
- Names: `idx_<table>_<what>` (index), `uq_<table>_<what>` (unique), `chk_<table>_<what>` (CHECK),
  `fk_<table>_<target>` (foreign key). Name every constraint by hand.

### R22 [default] CHECK the business facts

Cheap correctness: amounts > 0, quantities >= 0, end date >= start date, exactly one of two links set.

---

## Migrations and queries

### R23 [must] Migrations are dated, re-runnable and reversible

- File name `YYYYMMDD_<what>` so files sort in the order written.
- Re-runnable: `IF NOT EXISTS` wherever the database supports it.
- One concern per file. A header saying what and why. A **commented** rollback at the end.
- A migration that has run anywhere except the author's machine is never edited; write a new one.

### R24 [must] How the tables are queried

- Every read filters `isdeleted = 0`.
- Every update sets `updatedat = now()` and `updatedby = <user>`.
- A delete is the soft-delete UPDATE in R10.
- A NOT NULL column with no default is a trap if the app may omit it: give it a default
  or confirm the write path always sends it.
