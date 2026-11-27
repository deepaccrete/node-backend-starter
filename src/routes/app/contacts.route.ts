/**
 * Primary Contact Management (Scope of Work, Module 2), for the Android app.
 * Mounted at ${API_PREFIX}/app/contacts by the route loader.
 *
 * Every route needs a signed-in app number; the service then refuses anyone
 * but the distributor's ACTIVE Primary Contact (403). Adding a number starts a
 * two-code verification; see services/contact.service.ts.
 */

import { Router } from 'express';
import { z } from 'zod';

import { ContactsController } from '../../controllers/app/contacts.controller.js';
import { authenticateApp } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { CONTACT_STATUSES } from '../../models/distributor/distributorcontact.model.js';
import {
    envelope,
    errorResponses,
    jsonContent,
    registry,
    requiresAuth,
} from '../../openapi/registry.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
    IdParamsSchema,
    MobileSchema,
    OtpCodeSchema,
    PersonNameSchema,
} from '../../utils/fields.js';

// ─── Field rules ──────────────────────────────────────────────────────

export const ContactSchema = z
    .object({
        id: z.number().int(),
        name: z.string(),
        mobile: z.string(),
        isPrimary: z.boolean(),
        status: z.enum(CONTACT_STATUSES),
        verified: z
            .boolean()
            .meta({ description: 'Step 1 done: the new number entered its code.' }),
        approved: z
            .boolean()
            .meta({ description: 'Step 2 done: the Primary Contact entered theirs.' }),
    })
    .meta({ id: 'Contact' });

export const AddContactBodySchema = z
    .object({ mobile: MobileSchema, name: PersonNameSchema })
    .meta({ id: 'AddContactRequest' });

export type AddContactBody = z.infer<typeof AddContactBodySchema>;

export const ContactCodeBodySchema = z.object({ otp: OtpCodeSchema }).meta({ id: 'ContactCode' });

export type ContactCodeBody = z.infer<typeof ContactCodeBodySchema>;

export const RenameContactBodySchema = z
    .object({ name: PersonNameSchema })
    .meta({ id: 'RenameContactRequest' });

export type RenameContactBody = z.infer<typeof RenameContactBodySchema>;

// ─── Endpoints ────────────────────────────────────────────────────────

const PATH = '/app/contacts';
const router = Router();
router.use(authenticateApp);

const one = (description: string) => ({
    description,
    content: jsonContent(envelope(ContactSchema)),
});
const all = (description: string) => ({
    description,
    content: jsonContent(envelope(z.array(ContactSchema))),
});

router.get('/', asyncHandler(ContactsController.list));
registry.registerPath({
    method: 'get',
    path: PATH,
    tags: ['App contacts'],
    summary: "The distributor's telecaller numbers (Primary Contact only)",
    security: requiresAuth,
    responses: { 200: all('All numbers, primary first'), ...errorResponses(401, 403) },
});

router.post('/', validate({ body: AddContactBodySchema }), asyncHandler(ContactsController.add));
registry.registerPath({
    method: 'post',
    path: PATH,
    tags: ['App contacts'],
    summary: 'Add a number: texts a code to it and a code to the Primary Contact',
    description:
        "The number stays PENDING until both codes are entered (/verify and /approve). Sending one of this distributor's PENDING or INACTIVE numbers again restarts its verification and resends both codes.",
    security: requiresAuth,
    request: { body: { content: jsonContent(AddContactBodySchema) } },
    responses: { 201: one('Added, PENDING'), ...errorResponses(400, 401, 403, 409, 429) },
});

const codeStep = (step: 'verify' | 'approve', summary: string) => {
    router.post(
        `/:id/${step}`,
        validate({ params: IdParamsSchema, body: ContactCodeBodySchema }),
        asyncHandler(ContactsController[step])
    );
    registry.registerPath({
        method: 'post',
        path: `${PATH}/{id}/${step}`,
        tags: ['App contacts'],
        summary,
        description: 'The number turns ACTIVE once both steps are done, in either order.',
        security: requiresAuth,
        request: { params: IdParamsSchema, body: { content: jsonContent(ContactCodeBodySchema) } },
        responses: { 200: one('Step recorded'), ...errorResponses(400, 401, 403, 404) },
    });
};
codeStep('verify', 'Step 1: the code texted to the new number');
codeStep('approve', "Step 2: the code texted to the Primary Contact's own number");

router.patch(
    '/:id',
    validate({ params: IdParamsSchema, body: RenameContactBodySchema }),
    asyncHandler(ContactsController.rename)
);
registry.registerPath({
    method: 'patch',
    path: `${PATH}/{id}`,
    tags: ['App contacts'],
    summary: "Edit a number's name",
    description:
        'The number itself cannot be edited: add the new number and deactivate the old one.',
    security: requiresAuth,
    request: { params: IdParamsSchema, body: { content: jsonContent(RenameContactBodySchema) } },
    responses: { 200: one('Updated'), ...errorResponses(400, 401, 403, 404) },
});

router.post(
    '/:id/deactivate',
    validate({ params: IdParamsSchema }),
    asyncHandler(ContactsController.deactivate)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/{id}/deactivate`,
    tags: ['App contacts'],
    summary: 'Stop a number signing in; ends its app sessions',
    security: requiresAuth,
    request: { params: IdParamsSchema },
    responses: { 200: one('Deactivated'), ...errorResponses(400, 401, 403, 404) },
});

router.post(
    '/:id/make-primary',
    validate({ params: IdParamsSchema }),
    asyncHandler(ContactsController.makePrimary)
);
registry.registerPath({
    method: 'post',
    path: `${PATH}/{id}/make-primary`,
    tags: ['App contacts'],
    summary: 'Hand the Primary Contact role to another active number',
    security: requiresAuth,
    request: { params: IdParamsSchema },
    responses: { 200: all('All numbers after the change'), ...errorResponses(400, 401, 403, 404) },
});

export default { path: PATH, router };
