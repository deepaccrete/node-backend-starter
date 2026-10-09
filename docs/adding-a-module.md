# How to add an API module

Example: a list of products at `GET /api/v1/products`, readable with the
`products:view` permission (with login). Replace names and columns with the real ones — never ship
guessed columns.

> The skill's `create-module.js` generator writes JavaScript, so it does not fit this
> TypeScript project. Follow these steps instead; `src/routes/health/` (and `src/routes/auth/`
> with login) are the references.

## 1. Migration

`migrations/<YYYYMMDD>_create_productmaster.sql`, following the house conventions
(see `migrations/README.md`). Register every named constraint in `src/utils/pgError.ts`.

## 2. Model — `src/models/<domain>/<name>.model.ts`

All SQL lives here. Every query filters `isdeleted = 0`, values go through `$1, $2…`,
column lists are explicit, and each function takes an optional `db` so it can run inside
`withTransaction`.

```ts
import { run, sortColumn, type Queryable } from '../../config/database.js';

export interface ProductRow {
  id: number;
  productcode: string;
  productname: string;
}

const SORTABLE = ['productname', 'productcode', 'createdat'] as const;

export const ProductModel = {
  list: async (
    p: {
      limit: number;
      offset: number;
      search: string;
      sortBy: string | null;
      sortOrder: 'ASC' | 'DESC';
    },
    db?: Queryable
  ) => {
    const orderBy = sortColumn(p.sortBy, SORTABLE, 'productname');
    const where = `isdeleted = 0 AND ($1 = '' OR productname ILIKE '%' || $1 || '%')`;
    const { rows } = await run<ProductRow>(
      db,
      `SELECT id, productcode, productname FROM productmaster
              WHERE ${where} ORDER BY ${orderBy} ${p.sortOrder} LIMIT $2 OFFSET $3`,
      [p.search, p.limit, p.offset]
    );
    const { rows: count } = await run<{ total: string }>(
      db,
      `SELECT COUNT(*) AS total FROM productmaster WHERE ${where}`,
      [p.search]
    );
    return { rows, total: Number(count[0]?.total ?? 0) };
  },
};
```

## 3. Controller — `src/controllers/<domain>/<name>.controller.ts`

Thin: read the request, call one model (or service) function, choose a response helper.
Use arrow functions in the exported object.

```ts
import type { Request, Response } from 'express';
import { ProductModel } from '../../models/catalog/product.model.js';
import { paginated, parsePagination, type PaginationQuery } from '../../utils/response.js';

export const ProductController = {
  list: async (req: Request, res: Response) => {
    const p = parsePagination(req.validated.query as PaginationQuery);
    const { rows, total } = await ProductModel.list(p);
    return paginated(res, rows, total, p.page, p.limit);
  },
};
```

## 4. Route — `src/routes/<domain>/<name>.route.ts`

Schemas, middleware and the OpenAPI registration live together. With login,
`router.use(authenticate)` goes at the top, so every endpoint added later is protected by
default. Without login, the lines between the `@auth` markers do not apply.

```ts
import { Router } from 'express';
import { z } from 'zod';
import { ProductController } from '../../controllers/catalog/product.controller.js';
// @auth-start
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
// @auth-end
import { validate } from '../../middleware/validate.js';
import {
  errorResponses,
  jsonContent,
  paginatedEnvelope,
  registry,
  // @auth-start
  requiresAuth,
  // @auth-end
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(100).optional(),
  sortBy: z.enum(['productname', 'productcode', 'createdat']).optional(),
  sortOrder: z.enum(['ASC', 'DESC']).optional(),
});
const Product = z
  .object({ id: z.number().int(), productcode: z.string(), productname: z.string() })
  .meta({ id: 'Product' });

const PATH = '/products';
const router = Router();
// @auth-start
router.use(authenticate);
// @auth-end

router.get(
  '/',
  // @auth-start
  requirePermission('products:view'),
  // @auth-end
  validate({ query: ListQuery }),
  asyncHandler(ProductController.list)
);
registry.registerPath({
  method: 'get',
  path: PATH,
  tags: ['Products'],
  // @auth-start
  security: requiresAuth,
  // @auth-end
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'One page of products',
      content: jsonContent(paginatedEnvelope(Product)),
    },
    ...errorResponses(400, 401, 403),
  },
});

export default { path: PATH, router };
```

<!-- @auth-start -->

## 5. Permission

A new permission (`products:view`) goes in `PERMISSIONS` and is granted to roles in
`ROLE_PERMISSIONS` (`src/config/permissions.ts`). ADMIN gets it automatically. Tell the
frontend team: they add the name to their list.

<!-- @auth-end -->

## 6. Contract, tests, commit

1. `pnpm gen:openapi` and commit `openapi.json` (CI fails if it is stale).
2. Tests in `tests/` with Supertest; replace the model with `vi.mock` when no database
   is needed (see `tests/app.test.ts`).
3. Checklist: every query filters `isdeleted = 0`; no `SELECT *`; validator lengths
   match the column widths; multi-table writes in `withTransaction`; 201 on create, 404
   for missing, 409 for duplicates; `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.
