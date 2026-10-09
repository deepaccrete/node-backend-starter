/**
 * Serves the OpenAPI document at ${API_PREFIX}/openapi.json outside production,
 * so developers and tools can read the live contract. In production the route
 * answers 404 like any unknown path; the committed openapi.json is the contract.
 */

import { Router } from 'express';

import { env } from '../../config/env.js';
import { notFound } from '../../middleware/notFound.js';
import { generateOpenApiDocument } from '../../openapi/registry.js';
import { APP_VERSION } from '../../utils/version.js';

const router = Router();

router.get('/', (req, res, next) => {
    if (env.isProduction) {
        notFound(req, res, next);
        return;
    }
    // Generated on request, after every route module has registered its paths.
    res.json(generateOpenApiDocument(env.API_PREFIX, APP_VERSION));
});

export default { path: '/openapi.json', router };
