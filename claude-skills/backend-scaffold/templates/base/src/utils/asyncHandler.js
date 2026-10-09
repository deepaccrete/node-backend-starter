/**
 * Wrap an async route handler so a rejected promise reaches Express.
 *
 * Express 4 does not await handlers: an async function that throws rejects a
 * promise nobody is watching, the request hangs until the client times out, and
 * nothing is logged. Every async handler must therefore either be wrapped here
 * or use an explicit `try/catch (err) { next(err) }`.
 *
 *   router.get('/', asyncHandler(Controller.list));
 *
 * (Express 5 forwards rejections on its own; this becomes optional on upgrade.)
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
