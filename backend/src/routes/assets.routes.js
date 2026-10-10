import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { withUpload } from '../middleware/upload.js';
import * as assets from '../services/asset.service.js';

export const assetsRouter = Router();

assetsRouter.post('/', withUpload(async (req, res) => {
  res.status(201).json(await assets.createAsset(req.body.bucket, req.file));
}));
assetsRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await assets.listAssets(req.query));
}));
assetsRouter.get('/:id/optimized', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').redirect(302, await assets.optimizedAsset(req.params.id, req.query));
}));
assetsRouter.post('/:id/transcode', asyncHandler(async (req, res) => {
  const { status, ...result } = await assets.transcodeAsset(req.params.id, req.body);
  res.status(status).json(result);
}));
assetsRouter.put('/:id/replace', withUpload(async (req, res) => {
  res.json(await assets.replaceAsset(req.params.id, req.file));
}));
assetsRouter.get('/:id', asyncHandler(async (req, res) => {
  res.json(await assets.getAsset(req.params.id));
}));
assetsRouter.patch('/:id', asyncHandler(async (req, res) => {
  res.json(await assets.patchAsset(req.params.id, req.body));
}));
assetsRouter.delete('/:id', asyncHandler(async (req, res) => {
  await assets.deleteAsset(req.params.id);
  res.status(204).end();
}));
