# Table shapes

Five shapes cover almost every table. Pick one, then add the user's columns.
Written in PostgreSQL; respell with engines.md for other databases.
`organizationid` lines apply only to multi-tenant projects (R16); delete them otherwise.

Column order: primary key, `organizationid` (if any), links, business columns,
`isactive` (masters only), the audit block last.

## 1. Master / reference

Configured once, referenced many times: users, products, customers, units, reasons.
Small key, has `isactive`, code unique among live rows.

```sql
CREATE TABLE IF NOT EXISTS <entity>master (
    <entity>id      serial                        PRIMARY KEY,
    organizationid  integer                       NOT NULL,
    <entity>code    varchar(20)                   NOT NULL,
    <entity>name    varchar(150)                  NOT NULL,
    description     text,
    sortorder       smallint       DEFAULT 0      NOT NULL,
    isactive        smallint       DEFAULT 1      NOT NULL,   -- 0 = kept for history, not offered for new use
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    updatedby       integer        DEFAULT 1      NOT NULL,
    updatedat       timestamp      DEFAULT now()  NOT NULL,   -- written by the app on every update
    isdeleted       smallint       DEFAULT 0      NOT NULL,
    CONSTRAINT chk_<entity>master_isactive  CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_<entity>master_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_<entity>master_organization FOREIGN KEY (organizationid)
        REFERENCES organizationmaster (organizationid)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_<entity>master_code
    ON <entity>master (organizationid, <entity>code) WHERE isdeleted = 0;
CREATE INDEX IF NOT EXISTS idx_<entity>master_org
    ON <entity>master (organizationid, isdeleted);
```

## 2. Document

A business event with a lifecycle: orders, invoices, payments, requests.
Big key, **no `isactive`** (the lifecycle is `status`), status guarded by a CHECK,
number never reissued.

```sql
CREATE TABLE IF NOT EXISTS <doc>master (
    <doc>id         bigserial                     PRIMARY KEY,
    organizationid  integer                       NOT NULL,
    <doc>number     varchar(50)                   NOT NULL,   -- minted by the app, never reissued
    <doc>date       date                          NOT NULL,
    customerid      integer                       NOT NULL,
    status          varchar(20)  DEFAULT 'draft'  NOT NULL,
    totalamount     numeric(14,2) DEFAULT 0       NOT NULL,
    remarks         text,
    approvedby      integer,
    approvedat      timestamp,
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    updatedby       integer        DEFAULT 1      NOT NULL,
    updatedat       timestamp      DEFAULT now()  NOT NULL,
    isdeleted       smallint       DEFAULT 0      NOT NULL,
    CONSTRAINT chk_<doc>master_status   CHECK (status IN ('draft', 'approved', 'cancelled')),
    CONSTRAINT chk_<doc>master_total    CHECK (totalamount >= 0),
    CONSTRAINT chk_<doc>master_isdeleted CHECK (isdeleted IN (0, 1)),
    CONSTRAINT fk_<doc>master_customer FOREIGN KEY (customerid) REFERENCES customermaster (customerid),
    CONSTRAINT fk_<doc>master_approvedby FOREIGN KEY (approvedby) REFERENCES usermaster (userid)
);

-- All rows, deleted included: a document number is never reissued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_<doc>master_number ON <doc>master (organizationid, <doc>number);
CREATE INDEX IF NOT EXISTS idx_<doc>master_status_date
    ON <doc>master (organizationid, status, <doc>date) WHERE isdeleted = 0;
```

## 3. Line item

Child rows of a document. Big key, links to the parent, carries `organizationid` too.

```sql
CREATE TABLE IF NOT EXISTS <doc>lineitem (
    <doc>lineitemid bigserial                     PRIMARY KEY,
    organizationid  integer                       NOT NULL,
    <doc>id         bigint                        NOT NULL,
    productid       integer                       NOT NULL,
    quantity        numeric(14,4)                 NOT NULL,
    unitprice       numeric(14,4)                 NOT NULL,
    lineamount      numeric(14,2) GENERATED ALWAYS AS (round(quantity * unitprice, 2)) STORED,
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    updatedby       integer        DEFAULT 1      NOT NULL,
    updatedat       timestamp      DEFAULT now()  NOT NULL,
    isdeleted       smallint       DEFAULT 0      NOT NULL,
    CONSTRAINT chk_<doc>lineitem_quantity CHECK (quantity > 0),
    CONSTRAINT fk_<doc>lineitem_<doc> FOREIGN KEY (<doc>id) REFERENCES <doc>master (<doc>id),
    CONSTRAINT fk_<doc>lineitem_product FOREIGN KEY (productid) REFERENCES productmaster (productid)
);

CREATE INDEX IF NOT EXISTS idx_<doc>lineitem_parent ON <doc>lineitem (<doc>id) WHERE isdeleted = 0;
```

## 4. Map (many-to-many)

Links two masters. Own key (R3), the pair unique among live rows, full audit block.

```sql
CREATE TABLE IF NOT EXISTS <a><b>map (
    <a><b>mapid     serial                        PRIMARY KEY,
    <a>id           integer                       NOT NULL,
    <b>id           integer                       NOT NULL,
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    updatedby       integer        DEFAULT 1      NOT NULL,
    updatedat       timestamp      DEFAULT now()  NOT NULL,
    isdeleted       smallint       DEFAULT 0      NOT NULL,
    CONSTRAINT fk_<a><b>map_<a> FOREIGN KEY (<a>id) REFERENCES <a>master (<a>id),
    CONSTRAINT fk_<a><b>map_<b> FOREIGN KEY (<b>id) REFERENCES <b>master (<b>id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_<a><b>map_pair ON <a><b>map (<a>id, <b>id) WHERE isdeleted = 0;
CREATE INDEX IF NOT EXISTS idx_<a><b>map_<b> ON <a><b>map (<b>id) WHERE isdeleted = 0;
```

## 5. Log (append-only)

Never updated, never retracted. Big key, `createdby` + `createdat` only (R8).

```sql
-- append-only: rows are never updated or deleted, so no updatedby / updatedat / isdeleted.
CREATE TABLE IF NOT EXISTS <thing>log (
    <thing>logid    bigserial                     PRIMARY KEY,
    userid          integer                       NOT NULL,
    action          varchar(30)                   NOT NULL,
    details         text,
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    CONSTRAINT fk_<thing>log_user FOREIGN KEY (userid) REFERENCES usermaster (userid)
);

CREATE INDEX IF NOT EXISTS idx_<thing>log_user_time ON <thing>log (userid, createdat);
```
