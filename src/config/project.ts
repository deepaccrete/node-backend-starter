/**
 * Project identity — the only file that says which product this backend is.
 *
 * Everything else reads from here, so the same codebase serves any project.
 * Edit it by hand if a name changes.
 */
export const project = {
    /** Short lowercase id: cookie prefix, database names in CI and tests. */
    slug: 'tpjp',
    /** Package and service name: default APP_NAME, log lines. */
    name: 'tpjp-api',
    /** Shown as the OpenAPI title. */
    title: 'TPJP API',
    /** One sentence for the OpenAPI document. */
    description: 'Lotte India Telecalling Permanent Journey Plan — dashboard API.',
} as const;
