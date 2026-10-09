# {{PROJECT_NAME}}

{{PROJECT_DESC}}

Express 4 + PostgreSQL REST API. Raw parameterized SQL, no ORM. Every endpoint is
mounted under `{{API_PREFIX}}`.

## Quick start

> **This project ships no `.env` and no database tables.** Nothing here guesses
> your connection settings, and nothing creates a schema you did not write.

```bash
npm install

cp .env.example .env      # then open .env and fill in every (required) value
npm run dev               # nodemon on the PORT you set
```

The values you must provide before the server will start:

| Variable      | Notes                                                     |
| ------------- | --------------------------------------------------------- |
| `PORT`        | port this API listens on                                    |
| `DB_HOST`     | usually `localhost` in development                          |
| `DB_PORT`     | usually `5432`                                              |
| `DB_NAME`     | the database must already exist — this project won't create it |
| `DB_USER`     | database user                                               |
| `DB_PASSWORD` | keep the line even if empty (trust/peer auth)               |

`src/config/env.js` checks these at boot and refuses to start with a message
naming whatever is missing, rather than connecting somewhere unintended and
failing later. Nothing else in the codebase reads `process.env` directly.

With Docker instead:

```bash
docker compose up --build
```

## Your first table

`migrations/` is empty by design. Add a `.sql` file there and apply it:

```bash
npm run migrate           # apply pending migrations/*.sql
npm run migrate:status    # list applied vs pending, apply nothing
```

See `migrations/README.md` for naming rules and a starting example.

## Commands

| Command                  | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `npm run dev`            | nodemon, auto-reload                                 |
| `npm start`              | plain node (production)                              |
| `npm run migrate`        | apply pending `migrations/*.sql`                     |
| `npm run migrate:status` | list applied vs pending migrations                   |
| `npm test`               | `node --test tests/**/*.test.js`                     |
| `npm run lint`           | eslint                                               |
| `npm run format`         | prettier                                             |

## Architecture

Request flow is **route → controller → model**, one folder per domain at each layer:

```
src/routes/<domain>/<name>.route.js             endpoints, validators, middleware
src/controllers/<domain>/<name>.controller.js   thin: parse req, call model, respond
src/models/<domain>/<name>.model.js             all SQL, parameterized
```

### Routes are auto-registered

`src/loaders/routeLoader.js` walks `src/routes/` recursively, `require`s every
`.js` file, and mounts anything exporting `{ path, router }` at
`${API_PREFIX}${path}`. **There is no central route registry** — creating the file
with the right export is the whole registration step.

- Files ending in `.disabled` are skipped (used to park unfinished routes).
- A file that exports the wrong shape is logged as a warning, not silently ignored.
- Two modules claiming the same `path` is a startup error, not a silent shadowing.

### Response envelope

Everything goes through `src/utils/response.js`:

```json
{ "success": true, "data": {}, "meta": { "pagination": {} } }
{ "success": false, "message": "...", "errors": [] }
```

### Database conventions

- Column names are lowercase with no underscores: `customername`, `createdat`.
- Soft delete everywhere: `isdeleted smallint DEFAULT 0`; every `SELECT` filters `isdeleted = 0`.
- Booleans are `smallint` (0/1), not `boolean`.
- Audit columns on every table: `createdby`, `createdat`, `updatedby`, `updatedat`.
- Name your constraints (`uq_`, `fk_`, `ck_`) so `src/utils/pgError.js` can turn a
  violation into a message a user can act on.

### Authentication

**There is none yet, by design** — what counts as a user differs per project, so
the scaffold does not invent a `users` table or a login flow for you.

Every route is currently public. When you add auth:

1. Write the schema as a migration.
2. Put the token/session check in `src/middleware/auth.js`.
3. Apply it per route file with `router.use(authenticate)` rather than per
   endpoint, so a route added later inherits it instead of being silently public.
4. Set `req.user` — the generated controllers already read `req.user?.id` for the
   `createdby` / `updatedby` audit columns and will start recording real ids with
   no further changes.

## Adding an endpoint

1. `src/routes/<domain>/<name>.route.js` exporting `{ path, router }`.
2. express-validator rules, then the `validate` middleware, then the controller.
3. SQL in `src/models/<domain>/`, always filtering `isdeleted = 0`.
4. Schema changes go in a new `migrations/<YYYYMMDD>_<name>.sql`.
