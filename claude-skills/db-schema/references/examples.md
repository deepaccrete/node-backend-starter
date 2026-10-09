# Worked examples

Full table patterns are in `table-shapes.md`; the MongoDB spec example is in `engines.md`.

## The naming in one view

| Table                                                | Primary key           | A link to it elsewhere                 |
| ---------------------------------------------------- | --------------------- | -------------------------------------- |
| `usermaster`                                         | `userid`              | `userid`, or `<verb>by` (`approvedby`) |
| `rolemaster`                                         | `roleid`              | `roleid`                               |
| `rolepermissionmap` (holds `roleid`, `permissionid`) | `rolepermissionmapid` | `rolepermissionmapid`                  |
| `userrolemap` (holds `userid`, `roleid`)             | `userrolemapid`       | `userrolemapid`                        |
| `invoicemaster`                                      | `invoiceid`           | `invoiceid`                            |
| `invoicelineitem`                                    | `invoicelineitemid`   | `invoicelineitemid`                    |
| `categorymaster` (self link)                         | `categoryid`          | `parentcategoryid`                     |

## A request and what comes back

User: "Create a table for warehouses: code, name, city, and whether it can ship."

1. Ask only what is missing: is `code` unique? Multi-tenant? Which database? (Read the project first; ask only if it does not say.)
2. Shape: master (configured once, referenced often) -> small key, `isactive`.
3. Result (PostgreSQL):

```sql
CREATE TABLE IF NOT EXISTS warehousemaster (
    warehouseid     serial                        PRIMARY KEY,
    warehousecode   varchar(20)                   NOT NULL,
    warehousename   varchar(150)                  NOT NULL,
    city            varchar(100),
    canship         smallint       DEFAULT 0      NOT NULL,
    isactive        smallint       DEFAULT 1      NOT NULL,
    createdby       integer        DEFAULT 1      NOT NULL,
    createdat       timestamp      DEFAULT now()  NOT NULL,
    updatedby       integer        DEFAULT 1      NOT NULL,
    updatedat       timestamp      DEFAULT now()  NOT NULL,
    isdeleted       smallint       DEFAULT 0      NOT NULL,
    CONSTRAINT chk_warehousemaster_canship   CHECK (canship IN (0, 1)),
    CONSTRAINT chk_warehousemaster_isactive  CHECK (isactive IN (0, 1)),
    CONSTRAINT chk_warehousemaster_isdeleted CHECK (isdeleted IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_warehousemaster_code
    ON warehousemaster (warehousecode) WHERE isdeleted = 0;
```

4. Run `verify-ddl.js`, then hand back the file and the apply command.
