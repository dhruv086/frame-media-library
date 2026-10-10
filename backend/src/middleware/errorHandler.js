import multer from 'multer';
import mongoose from 'mongoose';
import { AppError } from '../utils/AppError.js';

/** Translate all API errors into the shared { error: { code, message } } envelope. */
export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  let apiError = error;
  if (error instanceof multer.MulterError) {
    apiError = error.code === 'LIMIT_FILE_SIZE'
      ? new AppError(413, 'FILE_TOO_LARGE', 'The file exceeds the configured upload size limit.')
      : new AppError(400, 'INVALID_UPLOAD', 'Provide one file in the multipart field "file" and valid form fields.');
  } else if (error instanceof mongoose.Error.CastError) {
    apiError = error.path === '_id'
      ? new AppError(404, 'ASSET_NOT_FOUND', 'Asset not found.')
      : new AppError(400, 'VALIDATION_ERROR', 'An asset field has an invalid value.');
  } else if (error instanceof mongoose.Error.ValidationError) {
    apiError = new AppError(400, 'VALIDATION_ERROR', 'The asset contains invalid or missing fields.');
  } else if (error.code === 11000) {
    apiError = new AppError(409, 'DUPLICATE', 'An asset with this filename already exists in this bucket. Use Replace to update it.');
  } else if (error.type === 'entity.parse.failed') {
    apiError = new AppError(400, 'INVALID_JSON', 'The request body must contain valid JSON.');
  } else if (error.type === 'entity.too.large') {
    apiError = new AppError(413, 'BODY_TOO_LARGE', 'The request body is too large.');
  } else if (!(error instanceof AppError)) {
    console.error('Unhandled request error:', error);
    apiError = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  }
  return res.status(apiError.status).json({ error: { code: apiError.code, message: apiError.message } });
}
