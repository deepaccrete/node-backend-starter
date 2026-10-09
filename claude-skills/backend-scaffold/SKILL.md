---
name: backend-scaffold
description: Create a new Node.js/Express + PostgreSQL backend from nothing, or add a new API module (route → controller → model) to an existing one, using this organisation's house conventions — dynamic route loading via `{ path, router }`, folder-per-domain layering, raw parameterized SQL, and the standard response envelope. Generates NO database tables and NO auth; the schema and any authentication are the developer's to write, and connection settings are never guessed. Scaffolds STRUCTURE ONLY — it does not implement the project's features, and stops once the skeleton exists. Use whenever someone asks to start a new backend/API/server project, scaffold a backend folder, add a new endpoint/module/resource/CRUD to a backend, or set up the standard project files (.env.example, .gitignore, eslint, Dockerfile, migrations, tests) for one.
---

# Backend Scaffold

Creates production-shaped Express + PostgreSQL backends that follow **our** API
generation style, with everything else at industry standard.

## What this deliberately does NOT do

Read this before generating anything, because it is the most common wrong
assumption about this skill:

- **It creates no database tables.** `migrations/` ships empty. The schema
  depends entirely on the project, so it is the developer's to write.
- **It creates no authentication.** No users table, no login, no JWT, no roles.
  Every generated route is public until someone adds auth.
- **It invents no configuration values.** No `.env` is written, no connection
  setting is defaulted, no secret is generated. `.env.example` ships with blank
  values and the server refuses to boot until they are filled in.

If a project needs auth or multi-tenancy, **build it on top** — do not expect
this skill to have provided it, and do not tell the user it did.

## Scaffolding is the whole job — **STOP when the structure exists**

This skill creates a **folder structure**. It does not build the product that
goes inside it.

When someone asks for a scaffold, a structure, a backend folder, or "set up a
project for X", the deliverable is the generated skeleton and nothing more. The
subject matter in their request — a monitoring service, an inventory API, a
billing system — tells you what to NAME the project. It is not a brief to
implement it.

**After generating, stop and hand back.** Specifically, do not:

- create database tables, or write migrations for the project's domain
- generate domain modules that were not individually asked for
- ask "what domains/entities/tables does this need?" and then build them —
  asking first does not make it requested
- write business logic, services, or endpoints beyond what the generator emits
- add dependencies for guessed requirements (a queue, a mailer, a cache)

Build a module only when the user names it and asks for it. "Scaffold a
monitoring API" is a request for a scaffold; "add a /metrics endpoint" is a
request for a module. Treat a follow-up question as an invitation to build only
when the user actually answers it with a build instruction.

If you think the project obviously needs something, **say so in one line and
leave it undone.** The user decides what gets built.

## What is non-negotiable (our style)

These are the parts that make a backend recognisably ours. Never substitute a
framework convention for them.

1. **Routes register themselves.** `src/loaders/routeLoader.js` walks
   `src/routes/**`, requires every `.js` file, and mounts anything exporting
   `{ path, router }` at `${API_PREFIX}${path}`. **There is no central route
   registry.** Creating the file with the right export IS the registration.
   Parking a route means renaming it to `*.disabled`.
2. **Folder per domain, at every layer.** Never a flat `controllers/` directory:
   ```
   src/routes/<domain>/<resource>.route.js
   src/controllers/<domain>/<resource>.controller.js
   src/models/<domain>/<resource>.model.js
   ```
3. **Strict layering.** Routes own URL + middleware + express-validator rules.
   Controllers are thin: parse request → call one model function → pick a
   response helper. Models own all SQL and never touch `req`/`res`.
4. **Raw parameterized SQL. No ORM.**
5. **One response envelope**, from `src/utils/response.js`.
6. **Configuration is read once**, in `src/config/env.js`, validated at boot.
   Nothing else in the codebase touches `process.env`, and connection settings
   have no fallbacks — a missing value stops the process with a message naming
   it, rather than silently connecting somewhere unintended.
7. **Database conventions**: lowercase column names with no underscores, soft
   delete via `isdeleted smallint`, booleans as `smallint` 0/1, audit columns on
   every table, and named constraints (`uq_`/`fk_`/`ck_`) so
   `src/utils/pgError.js` can map a violation to a usable message.

Full detail: **`references/conventions.md`** — read it before writing any code
for one of these projects.

## Mode 1 — a brand-new backend

```bash
node <skill>/scripts/create-backend.js \
  --name my-api --dir ../my-api --desc "What it does" --port 8001 --db my_api_db
```

> `<skill>` means this skill's own directory — the folder containing this
> SKILL.md. When installed personally that is
> `~/.claude/skills/backend-scaffold`. Substitute the real path; there is no
> folder literally named `<skill>`.

Produces a complete, runnable skeleton: `server.js` + `src/app.js`, config with
boot-time validation, the route loader, request-context / validation / error
middleware, the response and error utilities, a working `/health` and
`/health/ready` endpoint, an empty `migrations/` with its own README, a migration
runner, tests, ESLint, Prettier, Dockerfile, docker-compose, `.gitignore` and
`.env.example`.

Then:

```bash
cd ../my-api && npm install
cp .env.example .env      # fill in PORT, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
npm run dev
```

**After running the generator, STOP.** Report what was created and tell them
plainly that they must fill in `.env` before the server will start, and that the
database named in `DB_NAME` must already exist. Then hand back.

Do not ask what domains the project needs. Do not offer to build them. An empty
skeleton is the finished deliverable for Mode 1 — see "Scaffolding is the whole
job" above.

## Mode 2 — a new module in an existing backend

**Only when the user has asked for that specific module.** Scaffolding a project
is not a request for its modules.

```bash
node <skill>/scripts/create-module.js --project <project-root> \
  --domain purchase --resource supplier --path suppliers \
  --table suppliermaster --prefix SUP
```

Writes the route, controller, model and a migration, wired together and mounted
automatically. It never overwrites an existing file — it reports and skips.

> On Windows Git Bash, pass `--path suppliers` without the leading slash (MSYS
> rewrites `/suppliers` into a filesystem path). PowerShell and Linux/macOS take
> either form.

The generated files carry **sample columns**, not the resource's real ones.

**Do not invent the real ones.** If the user has not told you what fields this
resource has, hand back the generated module, say the columns are placeholders,
and ask what the fields should be. A guessed schema is worse than an obvious
placeholder — the placeholder gets replaced, a plausible guess gets shipped.

When the user HAS specified the fields, finish the module:

1. Replace the sample columns in the migration with the real ones.
2. Mirror those columns in the model's SELECT / INSERT / UPDATE lists.
3. Match the route's validators to the real column types and widths — a
   `varchar(150)` column wants `isLength({ max: 150 })`, so an over-long paste is
   a 400 instead of a database error.
4. Add referential guards in `softDelete` for anything that would be orphaned.
5. Register any new named constraint in `src/utils/pgError.js` so a collision
   becomes a message the user can act on.

## Mode 3 — writing it by hand

When the generators do not fit (an unusual resource, adding one endpoint to an
existing file, a non-CRUD action), follow **`references/recipes.md`**, which has
the annotated templates and step-by-step recipes for endpoints, transactions,
pagination, file uploads, sub-resources and migrations.

## Adding authentication

The scaffold has none. When a project needs it:

- Write the schema as a migration — it is an ordinary table like any other.
- Put the token or session check in `src/middleware/auth.js`.
- Apply it with `router.use(authenticate)` at the top of each route file, not
  per endpoint, so a route added later inherits it rather than being silently
  public.
- Set `req.user`. Generated controllers already read `req.user?.id` for the
  `createdby` / `updatedby` audit columns, so they start recording real ids with
  no further changes.

If the project is multi-tenant, resolve the tenant in middleware onto `req` and
**enforce it in SQL** — every business query filters the tenant column. A tenant
check that lives only in middleware is one forgotten `router.use` away from
leaking another tenant's rows.

## Adapting to an existing project

Before generating into a project that already exists, **read one existing route,
controller and model first** and match what you find. Concretely: whether route
files are named `*.route.js` or `*.routes.js`, whether the project has auth or
tenancy middleware the generated file should call, and which response helpers are
already in play. A generated file that disagrees with its neighbours is worse
than one written by hand.

If the existing project has drifted (two database pool modules, two response
naming styles, `process.env` read in twenty files), **do not silently "fix" it
while doing other work** — match the surrounding file, and mention the drift to
the user as a separate suggestion.

## Before saying a backend is done

Run through **`references/checklists.md`**. The items that catch real bugs:

- Every business query filters `isdeleted = 0`.
- No `SELECT *` in anything that reaches a response.
- Every async handler either uses `try/catch (err) { next(err) }` or is wrapped
  in `asyncHandler` — Express 4 does not catch rejected promises.
- Every route file that declares express-validator rules also runs `validate`;
  rules without it are a silent no-op.
- Multi-table writes are inside `withTransaction`, and every statement in the
  unit of work goes through the transaction's `client`, not the module `query`.
- No secret, connection string, or real `.env` is committed.
- `npm run lint` and `npm test` pass, and the server boots with a filled-in `.env`.

## Files in this skill

| Path                          | What it is                                              |
| ----------------------------- | ------------------------------------------------------- |
| `scripts/create-backend.js`   | Generates a whole project from `templates/base/`         |
| `scripts/create-module.js`    | Generates one domain module from `templates/module/`     |
| `templates/base/`             | The project skeleton (placeholders: `{{PROJECT_NAME}}`, `{{PORT}}`, `{{DB_NAME}}`, `{{API_PREFIX}}`, `{{PROJECT_DESC}}`) |
| `templates/module/`           | Route / controller / model / migration templates         |
| `references/conventions.md`   | The house style, in full — read before writing code      |
| `references/recipes.md`       | Step-by-step recipes and hand-written templates          |
| `references/checklists.md`    | Review checklists for new projects and new endpoints     |
