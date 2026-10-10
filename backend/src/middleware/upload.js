import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { extension, validateFileType } from '../utils/validators.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { setTimeout as delay } from 'node:timers/promises';

async function removeTempFile(filename) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rm(path.resolve(filename), { force: true }); return; }
    catch (error) {
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await delay(50 * (attempt + 1));
    }
  }
}

function uploadError(error) {
  if (/^(?:Multipart: |Unexpected end of (?:form|file)|Malformed part header|Request (?:aborted|closed))/.test(error.message)) {
    return new AppError(400, 'INVALID_UPLOAD', 'The multipart upload is malformed or incomplete.');
  }
  return error;
}

const receive = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename(_req, file, done) { done(null, `cms-upload-${randomUUID()}.${extension(file.originalname)}`); },
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024, parts: 12 },
  fileFilter(_req, file, done) {
    try { validateFileType(file); done(null, true); }
    catch (error) { done(error); }
  },
}).single('file');

/** Receive one media file and always remove its temporary copy after the action finishes. */
export function withUpload(action) {
  return asyncHandler(async (req, res) => {
    try {
      await new Promise((resolve, reject) => receive(req, res, (error) => error ? reject(uploadError(error)) : resolve()));
      if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Provide a media file in the multipart field "file".');
      await action(req, res);
    } finally {
      if (req.file?.path) {
        // Multer removes partial/rejected uploads itself; this covers all service outcomes.
        await removeTempFile(req.file.path).catch((error) => console.error('Temporary upload cleanup failed:', error));
      }
    }
  });
}
