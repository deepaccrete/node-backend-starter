/**
 * The startup banner.
 *
 * Printed with `console.log`, not through winston, on purpose: it is a one-off
 * presentation for a human watching a terminal, not a log record. Sending it
 * through the logger would stamp a timestamp and a level onto every one of its
 * lines and write the box-drawing characters into the JSON log files, where
 * nothing can read them.
 *
 * Every row is padded to the same inner width so the right-hand border lines up
 * regardless of how long the values are. A banner whose edges do not align is a
 * banner someone has to stop and look at.
 */

const os = require('os');

const WIDTH = 58; // inner width, between the two vertical borders
const LABEL = 13; // label column width, so every colon lines up

// Colour only when a human is watching. Piping to a file or a CI log should not
// collect escape sequences.
const tty = process.stdout.isTTY;
const c = (code, text) => (tty ? `[${code}m${text}[0m` : text);
const dim = (text) => c('2', text);
const cyan = (text) => c('36', text);
const green = (text) => c('32', text);
const yellow = (text) => c('33', text);

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const top = () => `╔${'═'.repeat(WIDTH)}╗`;
const sep = () => `╠${'═'.repeat(WIDTH)}╣`;
const bottom = () => `╚${'═'.repeat(WIDTH)}╝`;

const row = (text = '') => `║${clip(`  ${text}`, WIDTH).padEnd(WIDTH)}║`;

/**
 * Centre `text` in the box, optionally painted.
 *
 * The padding is measured on the PLAIN text and the colour applied afterwards.
 * Colouring first would count the escape sequence toward the length — nine
 * invisible characters for one colour — and the right-hand border would sit
 * nine columns short on a terminal while looking perfect in a piped log.
 */
const centre = (text, paint = (t) => t) => {
    const clipped = clip(text, WIDTH - 2);
    const left = Math.floor((WIDTH - clipped.length) / 2);
    return `║${' '.repeat(left)}${paint(clipped)}${' '.repeat(WIDTH - left - clipped.length)}║`;
};

const field = (label, value) => row(`${label.padEnd(LABEL)}: ${value}`);

/** First non-internal IPv4 address, so the banner can show a LAN-reachable URL. */
const lanAddress = () => {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) return address.address;
        }
    }
    return null;
};

/** Binding to 0.0.0.0 / :: accepts every interface; anything else accepts one. */
const isWildcard = (host) => host === '0.0.0.0' || host === '::' || host === '';

/**
 * @param {object} info
 * @param {string} info.name        application name
 * @param {string} info.env         NODE_ENV
 * @param {number} info.port
 * @param {string} info.host        the address actually bound
 * @param {string} info.apiPrefix
 * @param {string} info.database    database name, or a note when unavailable
 * @param {number} info.routeCount  route modules mounted
 */
const printBanner = ({ name, env, port, host, apiPrefix, database, routeCount }) => {
    const lines = [
        top(),
        centre(name, cyan),
        sep(),
        field('Environment', env),
        field('Port', String(port)),
        field('Host', isWildcard(host) ? `${host} (all interfaces)` : host),
        field('API prefix', apiPrefix),
        field('Database', database),
        field('Routes', `${routeCount} mounted`),
        field('Started', new Date().toLocaleTimeString()),
        bottom(),
        '',
    ];

    // The URLs a developer actually clicks. Printed outside the box so they stay
    // selectable as whole URLs — a border character glued to the end of a link
    // breaks click-to-open in most terminals.
    if (isWildcard(host)) {
        const lan = lanAddress();
        lines.push(`  ${dim('Local:  ')} ${green(`http://localhost:${port}${apiPrefix}`)}`);
        if (lan) lines.push(`  ${dim('Network:')} ${green(`http://${lan}:${port}${apiPrefix}`)}`);
    } else {
        lines.push(`  ${dim('URL:    ')} ${green(`http://${host}:${port}${apiPrefix}`)}`);
        // The failure this prevents: binding to one interface means the loopback
        // address is NOT listening, so `curl http://localhost:PORT` is refused
        // while the LAN address answers — which reads as a firewall problem and
        // is not one.
        if (host !== 'localhost' && host !== '127.0.0.1') {
            lines.push('');
            lines.push(
                `  ${yellow('Note:')} bound to a single interface — ` +
                    `http://localhost:${port} will NOT connect.`
            );
            lines.push(`  ${dim('       Set HOST=0.0.0.0 in .env to listen on both.')}`);
        }
    }

    lines.push('');
    console.log(lines.join('\n'));
};

module.exports = { printBanner, lanAddress, isWildcard };
