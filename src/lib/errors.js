// A thrown/passed-to-next() error carrying enough information for the
// centralized error middleware (see app.js) to respond correctly without
// ever having to guess: statusCode is the HTTP status to send, and expose
// controls whether `message` is safe to send to the client verbatim versus
// an unexpected internal error whose real message/stack must stay
// server-side-only.
class AppError extends Error {
  constructor(message, statusCode = 500, { expose = true, code } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.expose = expose;
    this.code = code;
  }
}

AppError.badRequest = (message, code) => new AppError(message, 400, { code });
AppError.unauthorized = (message, code) => new AppError(message, 401, { code });
AppError.forbidden = (message, code) => new AppError(message, 403, { code });
AppError.notFound = (message, code) => new AppError(message, 404, { code });
AppError.conflict = (message, code) => new AppError(message, 409, { code });

// Wraps an async Express route handler so a rejected promise reaches the
// centralized error middleware via next(err) instead of becoming an
// unhandled rejection -- Express 4 does not do this automatically for
// async handlers.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { AppError, asyncHandler };
