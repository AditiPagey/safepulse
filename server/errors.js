const { ZodError } = require('zod');

const CODES = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
};

class AppError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.status = CODES[code] || 500;
    this.extra = extra;
  }
}

const badRequest = (m, extra) => new AppError('bad_request', m, extra);
const unauthorized = (m = 'unauthorized') => new AppError('unauthorized', m);
const notFound = (m = 'not found') => new AppError('not_found', m);
const conflict = (m, extra) => new AppError('conflict', m, extra);
const unprocessable = (m) => new AppError('unprocessable', m);

// Express error middleware. Contract envelope: {"error":{"code","message"}}
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    const msg = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return res.status(400).json({ error: { code: 'bad_request', message: msg } });
  }
  if (err instanceof AppError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.extra) Object.assign(body.error, err.extra);
    return res.status(err.status).json(body);
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'invalid JSON body' } });
  }
  console.error('unhandled error:', err);
  return res.status(500).json({ error: { code: 'internal', message: 'internal server error' } });
}

module.exports = { AppError, badRequest, unauthorized, notFound, conflict, unprocessable, errorHandler };
