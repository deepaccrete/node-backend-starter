# Checklists

Run the relevant list before calling work done. Items are ordered by how much
damage they do when missed.

---

## Every endpoint

**Soft delete and access**

- [ ] **Every** SELECT, and the WHERE of every UPDATE, filters `isdeleted = 0`.
- [ ] The route file declares validator rules AND runs `validate` after them.
      Rules without `validate` never reject anything.
- [ ] If the project has added auth: the route file applies it with
      `router.use(...)` at the top, so a route added later inherits it rather
      than being silently public. If it has not, the endpoint being public is a
      deliberate choice, not an oversight.
- [ ] If the project is multi-tenant: **every** query in the model filters the
      tenant column, and a row belonging to another tenant reads as **404**,
      never 403 — a 403 confirms the row exists.

**SQL**

- [ ] All values pass through `$1, $2, …`. No value is interpolated into a query
      string.
- [ ] Any client-supplied ORDER BY column goes through `sortColumn()` against a
      whitelist.
- [ ] No `SELECT *` in anything that reaches a response.
- [ ] `RETURNING` lists explicit columns.
- [ ] Multi-table writes are inside `withTransaction`, and **every** statement in
      the unit of work uses the transaction's `client`.
- [ ] Generated numbers come from `MAX(...)` under a lock, not `COUNT(*)`.

**Contract**

- [ ] express-validator rules cover every accepted field.
- [ ] `validate` runs after the rules and before the controller.
- [ ] Validator lengths match the column widths.
- [ ] Required-but-patchable fields use `optional({ nullable: true })`, so an
      explicit `""` is still rejected.
- [ ] The list endpoint uses `parsePagination` + `paginated`.
- [ ] Status codes are right: 201 on create, 400 for a refused business rule,
      404 for missing, 409 for a duplicate.

**Errors**

- [ ] Every async handler has `try/catch (err) { next(err) }` or `asyncHandler`.
- [ ] No `throw 'string'`.
- [ ] 4xx messages are written for the user, not copied from a driver.
- [ ] New named constraints are registered in `pgError.js`.

**Route file**

- [ ] Exports `{ path, router }`.
- [ ] Its `path` is not already claimed by another module (the loader will throw,
      but catching it here is cheaper).
- [ ] Specific paths (`/by-code/:code`) are declared **before** `/:id`.

---

## A new project, before first commit

**Secrets**

- [ ] `.env` is gitignored and **not** in `git status`.
- [ ] `.env.example` lists every variable, with blank or placeholder values only
      — never a real host, database name or password.
- [ ] Any secret the project adds later is 32+ characters and generated, not
      typed, and two different secrets are never the same value.
- [ ] No password, token or connection string appears in any tracked file.

**Runs**

- [ ] `npm install` from a clean checkout succeeds.
- [ ] `npm run migrate` succeeds against an empty database (a project with no
      migrations yet should report nothing pending, not fail).
- [ ] The server refuses to boot with an incomplete `.env`, and the error names
      the missing variable.
- [ ] `npm run dev` boots; `/api/v1/health` returns 200 and `/api/v1/health/ready`
      reports the database up.
- [ ] `npm test` and `npm run lint` pass.
- [ ] A wrong or missing secret makes the server refuse to start, with a message
      that says how to fix it.

**Shape**

- [ ] Routes / controllers / models are folder-per-domain, not flat.
- [ ] Exactly **one** database pool module.
- [ ] Exactly **one** set of response helpers.
- [ ] `process.env` is read only in `src/config/env.js`.
- [ ] `README.md` documents setup, commands, and the layering.

**Production readiness**

- [ ] helmet, CORS allowlist, rate limiting (with a stricter `/auth/*` bucket).
- [ ] Body size limits on `express.json`.
- [ ] `trust proxy` set if it will run behind a proxy.
- [ ] Graceful shutdown closes the server and then the pool.
- [ ] Logs are files + console, rotated, and contain no secrets.
- [ ] Dockerfile runs as a non-root user.

---

## Reviewing someone else's module

Fastest order to find real problems:

1. `grep -c isdeleted` the model, and compare it against the number of queries.
   A mismatch means a soft-deleted row reappears somewhere.
2. If the project is multi-tenant, do the same count for the tenant column. A
   mismatch there is a cross-tenant leak.
3. `grep "SELECT \*"` — should return nothing.
4. Read the delete path. Does it soft-delete? Does it guard against orphaning?
5. Read the update path. Does COALESCE let an empty string overwrite real data?
6. Check every `async (req, res` handler has a `catch`.
7. Check the route's validators against the migration's column widths.

---

## Adapting to an existing project

Before generating or writing anything:

- [ ] Read one existing route, controller and model in that project.
- [ ] Match the file naming (`.route.js` vs `.routes.js`).
- [ ] Match the auth and tenancy middleware actually in use — this scaffold
      ships neither, so whatever the project has was written by hand.
- [ ] Match the response helper names actually in use.
- [ ] Match the import path for the database module.

If the project has drifted (two pool modules, two response naming styles), match
the surrounding file and raise the drift with the user separately. Do not
silently "fix" it as a side effect of unrelated work.
