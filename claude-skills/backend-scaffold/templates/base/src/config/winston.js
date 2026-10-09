const path = require('path');
const fs = require('fs');
const winston = require('winston');
require('winston-daily-rotate-file');

const env = require('./env');

fs.mkdirSync(env.log.dir, { recursive: true });

const { combine, timestamp, printf, errors, json } = winston.format;

// Console format, tuned for a human watching a terminal.
//
// Two decisions worth keeping:
//   * `service` is dropped. It is on every single line, so it carries no
//     information in a terminal that is already showing one service — but it
//     stays in the JSON files, where a shipper aggregating several services
//     needs it.
//   * `info` prints no level tag. It is the overwhelming majority of startup
//     output, and tagging every line INFO just pushes the actual message right.
//     WARN and ERROR still announce themselves, which is the point of a tag.
const LEVEL_TAG = {
    error: '[31mERROR[0m ',
    warn: '[33mWARN [0m ',
    debug: '[90mDEBUG[0m ',
    http: '[90mHTTP [0m ',
};

const humanFormat = printf(({ level, message, timestamp: ts, stack, service, ...meta }) => {
    void service;
    let line = `[90m${ts}[0m ${LEVEL_TAG[level] || ''}${stack || message}`;
    if (Object.keys(meta).length) line += ` [90m${JSON.stringify(meta)}[0m`;
    return line;
});

const logger = winston.createLogger({
    level: env.log.level,
    defaultMeta: { service: env.APP_NAME },
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        // Files are JSON so a log shipper can index them; the console is
        // human-readable. Grepping a production incident and reading dev output
        // are different jobs and want different formats.
        json()
    ),
    transports: [
        new winston.transports.DailyRotateFile({
            filename: path.join(env.log.dir, 'error-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            level: 'error',
            maxFiles: '30d',
            zippedArchive: true,
        }),
        new winston.transports.DailyRotateFile({
            filename: path.join(env.log.dir, 'combined-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            maxFiles: '14d',
            zippedArchive: true,
        }),
    ],
    exceptionHandlers: [
        new winston.transports.File({ filename: path.join(env.log.dir, 'exceptions.log') }),
    ],
    exitOnError: false,
});

if (!env.isProduction) {
    logger.add(
        new winston.transports.Console({
            format: combine(timestamp({ format: 'HH:mm:ss' }), humanFormat),
        })
    );
}

// Morgan writes newline-terminated strings; route them through winston so there
// is one log pipeline, not two.
logger.stream = { write: (message) => logger.http(message.trim()) };

module.exports = logger;
