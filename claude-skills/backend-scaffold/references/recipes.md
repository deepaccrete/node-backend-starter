# Recipes

Step-by-step for the work that comes up repeatedly. Conventions and their
reasoning are in `conventions.md`; this file is the how.

---

## Recipe 1 — a new backend from nothing

```bash
node <skill>/scripts/create-backend.js --name my-api --dir ../my-api \
     --desc "What it does" --port 8001 --db my_api_db
cd ../my-api && npm install
# set DB_PASSWORD in .env
createdb my_api_db && npm run migrate && npm run dev
```

Verify before moving on:

```bash
curl localhost:8001/api/v1/health          # {"success":true,"status":"ok",…}
curl localhost:8001/api/v1/health/ready    # database: "up"
npm test && npm run lint
```

Then generate the domain modules the project actually needs (Recipe 2). Do not
leave a backend with only auth in it.

### Doing it by hand

If the generator cannot be used, create in this order — each step is checkable:

1. `package.json`, `.gitignore`, `.env.example`, `eslint.config.js`, `.prettierrc`
2. `src/config/env.js` → `src/config/winston.js` → `src/config/database.js`
   (in that order; each imports the previous)
3. `src/utils/response.js`, `errors.js`, `pgError.js`, `tokens.js`
4. `src/middleware/requestContext.js`, `errorHandler.js`, `notFound.js`, `auth.js`
5. `src/loaders/routeLoader.js`
6. `src/app.js` → `server.js`
7. `migrations/0001_init.sql` (users, organisations, memberships, roles, sessions)
8. `scripts/migrate.js`
9. `src/routes/health/health.route.js`, then the auth vertical slice
10. `tests/`, `README.md`, `Dockerfile`, `docker-compose.yml`

Copy the bodies from `templates/base/` rather than writing them fresh.

---

## Recipe 2 — a new domain module (CRUD)

```bash
node <skill>/scripts/create-module.js --project . \
     --domain purchase --resource supplier --path suppliers \
     --table suppliermaster --prefix SUP
```

| Flag         | Meaning                                        | Default              |
| ------------ | ---------------------------------------------- | -------------------- |
| `--domain`   | folder under routes / controllers / models     | required             |
| `--resource` | file basename and column prefix, one lowercase word | required        |
| `--path`     | mount path (`/api/v1` is prepended)            | `/<resource>s`       |
| `--table`    | table name                                     | `<resource>master`   |
| `--label`    | human label used in messages                   | Title Case resource  |
| `--prefix`   | document-code prefix (`SUP-0001`)              | first two letters    |

> Windows Git Bash rewrites `/suppliers` into a filesystem path. Pass
> `--path suppliers` without the slash, or use PowerShell.

Then finish the module — the generated files are working CRUD over **sample**
columns:

1. **Migration** — replace the sample columns with the real ones. Keep the audit
   columns, `isdeleted`, and the partial unique indexes.
2. **Model** — mirror those columns in the SELECT / INSERT / UPDATE lists and in
   `SORTABLE`.
3. **Route** — match validators to the real column types and widths.
4. **`softDelete`** — add a guard query for every relationship that deleting
   would orphan, returning a reason string the controller maps to wording.
5. **`pgError.js`** — register any new named constraint.
6. `npm run migrate && npm run dev`, then exercise all five endpoints.

---

## Recipe 3 — one endpoint on an existing resource

No generator. Three edits, in this order:

**Model** — add the query:

```js
getByCode: async (code) => {
    const { rows } = await query(
        `SELECT id, suppliercode, suppliername, isactive
           FROM suppliermaster
          WHERE suppliercode = $1 AND isdeleted = 0`,
        [code]
    );
    return rows[0] || null;
},
```

**Controller** — add the handler:

```js
getByCode: async (req, res, next) => {
    try {
        const row = await SupplierModel.getByCode(req.params.code);
        if (!row) return notFound(res, 'Supplier not found');
        return success(res, row);
    } catch (err) { next(err); }
},
```

**Route** — add the line, **above any conflicting `/:id` route** (Express matches
in declaration order, so `/:id` would otherwise swallow `/by-code/:code`):

```js
router.get('/by-code/:code', param('code').trim().notEmpty(), validate, SupplierController.getByCode);
```

Nothing else. The file is already mounted.

---

## Recipe 4 — a list endpoint with filters

```js
// controller
list: async (req, res, next) => {
    try {
        const { page, limit, offset, search, sortBy, sortOrder } = parsePagination(req.query);
        const { rows, total } = await SupplierModel.getAll({
            limit, offset, search, sortBy, sortOrder,
            status: req.query.status,
            city: req.query.city,
        });
        return paginated(res, rows, total, page, limit);
    } catch (err) { next(err); }
},
```

```js
// model — build the filter clause and the params array together, so the
// placeholder numbers can never drift out of step with the values
const params = [`%${search || ''}%`];
let filters = '';

if (status) { params.push(status); filters += ` AND t.status = $${params.length}`; }
if (city)   { params.push(city);   filters += ` AND t.city ILIKE $${params.length}`; }

const orderBy   = sortColumn(sortBy, SORTABLE, 'suppliername');  // whitelist!
const direction = sortOrder === 'ASC' ? 'ASC' : 'DESC';

params.push(limit, offset);
const last = params.length;
```

`sortColumn` is mandatory: an identifier cannot be parameterized, so a raw
`ORDER BY ${req.query.sortBy}` is SQL injection.

Validate the filters in the route so junk never reaches SQL:

```js
query('status').optional().isIn(['active', 'blocked']),
query('limit').optional().isInt({ min: 1, max: 100 }),
```

---

## Recipe 5 — a write that spans tables

```js
createWithLines: (userId, data) =>
    withTransaction(async (client) => {
        // Serialise number generation. Held until the transaction ends, which is
        // what makes concurrent creates safe.
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_CLASS]);

        const { rows: seq } = await client.query(
            `SELECT COALESCE(MAX(SUBSTRING(ordernumber FROM '[0-9]+$')::int), 0) + 1 AS next
               FROM ordermaster`
        );
        const ordernumber = `PO-${String(seq[0].next).padStart(4, '0')}`;

        const { rows: head } = await client.query(
            `INSERT INTO ordermaster (ordernumber, supplierid, createdby, updatedby)
             VALUES ($1, $2, $3, $3)
             RETURNING id, ordernumber`,
            [ordernumber, data.supplierid, userId]
        );

        for (const [index, line] of data.lines.entries()) {
            await client.query(          // client, NOT the module-level query
                `INSERT INTO orderlinemaster
                     (orderid, linenumber, productid, quantity, rate, createdby, updatedby)
                 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
                [head[0].id, index + 1, line.productid, line.quantity, line.rate, userId]
            );
        }

        return head[0];
    }),
```

Every statement uses `client`. One that uses the module-level `query` runs
outside the transaction and will not roll back.

---

## Recipe 6 — a file upload

Route:

```js
const multer = require('multer');

// Memory storage so the controller owns the filename and can delete the file it
// replaces. Multer no-ops on non-multipart requests, so the same PUT handles
// both JSON (fields only) and multipart (fields + file).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only PNG, JPG and WebP images are allowed'));
    },
}).single('image');

// Multer reports rejection through its callback, not through next(err) — turn it
// into a 400 rather than letting it become a 500.
const uploadImage = (req, res, next) =>
    upload(req, res, (err) => (err ? badRequest(res, err.message) : next()));

router.put('/:id/image', uploadImage, ProductController.updateImage);
```

Controller: generate the filename yourself — never use `file.originalname`, which
is attacker-controlled and can contain `../`.

```js
const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.file.mimetype];
const filename = `${req.params.id}-${Date.now()}${ext}`;
await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer);
```

`src/app.js` already serves `src/public/uploads` at `/uploads` with the
cross-origin header a frontend needs to load them as `<img>`.

---

## Recipe 7 — a schema change

1. New file: `migrations/<YYYYMMDD>_<what_it_does>.sql`.
2. Make it idempotent (`IF NOT EXISTS`) where the syntax allows.
3. Name every constraint.
4. **Never edit an applied migration** — the runner checksums them and refuses,
   because an edited migration means production and a fresh database end up with
   different schemas and nothing tells you until something breaks.
5. `npm run migrate:status` to check, `npm run migrate` to apply.

Adding a NOT NULL column to a populated table takes three steps, not one:

```sql
ALTER TABLE suppliermaster ADD COLUMN IF NOT EXISTS gstin varchar(15);
UPDATE suppliermaster SET gstin = '' WHERE gstin IS NULL;
ALTER TABLE suppliermaster ALTER COLUMN gstin SET NOT NULL;
```

---

## Recipe 8 — a sub-resource

Sub-resources live in the parent's route file when they are small, or in their
own file when they have their own lifecycle:

```js
// src/routes/purchase/supplierContact.route.js
module.exports = { path: '/suppliers/:supplierId/contacts', router };
```

`req.params.supplierId` needs `mergeParams` to reach the handlers:

```js
const router = Router({ mergeParams: true });
```

Always verify the parent exists — and, in a multi-tenant project, that it belongs
to the caller's tenant — before touching the child. Otherwise the child endpoint
is a way around every check the parent route performs.

---

## Recipe 9 — retiring an endpoint

- Temporarily: rename the file to `*.route.js.disabled`.
- Permanently: delete the route file, then the controller and model functions
  nothing else calls. Grep for the resource name before deleting a model — a
  model function is often reused by a service or a script.
- Never leave a route mounted that returns 410 "gone" unless a client still
  depends on being told so.
