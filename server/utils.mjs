import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class CommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CommandError';
    this.code = details.code;
    this.signal = details.signal;
    this.stderr = details.stderr || '';
    this.timedOut = Boolean(details.timedOut);
  }
}

export function isSafeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function sanitizeDisplayName(value, fallback = 'Untitled') {
  let name = String(value ?? '').replace(/\\/g, '/').split('/').pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  name = name.replace(/^\.+/, '').trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (name.length > 120) {
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    name = name.slice(0, Math.max(1, 120 - extension.length)) + extension;
  }
  return name;
}

export async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 1_000_000;
  const maxStderrBytes = options.maxStderrBytes ?? 64_000;

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new CommandError('Could not start the media tool.', { code: error.code }));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutSize = 0;
    let stderrSize = 0;
    let callbackError;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutSize < maxStdoutBytes) {
        const kept = buffer.subarray(0, maxStdoutBytes - stdoutSize);
        stdout = Buffer.concat([stdout, kept]);
        stdoutSize += kept.length;
      }
      if (options.onStdoutData) {
        try {
          options.onStdoutData(buffer);
        } catch (error) {
          callbackError = error;
          child.kill('SIGTERM');
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrSize < maxStderrBytes) {
        const kept = buffer.subarray(0, maxStderrBytes - stderrSize);
        stderr = Buffer.concat([stderr, kept]);
        stderrSize += kept.length;
      }
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError('Could not start the media tool.', { code: error.code }));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errorText = stderr.toString('utf8').slice(-maxStderrBytes);
      if (callbackError) {
        reject(callbackError);
      } else if (timedOut) {
        reject(new CommandError('The media tool took too long to finish.', { code, signal, stderr: errorText, timedOut: true }));
      } else if (code !== 0) {
        reject(new CommandError('The media tool returned an error.', { code, signal, stderr: errorText }));
      } else {
        resolve({ stdout: stdout.toString('utf8'), stderr: errorText });
      }
    });
  });
}

export async function probeMedia(filePath, options = {}) {
  let result;
  try {
    const output = await runCommand('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic',
      '-of', 'json',
      filePath,
    ], { timeoutMs: options.timeoutMs ?? 20_000, maxStdoutBytes: 1_000_000, maxStderrBytes: 8_000 });
    result = JSON.parse(output.stdout);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'The file could not be read as valid audio or video.', { cause: error });
  }

  const streams = Array.isArray(result.streams) ? result.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const durationCandidates = [result.format?.duration, ...streams.map((stream) => stream.duration)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const duration = durationCandidates.length ? Math.max(...durationCandidates) : 0;

  if ((!videoStream && !audioStream) || !Number.isFinite(duration) || duration <= 0) {
    throw new HttpError(422, 'The file does not contain a playable audio or video stream.');
  }

  return {
    duration: Math.round(duration * 1000) / 1000,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    width: Number.isInteger(videoStream?.width) && videoStream.width > 0 ? videoStream.width : undefined,
    height: Number.isInteger(videoStream?.height) && videoStream.height > 0 ? videoStream.height : undefined,
    videoCodec: videoStream?.codec_name,
    audioCodec: audioStream?.codec_name,
    formatName: result.format?.format_name,
  };
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function sendFileRange(req, res, filePath, options = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, 'The requested file was not found.');
    throw error;
  }
  if (!info.isFile()) throw new HttpError(404, 'The requested file was not found.');

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', options.contentType || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Last-Modified', info.mtime.toUTCString());
  res.setHeader('Cache-Control', options.cacheControl || 'private, no-cache');
  if (options.downloadName) {
    const name = sanitizeDisplayName(options.downloadName, 'download');
    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 120);
    res.setHeader('Content-Disposition', 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
  } else {
    res.setHeader('Content-Disposition', 'inline');
  }

  let start = 0;
  let end = info.size - 1;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, info.size);
    if (!range) {
      res.statusCode = 416;
      res.setHeader('Content-Range', 'bytes */' + info.size);
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    ({ start, end } = range);
    res.statusCode = 206;
    res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + info.size);
  } else {
    res.statusCode = 200;
  }

  res.setHeader('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  try {
    await pipeline(createReadStream(filePath, { start, end }), res);
  } catch (error) {
    if (!res.destroyed && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  }
}
