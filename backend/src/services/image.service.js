import sharp from 'sharp';
import { AppError } from '../utils/AppError.js';

// libvips must release temporary input files promptly, including on Windows.
sharp.cache({ files: 0 });

const sharpFormats = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', avif: 'heif' };

/** Inspect image content and reject files whose actual format differs from the extension. */
export async function imageMetadata(input, format) {
  try {
    const metadata = await sharp(input, { failOn: 'error' }).metadata();
    if (metadata.format !== sharpFormats[format] || (format === 'avif' && metadata.compression !== 'av1') || !metadata.width || !metadata.height) throw new Error('Image format does not match the filename.');
    const rotated = [5, 6, 7, 8].includes(metadata.orientation);
    return { width: rotated ? metadata.height : metadata.width, height: rotated ? metadata.width : metadata.height, duration: null };
  } catch (error) {
    throw new AppError(400, 'INVALID_MEDIA', 'The image is corrupt or its content does not match its extension.');
  }
}

/** Generate a 400px-wide WebP thumbnail, applying EXIF orientation. */
export async function imageThumbnail(input) {
  try { return await sharp(input, { failOn: 'error' }).rotate().resize({ width: 400 }).webp({ quality: 75 }).toBuffer(); }
  catch { throw new AppError(400, 'INVALID_MEDIA', 'The image could not be decoded.'); }
}

/** Render an optimized image while preserving aspect ratio within requested bounds. */
export async function optimizeImage(input, { w, h, q, format }) {
  try {
    let pipeline = sharp(input, { failOn: 'error' }).rotate();
    if (w || h) pipeline = pipeline.resize({ width: w, height: h, fit: 'inside' });
    return await pipeline.toFormat(format, { quality: q }).toBuffer();
  } catch { throw new AppError(400, 'INVALID_MEDIA', 'The image could not be optimized.'); }
}
