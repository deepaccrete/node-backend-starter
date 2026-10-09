# Backend conventions

The house style for Express + PostgreSQL backends. Read this before writing code
in one of these projects.

Sections marked **OURS** are the parts that make a backend recognisably ours —
never substitute a framework default for them. Everything else is ordinary good
practice, and the reasoning is given so you can tell when an exception is
justified.

---

## 1. Layering — **OURS**

```
src/routes/<domain>/<resource>.route.js         URL + middleware + validation
src/controllers/<domain>/<resource>.controller.js   thin glue
src/models/<domain>/<resource>.model.js         all SQL
src/services/<name>.service.js                  cross-model coordination
```

**Folder per domain at every layer.** Never a flat `controllers/` directory.
Sub-folders nest freely for sub-surfaces — `src/routes/vansales/mobile/…`.

| Layer          | Owns                                                            | Must never                                    |
| -------------- | --------------------------------------------------------------- | --------------------------------------------- |
| **Route**      | URL shape, middleware chain, express-validator rules             | contain a handler body or any SQL             |
| **Controller** | read `req`, call ONE model function, choose a response helper    | contain SQL, or a rule another caller needs   |
| **Model**      | all SQL, transactions, business rules expressible as data        | touch `req` or `res`, or send a status code   |
| **Service**    | orchestration across several models (PDFs, email, ledgers)       | be reached directly from a route              |

The test for whether logic belongs in a controller: **would a script or a cron
job need it too?** If yes, it belongs in the model or a service. A controller
that grows a second model call plus branching has outgrown its layer.

### File naming

- Routes: `<resource>.route.js` (or `.routes.js` — **match the project you are
  in**, do not mix within one project).
- Controllers: `<resource>.controller.js`. Models: `<resource>.model.js`.
- Exported object is PascalCase and named: `WarehouseController`, `WarehouseModel`.

---

## 2. Route registration — **OURS**

`src/loaders/routeLoader.js` walks `src/routes/**`, requires every `.js` file,
and mounts anything exporting `{ path, router }`:

```js
module.exports = { path: '/warehouses', router };   // → /api/v1/warehouses
```

Consequences to internalise:

- **There is no central registry.** Creating the file with that export is the
  entire registration step. Do not look for, or add, a `routes/index.js`.
- **`*.disabled` is how a route is parked.** Renaming `foo.route.js` to
  `foo.route.js.disabled` withdraws it without deleting it.
- **A file exporting the wrong shape is warned about at boot**, not silently
  ignored — a route that quietly does not exist is expensive to debug.
- **Two modules claiming the same `path` is a startup error.** Express would
  otherwise mount both and let the first win, which is shadowing with no message.
- Files are loaded in sorted order, so mount order is the same on every machine.

---

## 3. The response envelope — **OURS**

Everything answers through `src/utils/response.js`. One naming style per project;
never introduce a parallel set of helpers.

```json
{ "success": true,  "message": "Data fetched", "data": [], "meta": { "pagination": {} } }
{ "success": false, "message": "Validation failed", "errors": [{ "field": "email", "message": "..." }] }
```

| Helper                                         | Status | Use for                        |
| ---------------------------------------------- | ------ | ------------------------------ |
| `success(res, data, message?, status?, meta?)` | 200    | reads, updates                 |
| `created(res, data, message?)`                 | 201    | creates                        |
| `paginated(res, rows, total, page, limit)`     | 200    | list endpoints                 |
| `noContent(res)`                               | 204    | deletes with nothing to return |
| `badRequest(res, message, errors?)`            | 400    | bad input, refused business rule |
| `unauthorized(res, message?)`                  | 401    | missing/invalid credentials    |
| `forbidden(res, message?)`                     | 403    | authenticated but not allowed  |
| `notFound(res, message?)`                      | 404    | no such row (see the tenant note below) |
| `conflict(res, message, errors?)`              | 409    | duplicate, state clash         |

**401 vs 403**: 401 means "we do not know who you are"; 403 means "we do, and you
may not". Answering 403 for an expired token makes clients retry instead of
refreshing.

**404 for another tenant's row.** If the project is multi-tenant, a record that
exists but belongs to a different tenant must read as not-found, never as
forbidden — 403 confirms the row exists, which is itself a cross-tenant leak.

---

## 4. Auth and multi-tenancy — **NOT PROVIDED**

The scaffold ships **no authentication and no tenancy**. There is no users table,
no login, no token handling, no `X-Org-Id`. Every generated route is public.

This is deliberate: what counts as a user, and whether the product is multi-tenant
at all, differs per project. Inventing a users table that every project then has
to fight is worse than shipping none.

So: **do not tell a user the scaffold gave them auth, and do not import
middleware that does not exist.** Build it when the project needs it.

### If you add authentication

- Write the schema as an ordinary migration.
- Put the check in `src/middleware/auth.js`, exporting it as ordinary Express
  middleware alongside the existing `src/middleware/validate.js`.
- Apply it with `router.use(authenticate)` at the **top of each route file**, not
  per endpoint. A route added later then inherits it, instead of being silently
  public — which is the failure that actually happens in practice.
- Set `req.user`. The generated controllers already read `req.user?.id` for the
  `createdby` / `updatedby` audit columns and start recording real ids with no
  other change.
- **Bearer header only, no cookie fallback** for the API. A token accepted from a
  cookie is a token a cross-site request can carry, which is CSRF.

If you use JWTs specifically:

- Sign access and refresh with **different secrets**, and enforce them distinct
  at boot. Sharing one lets a refresh token verify as an access token.
- Put a `typ` claim on every token and check it on verify **before** any other
  claim.
- Put a `sid` claim naming a session row. Without one, logout is a client-side
  gesture and revocation is impossible.
- Rotate refresh tokens: presenting a superseded generation revokes every session
  for that user, which is how a stolen refresh token gets detected.

### If the project is multi-tenant

1. **Resolve the tenant in one place**, in middleware, onto `req`. A route that
   skips it is a route where any signed-in user reads any tenant's data by
   changing one header.
2. **Enforce tenancy in SQL.** There is no row-level security in the database.
   Every business query filters the tenant column. Forgetting it is a data breach
   that no test, type or framework will catch for you.
3. **A role is only meaningful inside one tenant.** Resolve it from the
   membership row for the active tenant. Never from a global flag on the user row
   — such a flag follows a user into every tenant they are later invited to and
   overrides the role they were actually given there.
4. **Compare role codes, never display names.** A display name is text someone
   may rename; a substring test like `rolename.includes('admin')` also matches
   "Administrative Assistant".
5. **Another tenant's row reads as 404, never 403** — see §3.

---

## 5. Validation

Rules live **in the route file**, followed by the `validate` middleware:

```js
router.post(
    '/',
    body('warehousename').trim().notEmpty().withMessage('Warehouse name is required')
        .bail().isLength({ min: 2, max: 150 }).withMessage('Name must be 2–150 characters'),
    body('isactive').optional().isInt({ min: 0, max: 1 }),
    validate,
    WarehouseController.create
);
```

- **`.bail()` after each `withMessage`** so one field reports one error rather
  than a stack of them.
- **Lengths mirror the column widths.** A `varchar(150)` column wants
  `isLength({ max: 150 })` — otherwise an over-long paste is a database error
  instead of a field-level 400.
- **Two kinds of optional**, and mixing them up corrupts data:
  ```js
  // blank means "not set" — skip when absent OR empty
  const optional  = (chain) => chain.optional({ nullable: true, checkFalsy: true });
  // required but patchable — skip when ABSENT, still reject an explicit ""
  const patchable = (chain) => chain.optional({ nullable: true });
  ```
  `patchable` exists because the UPDATE statement COALESCEs: COALESCE only
  guards against NULL, so an explicit `""` would be written over real data.
- Share a rule between POST and PUT by extracting it to a function, so the two
  cannot drift apart.

---

## 6. Database conventions — **OURS**

| Convention                | Example                                              |
| ------------------------- | ---------------------------------------------------- |
| lowercase, no underscores | `customername`, `warehousecode`, `createdat`          |
| exception: FKs to a table | `customermaster_id` — reads as a relationship, not an attribute |
| booleans are `smallint`   | `isactive smallint NOT NULL DEFAULT 1` (0/1)          |
| soft delete               | `isdeleted smallint NOT NULL DEFAULT 0`               |
| audit columns everywhere  | `createdby`, `createdat`, `updatedby`, `updatedat`    |
| tables                    | `<thing>master` for masters, `<thing>map` for junctions |

**The scaffold creates none of these tables** — `migrations/` ships empty. These
are the rules your own migrations follow.

### Every query, without exception

```sql
WHERE isdeleted = 0
```

Add the tenant column to that line in every query if the project is multi-tenant.

### Unique indexes are partial

```sql
CREATE UNIQUE INDEX uq_warehousemaster_code
    ON warehousemaster (warehousecode) WHERE isdeleted = 0;
```

Scoped to live rows: a soft-deleted record must not reserve its code forever. In
a multi-tenant project the tenant column leads the index, since two tenants may
both have "WH-0001".

### Name your constraints

`uq_<table>_<cols>`, `fk_<table>_<ref>`, `ck_<table>_<rule>`. The name is the key
`src/utils/pgError.js` uses to turn a violation into a message a user can act on.
An auto-generated name cannot be mapped reliably.

### Never `SELECT *` in anything that reaches a response

List the columns. `*` returns whatever someone adds to the table later —
including a password hash.

### Transactions

Use `withTransaction` whenever one request writes to more than one table, or
reads a value it is about to write against (sequence numbers, stock balances).

```js
return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_CLASS]);
    // EVERY statement in the unit of work goes through `client`
});
```

**Every statement in the unit of work must use the transaction's `client`.** A
statement issued through the module-level `query` runs on a different connection,
outside the transaction, and will not roll back — a silent partial write.

### Generated document numbers

Read the next sequence from `MAX(...)` **under a lock**, never from `COUNT(*)`:

- `COUNT(*)` hands the same number to two concurrent transactions, because
  neither sees the other's uncommitted row.
- `COUNT(*)` silently reuses a number when a row is hard-deleted.
- Count deleted rows deliberately when taking the MAX: the unique index still
  holds them, and a number that once existed must never be issued twice.
- In a multi-tenant project, scope both the lock and the MAX to the tenant, or
  two tenants' Nth document collide — and two tenants creating records at the
  same moment should not queue behind each other.

---

## 7. Errors

- Raise operational failures with the classes in `src/utils/errors.js`, or return
  a response helper directly from the controller.
- **Never `throw` a bare string** — a thrown string has no stack.
- Controllers wrap bodies in `try/catch (err) { next(err) }`, or use
  `asyncHandler`. Express 4 does not await handlers: an async handler that throws
  without one of these rejects a promise nobody is watching, so the request hangs
  and nothing is logged.
- The global handler applies one rule: **4xx messages are ours, 5xx messages are
  not.** A 4xx message was written for the user; a 5xx message is whatever a
  driver or a remote service happened to say and gets replaced with something
  generic. The real message and stack always reach the logs.
- Constraint violations are translated to 400 by `pgError.js` — they mean the
  client sent something unstorable, which is bad input, not a server fault.

---

## 8. Configuration

- `process.env` is read in **one file**: `src/config/env.js`. Nowhere else.
- Config is validated at **boot**, so a missing value stops the deploy rather
  than surfacing at the first request that needs it.
- **Connection settings have no defaults.** `PORT`, `DB_HOST`, `DB_PORT`,
  `DB_NAME` and `DB_USER` are required, and the error names whichever is missing.
  A default here is a request quietly sent to the wrong database.
- The scaffold writes **no `.env` and no values**. `.env.example` ships blank and
  the developer fills it in once, before first boot.
- Secrets are never committed. `.env` is gitignored; `.env.example` documents
  every variable with a blank or placeholder value and a comment explaining what
  it does.

---

## 9. Logging

- One pipeline: winston, with morgan streaming into it.
- Files are JSON (a log shipper indexes them); the console is human-readable.
- **Never log a secret, token, password or full request body.**
- Every request carries an `X-Request-Id`; include it in error logs so the lines
  for one failing request can be found together.
- Debug tracing (`console.log('🔵 …')`) does not get committed. If a code path is
  worth tracing permanently, it is worth a `logger.debug`.

---

## 10. Security baseline

- `helmet`, CORS allowlist (enforced in production), rate limiting — a stricter
  bucket on `/auth/*`.
- Body size limits on `express.json`.
- `app.set('trust proxy', 1)` behind a proxy, or every client shares one
  rate-limit bucket and audit rows record the proxy's address.
- Passwords hashed with bcrypt at 12+ rounds.
- Login answers the same message for "no such user" and "wrong password" —
  distinguishing them enumerates valid accounts.
- Account lockout after repeated failures, in addition to rate limiting: rate
  limiting protects the endpoint, lockout protects the individual account against
  a distributed attempt.
- Uploads: cap the size, check the MIME type, and never trust the client's
  filename.
