/**
 * The startup banner. Printed with console.log, not through winston: it is a
 * one-off view for a human at a terminal, not a log record.
 *
 * Padding is measured on the PLAIN text and colour applied afterwards, so the
 * right-hand border lines up on a terminal and in a piped log alike.
 */

import os from 'node:os';

const WIDTH = 58; // inner width, between the two vertical borders
const LABEL = 13; // label column width, so every colon lines up

const tty = process.stdout.isTTY;
const paint = (code: string) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint('2');
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');

const clip = (text: string, max: number) =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const row = (text = '') => `║${clip(`  ${text}`, WIDTH).padEnd(WIDTH)}║`;
const field = (label: string, value: string) => row(`${label.padEnd(LABEL)}: ${value}`);
const centre = (text: string, colour: (t: string) => string = (t) => t) => {
    const clipped = clip(text, WIDTH - 2);
    const left = Math.floor((WIDTH - clipped.length) / 2);
    return `║${' '.repeat(left)}${colour(clipped)}${' '.repeat(WIDTH - left - clipped.length)}║`;
};

/** First non-internal IPv4 address, so the banner can show a LAN-reachable URL. */
export function lanAddress(): string | null {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return null;
}

/** Binding to 0.0.0.0 / :: accepts every interface; anything else accepts one. */
export const isWildcard = (host: string) => host === '0.0.0.0' || host === '::' || host === '';

export interface BannerInfo {
    name: string;
    env: string;
    port: number;
    host: string;
    apiPrefix: string;
    database: string;
    routeCount: number;
}

export function printBanner({
    name,
    env,
    port,
    host,
    apiPrefix,
    database,
    routeCount,
}: BannerInfo): void {
    const lines = [
        `╔${'═'.repeat(WIDTH)}╗`,
        centre(name, cyan),
        `╠${'═'.repeat(WIDTH)}╣`,
        field('Environment', env),
        field('Port', String(port)),
        field('Host', isWildcard(host) ? `${host} (all interfaces)` : host),
        field('API prefix', apiPrefix),
        field('Database', database),
        field('Routes', `${routeCount} mounted`),
        field('Started', new Date().toLocaleTimeString()),
        `╚${'═'.repeat(WIDTH)}╝`,
        '',
    ];

    // URLs outside the box so they stay clickable as whole links.
    if (isWildcard(host)) {
        const lan = lanAddress();
        lines.push(`  ${dim('Local:  ')} ${green(`http://localhost:${port}${apiPrefix}`)}`);
        if (lan) lines.push(`  ${dim('Network:')} ${green(`http://${lan}:${port}${apiPrefix}`)}`);
    } else {
        lines.push(`  ${dim('URL:    ')} ${green(`http://${host}:${port}${apiPrefix}`)}`);
        if (host !== 'localhost' && host !== '127.0.0.1') {
            lines.push(
                '',
                `  ${yellow('Note:')} bound to a single interface — http://localhost:${port} will NOT connect.`
            );
            lines.push(`  ${dim('       Set HOST=0.0.0.0 in .env to listen on both.')}`);
        }
    }

    lines.push('');
    console.log(lines.join('\n'));
}
