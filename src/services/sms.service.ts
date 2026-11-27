/**
 * Sending text messages. Everything that texts a user goes through `sendSms`,
 * so plugging in a real provider (MSG91, Twilio, Lotte's gateway…) changes
 * this file and the SMS_PROVIDER choices in env.ts only.
 *
 *   log   development: the message, code included, goes to the server log.
 *         Refuses in production, where a log line is not a delivery and
 *         would leave live codes in the logs.
 */

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// Today `log` is the only provider; a real one adds a branch on env.auth.smsProvider.
export function sendSms(mobileno: string, text: string): Promise<void> {
    if (env.isProduction) {
        return Promise.reject(
            new Error(`SMS provider "${env.auth.smsProvider}" cannot send in production.`)
        );
    }
    logger.info(`SMS to ${mobileno}: ${text}`);
    return Promise.resolve();
}
