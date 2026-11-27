/**
 * Primary Contact controller — thin: read the validated request, call one
 * service function, pick a response helper. The service checks the caller is
 * the Primary Contact.
 */

import type { Request, Response } from 'express';
import type { z } from 'zod';

import type {
    AddContactBody,
    ContactCodeBody,
    RenameContactBody,
} from '../../routes/app/contacts.route.js';
import { ContactService } from '../../services/contact.service.js';
import { UnauthorizedError } from '../../utils/errors.js';
import type { IdParamsSchema } from '../../utils/fields.js';
import { created, success } from '../../utils/response.js';

const me = (req: Request) => {
    if (!req.contact) throw new UnauthorizedError();
    return req.contact.id;
};

const idOf = (req: Request) => (req.validated.params as z.infer<typeof IdParamsSchema>).id;

export const ContactsController = {
    list: async (req: Request, res: Response) =>
        success(res, await ContactService.list(me(req)), 'Contact numbers'),

    add: async (req: Request, res: Response) => {
        const body = req.body as AddContactBody;
        return created(
            res,
            await ContactService.add(me(req), body),
            'Codes sent to the new number and to you'
        );
    },

    verify: async (req: Request, res: Response) => {
        const { otp } = req.body as ContactCodeBody;
        return success(
            res,
            await ContactService.verify(me(req), idOf(req), otp),
            'Number verified'
        );
    },

    approve: async (req: Request, res: Response) => {
        const { otp } = req.body as ContactCodeBody;
        return success(
            res,
            await ContactService.approve(me(req), idOf(req), otp),
            'Number approved'
        );
    },

    rename: async (req: Request, res: Response) => {
        const { name } = req.body as RenameContactBody;
        return success(res, await ContactService.rename(me(req), idOf(req), name), 'Updated');
    },

    deactivate: async (req: Request, res: Response) =>
        success(res, await ContactService.deactivate(me(req), idOf(req)), 'Number deactivated'),

    makePrimary: async (req: Request, res: Response) =>
        success(
            res,
            await ContactService.makePrimary(me(req), idOf(req)),
            'Primary Contact changed'
        ),
};
