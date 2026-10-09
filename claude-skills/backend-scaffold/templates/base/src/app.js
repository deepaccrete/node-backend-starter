/**
 * The Express application: middleware stack, routes, error handling.
 *
 * Exported without being listened on, so tests can drive it directly. Ordering
 * in this file is load-bearing — read the section comments before moving
 * anything.
 */

const path = require('path');
const fs = require('fs');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const logger = require('./config/winston');
const { loadRoutes } = require('./loaders/routeLoader');
const requestContext = require('./middleware/requestContext');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// ─── Proxy awareness ──────────────────────────────────────────────────
// Behind nginx or a load balancer every request arrives from the proxy, so
// without this `req.ip` is the proxy's address: all clients share ONE
// rate-limit bucket and audit rows record the proxy instead of the caller.
// `1` trusts a single hop — raise it only if there are more proxies in front.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ─── Security headers ─────────────────────────────────────────────────
app.use(
    helmet({
        // This process serves JSON and static uploads, not an HTML app, so the
        // page-oriented policies are relaxed and the transport ones are not.
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

// ─── CORS ─────────────────────────────────────────────────────────────
app.use(
    cors({
        origin: (origin, callback) => {
            // Non-browser clients (curl, Postman, server-to-server) send no Origin.
            if (!origin) return callback(null, true);
            // Development allows any origin so a phone or a second machine on
            // the LAN can hit the API without editing config.
            if (!env.isProduction) return callback(null, true);
            if (env.corsOrigins.includes(origin)) return callback(null, true);
            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
        exposedHeaders: ['X-Request-Id'],
    })
);

// ─── Request id + timing ──────────────────────────────────────────────
// Before logging, so every log line for a request can be tied together.
app.use(requestContext);

// ─── Body parsing ─────────────────────────────────────────────────────
// The limit is a denial-of-service control: without it a single request can ask
// the process to buffer arbitrary memory.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());

// ─── HTTP logging ─────────────────────────────────────────────────────
app.use(
    morgan(env.isProduction ? 'combined' : 'dev', {
        stream: logger.stream,
        skip: () => env.isTest,
    })
);

// ─── Rate limiting ────────────────────────────────────────────────────
app.use(
    env.API_PREFIX,
    rateLimit({
        windowMs: env.rateLimit.windowMs,
        max: env.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        skip: () => env.isTest,
        message: { success: false, message: 'Too many requests, please try again later.' },
    })
);

// When you add endpoints worth brute-forcing (login, password reset, OTP), give
// them their own stricter bucket rather than lowering the global limit:
//
//   app.use(`${env.API_PREFIX}/auth`, rateLimit({ ...same options, max: 20 }));

// ─── Static uploads ───────────────────────────────────────────────────
// Files written under src/public/<bucket> are served at /<bucket>/<file>.
// The Cross-Origin-Resource-Policy header lets a frontend on a different origin
// load these as <img> resources — helmet defaults to same-origin, which blocks it.
const publicDir = path.join(__dirname, 'public');
for (const bucket of ['uploads']) {
    const dir = path.join(publicDir, bucket);
    fs.mkdirSync(dir, { recursive: true });
    app.use(
        `/${bucket}`,
        (req, res, next) => {
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            next();
        },
        express.static(dir, { maxAge: '7d', index: false, dotfiles: 'deny' })
    );
}

// ─── Routes ───────────────────────────────────────────────────────────
// Auto-discovered: any src/routes/**/*.js exporting { path, router } is mounted.
// The mounted paths are kept on `app.locals` so server.js can report the count
// in the startup banner without loading the routes a second time.
app.locals.mountedRoutes = loadRoutes(app, path.join(__dirname, 'routes'), env.API_PREFIX);

// ─── Fallbacks ────────────────────────────────────────────────────────
// Must be last, and in this order: a 404 is only a 404 once no route matched,
// and the error handler must be the final `use` for Express to recognise it.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
