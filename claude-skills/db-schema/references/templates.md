# Table shapes and the generator spec

Five shapes cover 92 of 111 tables. Pick one, then adjust — do not design from
scratch. The remainder are ledgers, stock tables and settings tables that borrow
from the master shape.

Authored DDL uses the **long-form spellings** (`integer`, `smallint`, `bigint`,
`character varying(50)`, `timestamp without time zone`) with columns visually
aligned. The short `int4` / `int2` / `varchar(50)` forms are how `pg_dump`
renders them back — do not write them by hand.

---

## 1. Master / reference table

For anything configured once and referenced many times: products, customers,
warehouses, brands, units, tax rates, reasons, terms.

`serial` PK · gets `isactive` · code unique per org.

```sql
CREATE TABLE IF NOT EXISTS public.<entity>master (
    id              serial                       PRIMARY KEY,
    organizationid  integer                      NOT NULL,
    <entity>code    character varying(20),                    -- unique per org, reusable after soft delete
    <entity>name    character varying(150)       NOT NULL,
    description     text,
    sortorder       smallint       DEFAULT 0     NOT NULL,
    isactive        smallint       DEFAULT 1     NOT NULL,     -- 0 = kept for history, not offered for new use
    createdby       integer        DEFAULT 1     NOT NULL,
    createdat       timestamp      DEFAULT now() NOT NULL,
    updatedby       integer        DEFAULT 1     NOT NULL,
    updatedat       timestamp      DEFAULT now() NOT NULL,     -- written by the app; there is no trigger
    isdeleted       smallint       DEFAULT 0     NOT NULL,
    CONSTRAINT fk_<entity>master_org FOREIGN KEY (organizationid)
        REFERENCES public.organizationmaster(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_<entity>_org_code
    ON public.<entity>master (organizationid, <entity>code) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_<entity>master_org
    ON public.<entity>master (organizationid, isdeleted);
```

---

## 2. Document master

For anything that records a business event and has a lifecycle: invoices, GRNs,
sales orders, purchase orders, payments, credit/debit notes.

`bigserial` PK · **no `isactive`** — the lifecycle is `status` · number unique
per org · `status` always guarded by a CHECK.

```sql
CREATE TABLE IF NOT EXISTS public.<doc>master (
    id              bigserial                        PRIMARY KEY,
    organizationid  integer                          NOT NULL,
    <doc>number     character varying(50)            NOT NULL,   -- minted by src/utils/docNumber.js
    <doc>date       date                             NOT NULL,
    <party>id       integer                          NOT NULL,   -- customerid / supplierid
    warehouseid     integer,
    status          character varying(20)
                    DEFAULT 'draft'::character varying NOT NULL,
    subtotal        numeric(14,2)  DEFAULT 0         NOT NULL,
    discountamount  numeric(14,2)  DEFAULT 0,
    cgstamount      numeric(14,2)  DEFAULT 0,
    sgstamount      numeric(14,2)  DEFAULT 0,
    igstamount      numeric(14,2)  DEFAULT 0,
    totaltaxamount  numeric(14,2)  DEFAULT 0,
    roundoffamount  numeric(6,2)   DEFAULT 0,
    totalamount     numeric(14,2)  DEFAULT 0         NOT NULL,
    remarks         text,
    createdby       integer        DEFAULT 1         NOT NULL,
    createdat       timestamp      DEFAULT now()     NOT NULL,
    updatedby       integer        DEFAULT 1         NOT NULL,
    updatedat       timestamp      DEFAULT now()     NOT NULL,
    isdeleted       smallint       DEFAULT 0         NOT NULL,
    CONSTRAINT chk_<doc>_status CHECK (((status)::text = ANY ((ARRAY[
        'draft'::character varying,
        'posted'::character varying,
        'cancelled'::character varying])::text[]))),
    CONSTRAINT fk_<doc>master_org FOREIGN KEY (organizationid)
        REFERENCES public.organizationmaster(id),
    CONSTRAINT fk_<doc>master_<party> FOREIGN KEY (<party>id)
        REFERENCES public.<party>master(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_<doc>_org_number
    ON public.<doc>master (organizationid, <doc>number) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_<doc>master_org_status
    ON public.<doc>master (organizationid, status, <doc>date);
```

The GST amount block (`cgst`/`sgst`/`igst`/`cess`/`totaltax`) plus
`discounttype`/`overalldiscountpct`/`overalldiscountamt` is copied **verbatim**
across `invoicemaster`, `salesordermaster`, `creditnotemaster`,
`debitnotemaster` and `purchaseordermaster`. Copy it; do not redesign it.

`status` tokens are `lower_snake_case`. Name the real ones with the user — the
draft/posted/cancelled triple above is a starting point, not their state machine.

---

## 3. Line item

Child rows of a document. Measured across all 12 `*lineitem` tables: all 12 have
`id` + the five audit columns; 10/12 have `productid`; 8/12 `batchid`; 7/12
`unitid` and `linetotal`.

`bigserial` PK · parent id **first after `id`** · carry `organizationid` (the
newest children do — see D5).

```sql
CREATE TABLE IF NOT EXISTS public.<doc>lineitem (
    id                 bigserial                    PRIMARY KEY,
    <doc>id            bigint                       NOT NULL,   -- parent, always first after id
    organizationid     integer                      NOT NULL,   -- carried on children too (D5)
    productid          integer                      NOT NULL,
    batchid            integer,
    unitid             integer,
    quantity           numeric(14,4)                NOT NULL,
    unitprice          numeric(14,4)                NOT NULL,
    discountpercentage numeric(5,2)  DEFAULT 0,
    discountamount     numeric(14,2) DEFAULT 0,
    taxpercentage      numeric(5,2)  DEFAULT 0,
    taxamount          numeric(14,2) DEFAULT 0,
    linetotal          numeric(14,2) DEFAULT 0      NOT NULL,
    remarks            text,
    createdby          integer       DEFAULT 1      NOT NULL,
    createdat          timestamp     DEFAULT now()  NOT NULL,
    updatedby          integer       DEFAULT 1      NOT NULL,
    updatedat          timestamp     DEFAULT now()  NOT NULL,
    isdeleted          smallint      DEFAULT 0      NOT NULL,
    CONSTRAINT chk_<doc>li_qty CHECK (quantity > 0::numeric),
    CONSTRAINT fk_<doc>lineitem_parent FOREIGN KEY (<doc>id)
        REFERENCES public.<doc>master(id),
    CONSTRAINT fk_<doc>lineitem_org FOREIGN KEY (organizationid)
        REFERENCES public.organizationmaster(id),
    CONSTRAINT fk_<doc>lineitem_product FOREIGN KEY (productid)
        REFERENCES public.productmaster(id)
);

CREATE INDEX IF NOT EXISTS idx_<doc>lineitem_parent
    ON public.<doc>lineitem (<doc>id) WHERE isdeleted = 0;

CREATE INDEX IF NOT EXISTS idx_<doc>lineitem_org
    ON public.<doc>lineitem (organizationid, isdeleted);
```

`linetotal` is a candidate for `GENERATED … STORED` — there are 5 such columns in
the schema. Only do it when the arithmetic is genuinely fixed; the models
recompute otherwise.

---

## 4. Junction (`*map`)

`serial` PK · the pair is unique · typically 9 columns wide.

A bare `UNIQUE (<a>id, <b>id)` is correct here even though it does not name
`organizationid`: both targets are themselves org-scoped, so two tenants cannot
collide. The org-scoping rule applies to a unique on a business **value** — a
code or a document number.

```sql
CREATE TABLE IF NOT EXISTS public.<a><b>map (
    id             serial                      PRIMARY KEY,
    organizationid integer                     NOT NULL,
    <a>id          integer                     NOT NULL,
    <b>id          integer                     NOT NULL,
    createdby      integer      DEFAULT 1      NOT NULL,
    createdat      timestamp    DEFAULT now()  NOT NULL,
    updatedby      integer      DEFAULT 1      NOT NULL,
    updatedat      timestamp    DEFAULT now()  NOT NULL,
    isdeleted      smallint     DEFAULT 0      NOT NULL,
    CONSTRAINT fk_<a><b>map_org FOREIGN KEY (organizationid)
        REFERENCES public.organizationmaster(id),
    CONSTRAINT fk_<a><b>map_<a> FOREIGN KEY (<a>id) REFERENCES public.<a>master(id),
    CONSTRAINT fk_<a><b>map_<b> FOREIGN KEY (<b>id) REFERENCES public.<b>master(id)
);

-- Partial, so the pair can be re-created after a soft delete.
-- Use a plain UNIQUE (<a>id, <b>id) constraint instead only if it must never recur.
CREATE UNIQUE INDEX IF NOT EXISTS uq_<a><b>map_pair
    ON public.<a><b>map (<a>id, <b>id) WHERE isdeleted = 0;
```

A permission-grid style map (`rolepermissionmap`) carries `can*` flag columns
instead of being a bare pair — `int2 DEFAULT 0 NOT NULL` each.

---

## 5. Append-only log

`bigserial` PK · payload columns · **`createdby` + `createdat` only**. No
`updatedby`, no `updatedat`, no `isdeleted` — and a header comment saying why,
because a reviewer will otherwise read it as an omission.

```sql
-- Append-only: rows are never updated and never retracted, so this table
-- deliberately omits updatedby / updatedat / isdeleted.
CREATE TABLE IF NOT EXISTS public.<subject>log (
    id             bigserial                    PRIMARY KEY,
    organizationid integer                      NOT NULL,
    <subject>id    integer                      NOT NULL,
    action         character varying(30)        NOT NULL,
    details        text,
    createdby      integer,                                 -- NULL for system-written rows
    createdat      timestamp     DEFAULT now()  NOT NULL,
    CONSTRAINT fk_<subject>log_org FOREIGN KEY (organizationid)
        REFERENCES public.organizationmaster(id)
);

CREATE INDEX IF NOT EXISTS idx_<subject>log_org_created
    ON public.<subject>log (organizationid, createdat DESC);
```

Note `createdby integer` **nullable** here — the two existing log tables allow it
because system-written rows have no user. That is the one place nullable
`createdby` is right.

---

## 6. The generator spec

`scripts/new-table.js` takes a JSON spec and emits a complete migration.

```bash
node <skill>/scripts/new-table.js --spec ./spec.json --out ./migrations
node <skill>/scripts/new-table.js --spec ./spec.json --stdout   # print, don't write
```

### Fields

Top-level keys shared by every table in the file: `topic` (the filename slug),
`title`, `author`, `why`, `decisions`, `neutral`, `date`, and `tables` — an array
of the table specs below. A single-table spec can skip `tables` and be the table
spec itself.

| Field           | Required | Meaning                                                                  |
| --------------- | -------- | ------------------------------------------------------------------------ |
| `table`         | yes      | Table name, lowercase, no separators                                      |
| `shape`         | yes      | `master` \| `document` \| `lineitem` \| `map` \| `log`                    |
| `abbrev`        | no       | Short form used in constraint names; defaults to the name minus its suffix|
| `tenancy`       | no       | `true` (default) — set `false` only for a platform-level table            |
| `isactive`      | no       | Defaults to `true` for `master`, `false` otherwise                        |
| `appendOnly`    | no       | Defaults to `true` for `log` — drops the update/delete columns and says why|
| `parent`        | lineitem | Parent table name; the FK column is derived as `<parent minus master>id`  |
| `columns`       | yes      | The business columns, in order — the audit block is appended for you      |
| `codeColumn`    | no       | Column to make unique per org, via a partial unique index                 |
| `pair`          | map      | `["<a>id", "<b>id"]` — the pair that must be unique                       |
| `uniqueForever` | no       | `true` → a plain `UNIQUE` constraint instead of a partial index           |
| `indexes`       | no       | Extra indexes: `{ "name": "...", "columns": [...], "unique": false, "partial": false }` |
| `checks`        | no       | Extra CHECK constraints: `{ "name": "...", "expr": "..." }`               |

Every table gets `idx_<table>_org` on `(organizationid, isdeleted)` — or on
`(organizationid, createdat DESC)` when it is append-only — without asking.
Extra indexes are plain unless you set `"partial": true`, matching the document
indexes in the schema. `name` is worth setting whenever the derived one would be
unwieldy; over 63 characters PostgreSQL truncates silently, so the generator
refuses instead.

### A column

```json
{
  "name": "warehousename",
  "type": "varchar(150)",
  "notNull": true,
  "default": "0",
  "references": "warehousemaster",
  "states": ["active", "in_transit", "closed"],
  "comment": "why this column is not obvious"
}
```

- `type` accepts the short forms (`varchar(150)`, `int2`, `numeric(14,2)`) and
  writes the long-form spelling.
- `references` generates a hand-named FK with no `ON DELETE`. The name comes from
  the **column** — `warehouseid` → `fk_<table>_warehouse` — so two FKs to one
  target become `fk_<table>_fromwarehouse` and `fk_<table>_towarehouse` rather
  than one duplicated name, which PostgreSQL rejects.
- `states` generates the `= ANY (ARRAY[…])` CHECK and validates that every token
  is `lower_snake_case`.
- The generator **refuses** uppercase or underscored names, `boolean`,
  `timestamptz`, unbounded `varchar`, and enum types. That is the point.

### Worked example

```json
{
  "table": "stocktransfermaster",
  "shape": "document",
  "title": "Stock transfer between warehouses",
  "author": "Accrete",
  "codeColumn": "transfernumber",
  "columns": [
    { "name": "transfernumber",   "type": "varchar(50)", "notNull": true },
    { "name": "transferdate",     "type": "date",        "notNull": true },
    { "name": "fromwarehouseid",  "type": "integer",     "notNull": true, "references": "warehousemaster" },
    { "name": "towarehouseid",    "type": "integer",     "notNull": true, "references": "warehousemaster" },
    { "name": "status",           "type": "varchar(20)", "notNull": true, "default": "'draft'",
      "states": ["draft", "in_transit", "received", "cancelled"] },
    { "name": "totalquantity",    "type": "numeric(14,4)", "notNull": true, "default": "0" },
    { "name": "remarks",          "type": "text" }
  ],
  "checks": [
    { "name": "chk_st_different_warehouses", "expr": "fromwarehouseid <> towarehouseid" }
  ],
  "indexes": [
    { "columns": ["organizationid", "status", "transferdate"] }
  ]
}
```

Two FKs to `warehousemaster` from one table is exactly the case the naming rule
covers: qualify the **prefix** (`from`/`to`), never invent a suffix.

### After generating

The generator produces correct-shaped DDL, not a finished design. Always:

1. Read the emitted file top to bottom. The header block needs the real *why*.
2. Check the column order — business columns read best grouped by subject.
3. Add the business-invariant CHECKs a generator cannot infer (non-negativity,
   date ordering, mutual exclusion). These are the cheapest correctness win here.
4. Add an index per hot filter the API will actually use.
5. Fill in the rollback section.
6. Run `verify-ddl.js` on the result.
