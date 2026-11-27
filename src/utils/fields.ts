/**
 * Field rules shared by several route files (validation AND the OpenAPI contract).
 * Kept outside `src/routes`, where every file is loaded as a route module.
 */

import { z } from 'zod';

/** Policy (Proposed, confirm with the TL): NIST SP 800-63B minimum, same as create-admin. */
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export const NewPasswordSchema = z
    .string({ error: 'Enter a password' })
    .min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`)
    .max(MAX_PASSWORD, 'Password is too long');

/** A 10-digit Indian mobile number, as the frontend sends it (no +91). */
export const MobileSchema = z
    .string({ error: 'Enter a mobile number' })
    .trim()
    .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number');

export const OtpCodeSchema = z
    .string({ error: 'Enter the code' })
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const UsernameSchema = z
    .string({ error: 'Enter a username' })
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,64}$/, 'Use 3–64 letters, digits, dot, dash or underscore');

export const PersonNameSchema = z
    .string({ error: 'Enter a name' })
    .trim()
    .min(2, 'Enter a name')
    .max(150, 'Name is too long');

/** `:id` in a path: a positive integer key. */
export const IdParamsSchema = z.object({
    id: z.coerce.number({ error: 'Invalid id' }).int('Invalid id').positive('Invalid id'),
});
