/** Forward rejected asynchronous route handlers to Express error middleware. */
export const asyncHandler = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
