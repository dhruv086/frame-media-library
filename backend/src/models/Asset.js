import mongoose from 'mongoose';

const variantSchema = new mongoose.Schema({
  key: { type: String, required: true },
  url: { type: String, required: true },
  version: { type: Number, required: true },
  status: { type: String, enum: ['queued', 'processing', 'ready', 'failed'], required: true },
  codec: { type: String, enum: ['h264', 'vp9'], required: true },
  format: { type: String, enum: ['mp4', 'webm'], required: true },
  mimeType: { type: String, required: true },
  resolution: Number,
  bitrate: Number,
  crf: Number,
  width: Number,
  height: Number,
  duration: Number,
  size: Number,
  measuredBitrate: Number,
  videoBitrate: Number,
  audioCodec: { type: String, default: null },
  etag: String,
  error: { type: String, default: null },
}, { _id: false });

const assetSchema = new mongoose.Schema({
  bucket: { type: String, required: true },
  key: { type: String, required: true },
  originalName: { type: String, required: true },
  format: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true, min: 0 },
  width: { type: Number, min: 1 },
  height: { type: Number, min: 1 },
  duration: { type: Number, min: 0, default: null },
  videoCodec: { type: String, default: null },
  videoBitrate: { type: Number, default: null },
  audioCodec: { type: String, default: null },
  variants: { type: [variantSchema], default: [] },
  url: { type: String, required: true },
  thumbnailKey: { type: String, required: true },
  thumbnailUrl: { type: String, required: true },
  altText: { type: String, default: '' },
  tags: { type: [String], default: [] },
  expiresAt: { type: Date, default: null },
  version: { type: Number, default: 1, min: 1 },
  etag: { type: String, required: true },
}, {
  timestamps: true,
  toJSON: {
    transform(_doc, result) {
      result.id = result._id.toString();
      delete result._id;
      delete result.__v;
      return result;
    },
  },
});

assetSchema.index({ bucket: 1, key: 1 }, { unique: true });
assetSchema.index({ originalName: 'text' });
assetSchema.index({ createdAt: -1, _id: -1 });

export const Asset = mongoose.model('Asset', assetSchema);
