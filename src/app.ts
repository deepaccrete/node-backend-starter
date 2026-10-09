/**
 * The Express application: middleware stack, routes, error handling.
 *
 * Built by `createApp()` without listening, so tests drive it directly. Ordering
 * in this file is load-bearing — read the section comments before moving anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';

import { env } from './config/env.js';
import { httpLogStream } from './config/logger.js';
import { loadRoutes } from './loaders/routeLoader.js';
import { CORS_REJECTED, errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { requestContext } from './middleware/requestContext.js';
import type { ErrorCode } from './utils/errorCodes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const limiter = (max: number) =>
    rateLimit({
        windowMs: env.rateLimit.windowMs,
        limit: max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        skip: () => env.isTest,
        message: {
            success: false,
            code: 'RATE_LIMITED' satisfies ErrorCode,
            message: 'Too many requests, please try again later.',
        },
    });

export async function createApp(): Promise<Express> {
    const app = express();

    // ─── Proxy awareness ──────────────────────────────────────────────
    // Behind nginx or a load balancer every request arrives from the proxy; without
    // this all clients share ONE rate-limit bucket and audit rows record the proxy.
    app.set('trust proxy', 1);
    app.disable('x-powered-by');

    // ─── Security headers ─────────────────────────────────────────────
    // This process serves JSON and static uploads, not an HTML app.
    app.use(
        helmet({
            crossOriginEmbedderPolicy: false,
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    imgSrc: ["'self'", 'data:', 'https:'],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'", "'unsafe-inline'"],
                },
            },
        })
    );

    // ─── CORS ─────────────────────────────────────────────────────────
    app.use(
        cors({
            origin: (origin, callback) => {
                // Non-browser clients (curl, server-to-server) send no Origin.
                if (!origin) {
                    callback(null, true);
                    return;
                }
                // Development allows any origin so a second machine on the LAN works without config.
                if (!env.isProduction || env.corsOrigins.includes(origin)) {
                    callback(null, true);
                    return;
                }
                callback(new Error(CORS_REJECTED));
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
            exposedHeaders: ['X-Request-Id'],
        })
    );

    // ─── Request id + timing ──────────────────────────────────────────
    // Before logging, so every log line for a request can be tied together.
    app.use(requestContext);

    // ─── Body parsing ─────────────────────────────────────────────────
    // The limit is a denial-of-service control.
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: true, limit: '2mb' }));
    app.use(cookieParser());

    // ─── HTTP logging ─────────────────────────────────────────────────
    app.use(
        morgan(env.isProduction ? 'combined' : 'dev', {
            stream: httpLogStream,
            skip: () => env.isTest,
        })
    );

    // ─── Rate limiting ────────────────────────────────────────────────
    // Login is worth brute-forcing, so /auth has its own, stricter bucket.
    app.use(`${env.API_PREFIX}/auth`, limiter(env.rateLimit.authMax));
    app.use(env.API_PREFIX, limiter(env.rateLimit.max));

    // ─── Static uploads ───────────────────────────────────────────────
    // Files under src/public/<bucket> are served at /<bucket>/<file>. CORP lets a
    // frontend on another origin load them as <img>; helmet defaults to same-origin.
    const publicDir = path.join(here, 'public');
    for (const bucket of ['uploads']) {
        const dir = path.join(publicDir, bucket);
        fs.mkdirSync(dir, { recursive: true });
        app.use(
            `/${bucket}`,
            (_req, res, next) => {
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
                next();
            },
            express.static(dir, { maxAge: '7d', index: false, dotfiles: 'deny' })
        );
    }

    // ─── Routes ───────────────────────────────────────────────────────
    // Auto-discovered: any route file under src/routes exporting { path, router }.
    app.locals.mountedRoutes = await loadRoutes(app, path.join(here, 'routes'), env.API_PREFIX);

    // ─── Fallbacks ────────────────────────────────────────────────────
    // Last, in this order: a 404 only once no route matched; the error handler
    // must be the final `use` for Express to recognise it.
    app.use(notFound);
    app.use(errorHandler);

    return app;
}
