/**
 * Write the OpenAPI contract to openapi.json.
 *
 *   pnpm gen:openapi
 *
 * Builds the app (which imports every route file, and each route registers its
 * paths), then generates the document. Commit the result: it is the contract the
 * frontend generates its types from. CI fails when it is out of date.
 * Needs no database.
 */

import 'dotenv/config';

import fs from 'node:fs';

import { createApp } from '../src/app.js';
import { pool } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { generateOpenApiDocument } from '../src/openapi/registry.js';
import { APP_VERSION } from '../src/utils/version.js';

await createApp();
const document = generateOpenApiDocument(env.API_PREFIX, APP_VERSION);
fs.writeFileSync('openapi.json', `${JSON.stringify(document, null, 2)}\n`);
console.log(`openapi.json written (${Object.keys(document.paths ?? {}).length} paths).`);
await pool.end();
