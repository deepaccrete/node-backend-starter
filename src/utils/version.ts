import { readFileSync } from 'node:fs';

/**
 * The package version, read once. Located relative to the working directory so it
 * works from source (tsx) and from the compiled `dist/` alike; both run from the
 * project root.
 */
const pkg: unknown = JSON.parse(readFileSync('package.json', 'utf8'));

export const APP_VERSION =
    typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
        ? pkg.version
        : '0.0.0';
