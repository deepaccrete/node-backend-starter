# The judgement pass

`verify-ddl.js` catches everything mechanical. These are the questions it cannot
answer — each one has cost someone real time in this schema.

Work through them before handing the migration back.

## The design

**Is this one table or two?** An entity with a repeating group is two tables — a
document master and its line items. Five columns named `product1id`…`product5id`
is the failure mode.

**Is it a document or a master?** The suffix is `*master` either way, but the
shape differs: a document gets `bigserial`, a `status` with a CHECK, a
per-org-unique number, and **no `isactive`**. A master gets `serial`, `isactive`,
and a code. Getting this backwards produces a table with both `isactive` and
`status`, which nobody can filter correctly.

**Does an existing table already hold this?** 111 tables is enough that a
near-duplicate is likely. Grep for the closest noun before adding. Two tables
holding the same fact drift, and the screens that read them disagree.

**Would a column suffice?** One boolean flag on an existing row is a column, not
a new table.

## The columns

**Is every state in the list a real state?** The CHECK is the contract. A missing
token means an application UPDATE fails at runtime with a constraint violation,
and the token list is the one thing a generator genuinely cannot guess. Read the
list back to the user.

**Is a `NOT NULL` column always supplied on insert?** The generic master model
sends `''` for an omitted field, which a `NOT NULL` column rejects with a 23502 —
this is why `master.model.js` caches `columnMeta(table)`. Either give the column
a default or confirm the write path always sets it.

**Does every nullable column have a meaning when NULL?** "Not yet known",
"not applicable", "the platform default" are all fine — but they must be
different columns' meanings, not one column carrying three. `organizationsettings`
uses NULL deliberately for "platform default", and it needs two complementary
partial unique indexes to make that work.

**Is the precision right?** `numeric(14,2)` for money, `numeric(14,4)` for
quantities and unit prices, `numeric(5,2)` for percentages. A quantity at 2 dp
silently truncates part-units; a percentage at `numeric(14,2)` accepts 900%.

**Is the varchar length from the ladder, and does it fit the data?** 20 for
codes/phones/GSTIN, 50 for document numbers, 100 for city/state, 150 for person
names and email, 200 for addresses and long names, 500 for URLs. The route's
validator will mirror this — `isLength({ max: 150 })` — so an over-long paste is
a 400, not a database error.

**Should this `text` be a bounded `varchar`?** `remarks` and `notes` are `text`
in 38/38 cases. Anything else that a user types into a single-line field should
be bounded.

## Tenancy

**Every business table carries `organizationid` with the FK.** No exceptions
except platform-level tables, and those should be named as such in a comment.

**Is every unique constraint org-scoped?** This is deviation D8, and it is the
one with high blast radius: `UNIQUE (invoicenumber)` means two tenants cannot
both issue `INV-0001`, and the failure appears as a duplicate-key error in an
unrelated tenant's request. Every unique on a business value is
`(organizationid, …)`.

**Can a soft-deleted row block a new one?** A plain `UNIQUE` constraint says yes;
a partial index `WHERE isdeleted = 0` says no. Document numbers must never be
reissued — plain unique or partial, either works since deleted rows keep their
number. Product codes usually should be reusable — partial index.

## Indexes

**Does every index match a query the API will run?** Write down the three
queries: the tenant list, the lookup by code/number, and the parent-child fetch.
An index that matches none of them is maintenance cost with no return.

**Is `(organizationid, isdeleted)` there?** Every SELECT in the codebase filters
both — 1 164 occurrences of `isdeleted = 0`. Without the index, every list
endpoint is a sequential scan that gets slower per tenant added.

**Is the leading column the one that is always filtered?** `(organizationid,
status, date)` serves org-only and org+status queries; `(status,
organizationid)` serves neither well.

## Constraints

**Which business invariants can the database enforce?** Non-negativity, date
ordering, mutual exclusion between two nullable FKs, a child quantity not
exceeding its parent's. There are 20 such CHECKs in the schema and every one of
them is cheaper than the bug it prevents.

**Do two dated rows need to not overlap?** That is an EXCLUDE constraint, gated
on `isdeleted = 0`, not an application check. Two precedents exist.

**Does the FK target actually exist yet?** In a multi-table migration, parents
first.

## The application contract

**Will the model filter `isdeleted = 0`?** The table is only soft-deleted if
every query says so. Flag it to whoever writes the model — this is where
`new-api` picks up.

**Will the model set `updatedat = NOW()`?** There is no trigger. If the table has
`updatedat`, something in the application must write it on every UPDATE, and
forgetting is silent.

**Does anything need a transaction?** A document master plus its line items, an
allocation plus its ledger row, a stock movement — these are `withTransaction`
work, and the table design should make the unit of work obvious.

**Does the number need minting?** If the table has a `<doc>number`, it uses
`src/utils/docNumber.js` under `pg_advisory_xact_lock` — not a sequence, not
`COUNT(*)`. Say so when handing back.

## Before handing back

- [ ] `verify-ddl.js` passes, or every finding is justified out loud.
- [ ] The header block says what, why, and whether it is behaviour-neutral.
- [ ] The rollback section exists and is commented out.
- [ ] The state token list has been confirmed with the user, not guessed.
- [ ] No table was created that was not asked for.
- [ ] The apply command was handed over — not run.
- [ ] Any deviation found in the surrounding schema was reported, not fixed.
