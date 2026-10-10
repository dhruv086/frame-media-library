import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppError } from '../utils/AppError.js';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobe.path);

const probe = (input) => new Promise((resolve, reject) => ffmpeg.ffprobe(input, (error, result) => error ? reject(error) : resolve(result)));

/** Inspect a video stream with ffprobe and extract its dimensions and duration. */
export async function videoMetadata(input, format) {
  try {
    const metadata = await probe(input);
    const stream = metadata.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const containers = metadata.format.format_name?.split(',') || [];
    const expected = format === 'webm' ? 'webm' : 'mov';
    const duration = Number(metadata.format.duration ?? stream?.duration);
    if (!stream?.width || !stream?.height || !containers.includes(expected) || !Number.isFinite(duration) || duration < 0) throw new Error('Invalid video metadata');
    const rotation = Number(stream.tags?.rotate ?? stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0);
    const rotated = Math.abs(rotation % 180) === 90;
    return { width: rotated ? stream.height : stream.width, height: rotated ? stream.width : stream.height, duration,
      videoCodec: stream.codec_name, videoBitrate: Number(stream.bit_rate) || null,
      audioCodec: metadata.streams.find((item) => item.codec_type === 'audio')?.codec_name || null };
  } catch {
    throw new AppError(400, 'INVALID_MEDIA', 'The video is corrupt, has no video stream, or its container does not match its extension.');
  }
}

/** Encode a bounded H.264/MP4 or VP9/WebM derivative and clean its files after use. */
export async function withTranscodedVideo(input, source, options, consume) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-transcode-'));
  const format = options.codec === 'h264' ? 'mp4' : 'webm';
  const inputPath = path.join(directory, 'original');
  const output = path.join(directory, `optimized.${format}`);
  try {
    await writeFile(inputPath, input);
    const maxWidth = { 480: 854, 720: 1280, 1080: 1920 }[options.resolution];
    if (source.width < 2 || source.height < 2) throw new AppError(400, 'INVALID_MEDIA', 'Video dimensions must be at least 2 pixels.');
    const ratio = Math.min(1, maxWidth / source.width, options.resolution / source.height);
    const width = Math.max(2, Math.floor(source.width * ratio / 2) * 2);
    const height = Math.max(2, Math.floor(source.height * ratio / 2) * 2);
    try {
      await new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath, { timeout: 600 }).videoCodec(options.codec === 'h264' ? 'libx264' : 'libvpx-vp9')
          .videoFilters(`scale=${width}:${height},setsar=1`).audioCodec(options.codec === 'h264' ? 'aac' : 'libopus').audioBitrate('128k')
          .outputOptions(['-map 0:v:0', '-map 0:a:0?', '-map_metadata -1', '-sn', '-dn', '-pix_fmt yuv420p', '-threads 2',
            `-crf ${options.crf}`, `-maxrate ${options.bitrate}k`, `-bufsize ${options.bitrate * 2}k`, '-y']);
        if (options.codec === 'h264') command.outputOptions(['-preset fast', '-movflags +faststart']);
        else command.outputOptions([`-b:v ${options.bitrate}k`, '-deadline good', '-cpu-used 4']);
        command.output(output).on('end', resolve).on('error', reject).run();
      });
    } catch (error) {
      console.error('FFmpeg transcode failed:', error);
      throw new AppError(422, 'TRANSCODE_FAILED', 'The video could not be optimized. Try different settings.');
    }
    const metadata = await videoMetadata(output, format);
    const size = (await stat(output)).size;
    if (metadata.videoCodec !== options.codec) throw new AppError(422, 'TRANSCODE_FAILED', 'The generated codec did not match the request.');
    return await consume({ path: output, ...metadata, size, measuredBitrate: metadata.duration > 0 ? Math.round(size * 8 / metadata.duration) : 0 });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

/** Capture a 400px-wide JPEG at 1 second, or at 0 seconds for a shorter video. */
export async function videoThumbnail(input, duration) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cms-thumb-'));
  const output = path.join(directory, 'thumbnail.jpg');
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(input, { timeout: 120 }).seekInput(duration > 1 ? 1 : 0).videoFilters('scale=400:-2')
        .outputOptions('-frames:v 1').output(output).on('end', resolve).on('error', reject).run();
    });
    return await readFile(output);
  } catch { throw new AppError(400, 'INVALID_MEDIA', 'A thumbnail could not be generated from this video.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
