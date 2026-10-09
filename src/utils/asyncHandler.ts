import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Forward a rejected promise from an async handler to the error handler.
 *
 * Express 5 already does this on its own; the wrapper stays so handlers read the
 * same as in our Express 4 projects and keep working if one is ever moved there.
 *
 *   router.get('/', asyncHandler(Controller.list));
 */
export const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
    (req, res, next) => {
        fn(req, res, next).catch(next);
    };
