/**
 * One logging pipeline: winston, with morgan streaming into it.
 *
 *   production   JSON to stdout only. In a container the platform collects
 *                stdout; files inside a container vanish when it is replaced.
 *   development  readable console + rotated JSON files under LOG_DIR.
 *   test         silent.
 *
 * Never log a secret, token, password or full request body.
 */

import fs from 'node:fs';
import path from 'node:path';

import winston from 'winston';
import 'winston-daily-rotate-file';

import { env } from './env.js';

const { combine, timestamp, printf, errors, json } = winston.format;

const LEVEL_TAG: Record<string, string> = {
    error: '\x1b[31mERROR\x1b[0m ',
    warn: '\x1b[33mWARN \x1b[0m ',
    debug: '\x1b[90mDEBUG\x1b[0m ',
    http: '\x1b[90mHTTP \x1b[0m ',
};

// `service` is on every line, so it is dropped from the terminal view but kept in JSON.
const humanFormat = printf((info) => {
    const { level, message, timestamp: ts, stack, service: _service, ...meta } = info;
    const text = typeof stack === 'string' ? stack : String(message);
    let line = `\x1b[90m${String(ts)}\x1b[0m ${LEVEL_TAG[level] ?? ''}${text}`;
    if (Object.keys(meta).length) line += ` \x1b[90m${JSON.stringify(meta)}\x1b[0m`;
    return line;
});

function transports(): winston.transport[] {
    if (env.isTest) return [new winston.transports.Console({ silent: true })];
    if (env.isProduction) return [new winston.transports.Console()];

    fs.mkdirSync(env.log.dir, { recursive: true });
    return [
        new winston.transports.Console({
            format: combine(timestamp({ format: 'HH:mm:ss' }), humanFormat),
        }),
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
    ];
}

export const logger = winston.createLogger({
    level: env.log.level,
    defaultMeta: { service: env.APP_NAME },
    format: combine(timestamp(), errors({ stack: true }), json()),
    transports: transports(),
    exitOnError: false,
});

/** Morgan writes newline-terminated strings; route them through winston. */
export const httpLogStream = {
    write: (message: string) => {
        logger.http(message.trim());
    },
};
