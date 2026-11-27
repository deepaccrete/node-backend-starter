# TPJP API (backend)

The API behind the TPJP (Telecalling Permanent Journey Plan) web dashboard, built by
AITPL for Lotte India. Node.js + Express + PostgreSQL, in TypeScript.

The frontend lives in its own repository (`tpjp/frontend`). This API **owns the
contract between them**: it publishes `openapi.json`, and it decides which role holds
which permission.

---

## 1. Getting started

### What you need

| Tool       | Version                 | Check with       |
| ---------- | ----------------------- | ---------------- |
| Node.js    | 22 or newer             | `node -v`        |
| pnpm       | 12                      | `pnpm -v`        |
| PostgreSQL | 16 or newer (or Docker) | `psql --version` |

### Steps

```bash
cd tpjp/backend
pnpm install
cp .env.example .env     # then fill in every (required) value — see section 5
pnpm create-admin        # the Super Admin: asks for username, name, password
pnpm dev                 # http://localhost:8001/api/v1
```

The database in `DB_NAME` must already exist. Development uses the company PostgreSQL
server, database `tpjp`. The schema is the `.sql` files in `migrations/`, applied in
order by `pnpm migrate` (see `migrations/README.md`). To work offline instead:
`docker compose up -d db` starts PostgreSQL 16 on port **5433** (set `DB_PORT=5433`),
then run `pnpm migrate` against it.

Check it is up: `http://localhost:8001/api/v1/health` (process) and
`/api/v1/health/ready` (database). The live contract is at `/api/v1/openapi.json`
(not served in production).

---

## 2. Commands

| Command                                                | What it does                          |
| ------------------------------------------------------ | ------------------------------------- |
| `pnpm dev`                                             | Start with auto-reload (tsx)          |
| `pnpm build`                                           | Compile to `dist/`                    |
| `pnpm start`                                           | Run the compiled build                |
| `pnpm typecheck`                                       | TypeScript check                      |
| `pnpm lint` / `pnpm lint:fix`                          | ESLint, zero warnings allowed         |
| `pnpm format` / `pnpm format:check`                    | Prettier                              |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Vitest + Supertest                    |
| `pnpm migrate` / `pnpm migrate:status`                 | Apply / list `migrations/*.sql`       |
| `pnpm create-admin`                                    | Create the Super Admin account        |
| `pnpm gen:openapi`                                     | Regenerate `openapi.json` (commit it) |

---

## 3. Architecture

### Request flow

```
request
  → app.ts middleware: helmet, CORS, request id, body parsing, logging, rate limit
  → route        src/routes/<domain>/<name>.route.ts      URL, middleware, Zod schemas
  → controller   src/controllers/<domain>/<name>.controller.ts   thin glue
  → service      src/services/<name>.service.ts           only when several models work together
  → model        src/models/<domain>/<name>.model.ts      all SQL, parameterized
  → response     src/utils/response.ts                    the one envelope
errors → src/middleware/errorHandler.ts
```

| Layer      | Owns                                                                | Must never                       |
| ---------- | ------------------------------------------------------------------- | -------------------------------- |
| Route      | URL, middleware chain, Zod schemas, OpenAPI registration            | contain a handler body or SQL    |
| Controller | read `req`, call ONE model/service function, pick a response helper | contain SQL                      |
| Service    | coordination across several models (e.g. login)                     | be reached directly from a route |
| Model      | all SQL, transactions                                               | touch `req` or `res`             |

### Registering a route

Every route file under `src/routes/` ends with `export default { path, router }`. The
routes are listed by hand in `src/app.ts`: to add one, import the module there and add it
to the `routeModules` list. It is mounted at `${API_PREFIX}${path}`.

- A route file that is not in `routeModules` is never mounted.
- Add the new path to the `mounts every route module` test in `tests/app.test.ts`.
- Keep paths unique; nothing checks for duplicates at startup.

### Response envelope

```json
{ "success": true,  "message": "Data fetched", "data": [], "meta": { "pagination": { "total": 45, "page": 2, "limit": 20, "totalPages": 3, "hasNext": true, "hasPrev": true } } }
{ "success": false, "code": "VALIDATION_FAILED", "message": "Validation failed", "errors": [{ "field": "username", "message": "Enter your username" }], "requestId": "…" }
```

Every error has a **`code`** from `src/utils/errorCodes.ts`. Messages are for people
and may be reworded; codes are for programs and never change once published.

Lists take `page`, `limit` (max 100), `search`, `sortBy`, `sortOrder` (`ASC`/`DESC`) —
see `parsePagination` and `sortColumn`.

### Validation and the contract

Each route declares Zod schemas and passes them to `validate({ body, query, params })`.
The same schemas are registered in the OpenAPI registry, so the published contract and
the real validation cannot disagree. `pnpm gen:openapi` writes `openapi.json`; CI fails
if it is stale. The frontend generates its TypeScript types from that file.

### Authentication

Only the **Super Admin** signs in through this API (table `usermaster`, role
`SUPERADMIN`). Every other role (Admin, GM, ZM, RM, ASM) signs in, and gets its
role-wise dashboard access, through the .NET team's central user management (CUM)
API; that integration is a separate task. There is no self sign-up, no forced
password change and no forgot-password: the account is made with `pnpm create-admin`.

| Endpoint                     | What it does                                                                |
| ---------------------------- | --------------------------------------------------------------------------- |
| `POST /auth/login`           | `{ username, password }` → `{ user, accessToken }`; sets the refresh cookie |
| `POST /auth/refresh`         | refresh cookie → new `{ user, accessToken }`; rotates the cookie            |
| `POST /auth/logout`          | revokes the session, clears the cookie → `204`                              |
| `GET /auth/me`               | the signed-in user                                                          |
| `POST /auth/change-password` | `{ currentPassword, newPassword }`; ends every session, returns a fresh one |

- **Access token** (15 min): returned in the body; the frontend keeps it in memory and
  sends `Authorization: Bearer …`. The API never accepts it from a cookie (CSRF).
- **Refresh token** (7 days, sliding): only in the `tpjp_rt` cookie — httpOnly,
  SameSite=Strict, path `/api/v1/auth`, Secure outside development. Stored hashed in
  `authsession`. Each refresh **rotates** it; presenting an old one ends every session
  of that user (`REFRESH_REUSED`), which is how a stolen token is detected.
- Separate secrets for the two token types, checked at boot (32+ characters, different).
- Passwords: bcrypt, 12 rounds. The same message for an unknown user and a wrong password.
- **Lockout**: 5 wrong passwords lock the account for 15 minutes (`ACCOUNT_LOCKED`, 423).
  `/auth` also has its own, stricter rate limit.
- **Permissions**: `src/config/permissions.ts` maps roles to permissions. The login
  response includes the user's list. Protect a route with
  `router.use(authenticate)` at the top of the file, then
  `requirePermission('plans:upload')` per endpoint.

The frontend reaches the API through the same site (Vite proxy in development, nginx in
production), which is what lets the SameSite=Strict cookie work.

### Database conventions (house style)

- Lowercase names without underscores: `customername`, `createdat`. Primary key
  `<entity>id` (`usermaster.userid`); a foreign key has the same name as the key it
  points to (`authsession.userid`).
- Flags are `smallint` 0/1. Soft delete: `isdeleted`; **every** query filters `isdeleted = 0`.
- Audit columns on every table: `createdby`, `createdat`, `updatedby`, `updatedat`.
- Timestamps are `timestamp` without a time zone, so time is always taken and compared
  in SQL (`now()`), never with a JavaScript `Date`.
- Named constraints (`uq_`, `fk_`, `chk_`), registered in `src/utils/pgError.ts`.
- Never `SELECT *`. Values only through `$1, $2…`. Multi-table writes inside
  `withTransaction`, with every statement on the transaction's client (models take an
  optional `db` argument for this).

### Folder structure

```
server.ts                  process: start, graceful shutdown
src/
  app.ts                   middleware stack and the list of route modules
  config/                  env.ts (the only reader of process.env), database.ts, logger.ts, permissions.ts
  middleware/              requestContext, validate, authenticate, requirePermission, notFound, errorHandler
  routes/ controllers/ models/   one folder per domain at each layer
  services/                auth.service.ts, token.service.ts
  openapi/registry.ts      contract registry and helpers
  utils/                   response, errors, errorCodes, pgError, asyncHandler, banner, version
  types/express.d.ts       req.id, req.user, req.validated
  public/                  served static files (uploads)
migrations/                the schema SQL, applied by hand (no runner)
scripts/                   create-admin, gen-openapi
tests/                     Vitest + Supertest
openapi.json               the published contract (generated, committed)
```

---

## 4. Logging

winston, with morgan feeding HTTP lines into it. Production writes JSON to **stdout only**
(the platform collects it). Development prints readable lines and also writes rotated
files to `LOG_DIR`. Every request has an `X-Request-Id`, included in error responses and
logs. Never log a secret, token, password or full request body.

---

## 5. Settings (`.env`)

Every variable is documented in `.env.example`. Required: `PORT`, `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD` (may be empty), `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`; plus `CORS_ORIGIN` in production. Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 6. Docker

```bash
docker compose up -d db      # then apply migrations/*.sql to it (DBeaver)
docker compose up -d api
```

The image compiles the TypeScript, keeps production dependencies only, runs as the
non-root `node` user, and reports healthy once `/api/v1/health/ready` answers.

---

## 7. Commits

Conventional Commits (`feat: …`, `fix: …`), by convention (no commit hooks). Run
`pnpm lint` and `pnpm format` before committing. CI runs lint, typecheck, tests, build and the contract
check. Tests need no database: they replace the model layer.

Adding an endpoint: see [docs/adding-a-module.md](docs/adding-a-module.md).
