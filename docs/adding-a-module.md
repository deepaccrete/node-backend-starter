# How to add an API module

Example: a list of distributors at `GET /api/v1/distributors`, readable with the
`reports:view` permission. Replace names and columns with the real ones — never ship
guessed columns.

> The skill's `create-module.js` generator writes JavaScript, so it does not fit this
> TypeScript project. Follow these steps instead; `src/routes/auth/` is the reference.

## 1. Migration

`migrations/<YYYYMMDD>_create_distributormaster.sql`, following the house conventions
(see `migrations/README.md`). Register every named constraint in `src/utils/pgError.ts`.

## 2. Model — `src/models/<domain>/<name>.model.ts`

All SQL lives here. Every query filters `isdeleted = 0`, values go through `$1, $2…`,
column lists are explicit, and each function takes an optional `db` so it can run inside
`withTransaction`.

```ts
import { run, sortColumn, type Queryable } from '../../config/database.js';

export interface DistributorRow {
  id: number;
  distributorcode: string;
  distributorname: string;
}

const SORTABLE = ['distributorname', 'distributorcode', 'createdat'] as const;

export const DistributorModel = {
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
    const orderBy = sortColumn(p.sortBy, SORTABLE, 'distributorname');
    const where = `isdeleted = 0 AND ($1 = '' OR distributorname ILIKE '%' || $1 || '%')`;
    const { rows } = await run<DistributorRow>(
      db,
      `SELECT id, distributorcode, distributorname FROM distributormaster
              WHERE ${where} ORDER BY ${orderBy} ${p.sortOrder} LIMIT $2 OFFSET $3`,
      [p.search, p.limit, p.offset]
    );
    const { rows: count } = await run<{ total: string }>(
      db,
      `SELECT COUNT(*) AS total FROM distributormaster WHERE ${where}`,
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
import { DistributorModel } from '../../models/masters/distributor.model.js';
import { paginated, parsePagination, type PaginationQuery } from '../../utils/response.js';

export const DistributorController = {
  list: async (req: Request, res: Response) => {
    const p = parsePagination(req.validated.query as PaginationQuery);
    const { rows, total } = await DistributorModel.list(p);
    return paginated(res, rows, total, p.page, p.limit);
  },
};
```

## 4. Route — `src/routes/<domain>/<name>.route.ts`

Schemas, middleware and the OpenAPI registration live together. `router.use(authenticate)`
goes at the top, so every endpoint added later is protected by default.

```ts
import { Router } from 'express';
import { z } from 'zod';
import { DistributorController } from '../../controllers/masters/distributor.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';
import {
  errorResponses,
  jsonContent,
  paginatedEnvelope,
  registry,
  requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(100).optional(),
  sortBy: z.enum(['distributorname', 'distributorcode', 'createdat']).optional(),
  sortOrder: z.enum(['ASC', 'DESC']).optional(),
});
const Distributor = z
  .object({ id: z.number().int(), distributorcode: z.string(), distributorname: z.string() })
  .meta({ id: 'Distributor' });

const PATH = '/distributors';
const router = Router();
router.use(authenticate);

router.get(
  '/',
  requirePermission('reports:view'),
  validate({ query: ListQuery }),
  asyncHandler(DistributorController.list)
);
registry.registerPath({
  method: 'get',
  path: PATH,
  tags: ['Distributors'],
  security: requiresAuth,
  request: { query: ListQuery },
  responses: {
    200: {
      description: 'One page of distributors',
      content: jsonContent(paginatedEnvelope(Distributor)),
    },
    ...errorResponses(400, 401, 403),
  },
});

export default { path: PATH, router };
```

## 5. Permission

A new permission goes in `PERMISSIONS` and `ROLE_PERMISSIONS` in
`src/config/permissions.ts`. Tell the frontend team: they add the name to their list.

## 6. Contract, tests, commit

1. `pnpm gen:openapi` and commit `openapi.json` (CI fails if it is stale).
2. Tests in `tests/` with Supertest; replace the model with `vi.mock` when no database
   is needed (see `tests/auth.test.ts`).
3. Checklist: every query filters `isdeleted = 0`; no `SELECT *`; validator lengths
   match the column widths; multi-table writes in `withTransaction`; 201 on create, 404
   for missing, 409 for duplicates; `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.
