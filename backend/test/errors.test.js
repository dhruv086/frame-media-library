import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../src/utils/AppError.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { asyncHandler } from '../src/utils/asyncHandler.js';

const cases = [
  ['explicit API error', new AppError(409, 'DUPLICATE', 'Use Replace.'), 409, 'DUPLICATE'],
  ['oversized file', new multer.MulterError('LIMIT_FILE_SIZE'), 413, 'FILE_TOO_LARGE'],
  ...['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE', 'LIMIT_FIELD_VALUE', 'LIMIT_PART_COUNT'].map((code) => [code, new multer.MulterError(code), 400, 'INVALID_UPLOAD']),
  ['invalid id', new mongoose.Error.CastError('ObjectId', 'bad', '_id'), 404, 'ASSET_NOT_FOUND'],
  ['invalid field', new mongoose.Error.CastError('Number', 'bad', 'size'), 400, 'VALIDATION_ERROR'],
  ['invalid model', new mongoose.Error.ValidationError(), 400, 'VALIDATION_ERROR'],
  ['duplicate index', Object.assign(new Error('private DB detail'), { code: 11000 }), 409, 'DUPLICATE'],
  ['invalid JSON', Object.assign(new Error('private parser detail'), { type: 'entity.parse.failed' }), 400, 'INVALID_JSON'],
  ['large body', Object.assign(new Error('private parser detail'), { type: 'entity.too.large' }), 413, 'BODY_TOO_LARGE'],
  ['unknown error', new Error('secret stack and credentials'), 500, 'INTERNAL_ERROR'],
];
for (const [label, failure, expectedStatus, expectedCode] of cases) test(`error envelope: ${label}`, (t) => {
  t.mock.method(console, 'error', () => {});
  let status;
  let body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
  errorHandler(failure, {}, res, () => assert.fail('unexpected next'));
  assert.equal(status, expectedStatus);
  assert.equal(body.error.code, expectedCode);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(/secret|private|credentials/.test(body.error.message), false);
});

test('errors after headers are sent are delegated', () => {
  const error = new Error('late error');
  errorHandler(error, {}, { headersSent: true }, (value) => assert.equal(value, error));
});

test('async wrapper forwards both sync throws and rejected promises', async () => {
  for (const handler of [() => { throw new Error('sync'); }, async () => { throw new Error('async'); }]) {
    let received;
    await asyncHandler(handler)({}, {}, (error) => { received = error; });
    assert.ok(received instanceof Error);
  }
});
