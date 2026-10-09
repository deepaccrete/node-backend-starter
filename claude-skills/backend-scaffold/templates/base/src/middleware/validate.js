/**
 * Turn express-validator's findings into a response the frontend can attach to
 * individual inputs.
 *
 * Place it AFTER the rules and BEFORE the controller:
 *
 *     router.post('/', body('name').notEmpty(), validate, Controller.create);
 *
 * Declaring rules without this middleware is a silent no-op — express-validator
 * only records what it found, it never rejects the request on its own. If a
 * route "isn't validating", this is almost always the missing piece.
 */

const { validationResult } = require('express-validator');

const { badRequest } = require('../utils/response');

const validate = (req, res, next) => {
    const result = validationResult(req);
    if (result.isEmpty()) return next();

    return badRequest(
        res,
        'Validation failed',
        result.array().map((e) => ({ field: e.path, message: e.msg }))
    );
};

module.exports = validate;
module.exports.validate = validate;
