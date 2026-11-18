import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, HttpError, isSafeId, probeMedia, runCommand, sanitizeDisplayName } from './utils.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
export const MAX_MEDIA_DURATION = 1800;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.3gp']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac']);
const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

function inside(root, candidate) {
  const relativePath = relative(root, candidate);
  const parentPrefix = process.platform === 'win32' ? '..\\' : '../';
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(parentPrefix) && !isAbsolute(relativePath);
}

function extensionFor(name, kind) {
  const extension = extname(name).toLowerCase();
  const allowed = kind === 'video' ? VIDEO_EXTENSIONS : AUDIO_EXTENSIONS;
  if (allowed.has(extension)) return extension;
  return kind === 'video' ? '.mp4' : '.wav';
}

function safeStoredName(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)
    && value !== '.'
    && value !== '..';
}

function parseYoutubeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  const hasPlaylist = [...url.searchParams.keys()].some((key) => key.toLowerCase() === 'list');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || hasPlaylist) return null;
  let videoId;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
    const watchIds = url.searchParams.getAll('v');
    const watchMatch = url.pathname === '/watch'
      && watchIds.length === 1
      && /^[A-Za-z0-9_-]{11}$/.test(watchIds[0]);
    const shortsMatch = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    if (watchMatch) videoId = watchIds[0];
    else if (shortsMatch) videoId = shortsMatch[1];
    else return null;
  } else if (url.hostname === 'youtu.be') {
    const match = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
    if (!match) return null;
    videoId = match[1];
  } else {
    return null;
  }

  url.hash = '';
  return { url: url.toString(), videoId };
}

export function isAllowedYoutubeUrl(value) {
  return Boolean(parseYoutubeUrl(value));
}

export async function createMediaService(options = {}) {
  const dataDir = resolve(options.dataDir ?? join(PROJECT_ROOT, '.data'));
  const publicDir = resolve(options.publicDir ?? join(PROJECT_ROOT, 'public'));
  const mediaDir = join(dataDir, 'media');
  const uploadDir = join(dataDir, 'tmp', 'uploads');
  const publicMediaDir = join(publicDir, 'media');
  const manifestPath = join(dataDir, 'media-manifest.json');

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(mediaDir, { recursive: true, mode: 0o700 }),
    mkdir(uploadDir, { recursive: true, mode: 0o700 }),
    mkdir(publicMediaDir, { recursive: true, mode: 0o755 }),
  ]);
  await Promise.all([chmod(dataDir, 0o700), chmod(mediaDir, 0o700), chmod(uploadDir, 0o700)]);

  const dataRoot = await realpath(mediaDir);
  const publicRoot = await realpath(publicMediaDir);
  const assets = new Map();

  async function resolveStoredPath(storage, fileName) {
    if (!safeStoredName(fileName)) return null;
    const root = storage === 'data' ? mediaDir : storage === 'public' ? publicMediaDir : null;
    const rootReal = storage === 'data' ? dataRoot : storage === 'public' ? publicRoot : null;
    if (!root || !rootReal) return null;
    const candidate = resolve(root, fileName);
    if (!inside(root, candidate)) return null;
    try {
      const actualPath = await realpath(candidate);
      if (!inside(rootReal, actualPath)) return null;
      const info = await stat(actualPath);
      return info.isFile() ? actualPath : null;
    } catch {
      return null;
    }
  }

  function publicAsset(entry) {
    const asset = {
      id: entry.id,
      name: entry.name,
      url: '/api/media/' + encodeURIComponent(entry.id),
      duration: entry.duration,
      hasAudio: entry.hasAudio,
    };
    if (entry.width) asset.width = entry.width;
    if (entry.height) asset.height = entry.height;
    if (entry.thumbnailName) asset.thumbnail = '/api/media/' + encodeURIComponent(entry.id) + '/thumbnail';
    if (entry.publicThumbnailName) asset.thumbnail = '/media/' + encodeURIComponent(entry.publicThumbnailName);
    return asset;
  }

  async function writeManifest() {
    const persisted = [...assets.values()]
      .filter((entry) => entry.storage === 'data')
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        fileName: entry.fileName,
        duration: entry.duration,
        width: entry.width,
        height: entry.height,
        hasAudio: entry.hasAudio,
        thumbnailName: entry.thumbnailName,
      }));
    const tempPath = manifestPath + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tempPath, JSON.stringify({ version: 1, assets: persisted }, null, 2), { mode: 0o600 });
      await rename(tempPath, manifestPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function loadManifest() {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return;
    }
    if (manifest?.version !== 1 || !Array.isArray(manifest.assets)) return;

    for (const stored of manifest.assets) {
      if (!isSafeId(stored?.id) || stored.id === 'demo' || stored.id === 'demo-music') continue;
      if (stored.kind !== 'video' && stored.kind !== 'audio') continue;
      if (!safeStoredName(stored.fileName) || !Number.isFinite(stored.duration) || stored.duration <= 0 || stored.duration > MAX_MEDIA_DURATION) continue;
      const path = await resolveStoredPath('data', stored.fileName);
      if (!path) continue;
      const extension = extname(stored.fileName).toLowerCase();
      const thumbnailName = safeStoredName(stored.thumbnailName) && await resolveStoredPath('data', stored.thumbnailName)
        ? stored.thumbnailName
        : undefined;
      assets.set(stored.id, {
        id: stored.id,
        name: sanitizeDisplayName(stored.name, stored.kind === 'video' ? 'Untitled video' : 'Untitled audio'),
        kind: stored.kind,
        storage: 'data',
        fileName: stored.fileName,
        path,
        duration: Math.round(stored.duration * 1000) / 1000,
        width: Number.isInteger(stored.width) && stored.width > 0 ? stored.width : undefined,
        height: Number.isInteger(stored.height) && stored.height > 0 ? stored.height : undefined,
        hasAudio: Boolean(stored.hasAudio),
        thumbnailName,
        contentType: MIME_TYPES[extension] || 'application/octet-stream',
      });
    }
  }

  await loadManifest();

  async function loadBuiltin(id, fileName, kind, thumbnailName) {
    const path = await resolveStoredPath('public', fileName);
    if (!path) return;
    try {
      const media = await probeMedia(path);
      if (media.duration > MAX_MEDIA_DURATION || (kind === 'video' ? !media.hasVideo : !media.hasAudio || media.hasVideo)) return;
      const publicThumbnailName = thumbnailName && await resolveStoredPath('public', thumbnailName) ? thumbnailName : undefined;
      assets.set(id, {
        id,
        name: kind === 'video' ? 'Demo video' : 'Demo music',
        kind,
        storage: 'public',
        fileName,
        path,
        duration: media.duration,
        width: media.width,
        height: media.height,
        hasAudio: media.hasAudio,
        publicThumbnailName,
        contentType: MIME_TYPES[extname(fileName).toLowerCase()] || 'application/octet-stream',
      });
    } catch {
      // A missing or invalid optional demo asset should not block API startup.
    }
  }

  await loadBuiltin('demo', 'demo.mp4', 'video', 'demo-poster.jpg');
  await loadBuiltin('demo-music', 'demo-music.wav', 'audio');

  async function withWriteLock(operation) {
    let next;
    const prior = withWriteLock.pending;
    next = prior.then(operation, operation);
    withWriteLock.pending = next.catch(() => {});
    return await next;
  }
  withWriteLock.pending = Promise.resolve();

  async function registerFile(sourcePath, originalName, kind, moveSource) {
    if (kind !== 'video' && kind !== 'audio') throw new HttpError(400, 'Choose a supported video or audio file.');
    let sourceInfo;
    try {
      sourceInfo = await stat(sourcePath);
    } catch {
      throw new HttpError(422, 'The uploaded file is no longer available.');
    }
    if (!sourceInfo.isFile() || sourceInfo.size <= 0) throw new HttpError(422, 'The uploaded file is empty or invalid.');
    const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_AUDIO_BYTES;
    if (sourceInfo.size > maxBytes) {
      throw new HttpError(413, kind === 'video' ? 'Videos must be 300 MB or smaller.' : 'Audio files must be 40 MB or smaller.');
    }

    const media = await probeMedia(sourcePath);
    if (kind === 'video' && !media.hasVideo) throw new HttpError(422, 'The file does not contain a video stream.');
    if (kind === 'audio' && (!media.hasAudio || media.hasVideo)) throw new HttpError(422, 'Choose an audio-only file.');
    if (media.duration > MAX_MEDIA_DURATION) throw new HttpError(422, 'Media must be 30 minutes or shorter.');

    const id = randomUUID();
    const name = sanitizeDisplayName(originalName, kind === 'video' ? 'Untitled video' : 'Untitled audio');
    const fileName = id + extensionFor(name, kind);
    const destination = join(mediaDir, fileName);
    const entry = {
      id,
      name,
      kind,
      storage: 'data',
      fileName,
      path: destination,
      duration: media.duration,
      width: media.width,
      height: media.height,
      hasAudio: media.hasAudio,
      contentType: MIME_TYPES[extname(fileName).toLowerCase()] || 'application/octet-stream',
    };

    try {
      if (moveSource) {
        try {
          await rename(sourcePath, destination);
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await copyFile(sourcePath, destination);
          await rm(sourcePath, { force: true });
        }
      } else {
        await copyFile(sourcePath, destination);
      }
      await chmod(destination, 0o600);

      if (kind === 'video') {
        const thumbnailPath = join(mediaDir, id + '.jpg');
        try {
          const seek = Math.min(1, media.duration / 3).toFixed(3);
          await runCommand('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-ss', seek, '-i', destination,
            '-frames:v', '1',
            '-vf', 'scale=480:480:force_original_aspect_ratio=decrease',
            '-q:v', '4', thumbnailPath,
          ], { timeoutMs: 20_000, maxStdoutBytes: 1_000, maxStderrBytes: 2_000 });
          const thumbnailInfo = await stat(thumbnailPath);
          if (thumbnailInfo.size > 0) {
            await chmod(thumbnailPath, 0o600);
            entry.thumbnailName = id + '.jpg';
          }
        } catch {
          await rm(thumbnailPath, { force: true }).catch(() => {});
        }
      }

      await withWriteLock(async () => {
        assets.set(id, entry);
        try {
          await writeManifest();
        } catch (error) {
          assets.delete(id);
          throw error;
        }
      });
      return publicAsset(entry);
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {});
      if (entry.thumbnailName) await rm(join(mediaDir, entry.thumbnailName), { force: true }).catch(() => {});
      throw error;
    }
  }

  async function get(id) {
    if (!isSafeId(id)) throw new HttpError(404, 'Media was not found.');
    const entry = assets.get(id);
    if (!entry) throw new HttpError(404, 'Media was not found.');
    return {
      ...publicAsset(entry),
      path: entry.path,
      kind: entry.kind,
      contentType: entry.contentType,
      hasAudio: entry.hasAudio,
      thumbnailPath: entry.thumbnailName ? join(mediaDir, entry.thumbnailName)
        : entry.publicThumbnailName ? join(publicMediaDir, entry.publicThumbnailName)
          : undefined,
    };
  }

  async function getThumbnail(id) {
    const asset = await get(id);
    if (!asset.thumbnailPath) throw new HttpError(404, 'A thumbnail is not available for this media.');
    return { path: asset.thumbnailPath, contentType: 'image/jpeg' };
  }

  async function registerAudio(sourcePath, name) {
    return await registerFile(sourcePath, name, 'audio', false);
  }

  async function registerVideo(sourcePath, name) {
    return await registerFile(sourcePath, name, 'video', false);
  }

  async function registerUpload(sourcePath, name, kind) {
    return await registerFile(sourcePath, name, kind, true);
  }

  async function importYoutube(value) {
    const parsed = parseYoutubeUrl(value);
    if (!parsed) throw new HttpError(400, 'Use a YouTube watch URL or youtu.be video URL.');
    const workDir = join(uploadDir, 'youtube-' + randomUUID());
    await mkdir(workDir, { recursive: true });
    try {
      await runCommand('yt-dlp', [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--no-call-home',
        '--no-write-info-json',
        '--no-write-thumbnail',
        '--no-write-subs',
        '--no-write-auto-subs',
        '--max-downloads', '1',
        '--max-filesize', '300M',
        '--retries', '1',
        '--fragment-retries', '1',
        '--socket-timeout', '20',
        '--format', 'best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--output', join(workDir, 'source.%(ext)s'),
        parsed.url,
      ], { timeoutMs: 10 * 60_000, maxStdoutBytes: 4_000, maxStderrBytes: 8_000 });

      const files = await readdir(workDir);
      const downloaded = files
        .filter((fileName) => !fileName.endsWith('.part') && !fileName.endsWith('.ytdl'))
        .map((fileName) => join(workDir, fileName));
      if (downloaded.length !== 1) throw new HttpError(422, 'YouTube did not return a downloadable video file.');
      const info = await stat(downloaded[0]);
      if (info.size > MAX_VIDEO_BYTES) throw new HttpError(413, 'Videos must be 300 MB or smaller.');
      return await registerFile(downloaded[0], 'YouTube video ' + parsed.videoId, 'video', true);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof CommandError && error.code === 'ENOENT') {
        throw new HttpError(503, 'YouTube import is unavailable because yt-dlp is not installed.', { cause: error });
      }
      throw new HttpError(422, 'Could not import that video. The URL may be unavailable or restricted by YouTube.', { cause: error });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return {
    dataDir,
    publicDir,
    mediaDir,
    uploadDir,
    get,
    getThumbnail,
    list: () => [...assets.values()].map(publicAsset),
    publicAsset: (assetOrId) => {
      const entry = typeof assetOrId === 'string' ? assets.get(assetOrId) : assets.get(assetOrId?.id);
      return entry ? publicAsset(entry) : null;
    },
    registerAudio,
    registerVideo,
    registerUpload,
    importYoutube,
  };
}
