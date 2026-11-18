import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server/index.mjs';
import {
  createMediaService,
  isAllowedYoutubeUrl,
  MAX_YOUTUBE_COOKIES_BYTES,
  normalizeYoutubeCookies,
} from '../server/media.mjs';
import { CommandError, createAbortError, HttpError, probeMedia, runCommand, sendFileRange } from '../server/utils.mjs';

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cutline-media-test-'));
  temporaryRoots.push(root);
  return root;
}

async function makeVideo(filePath, options = {}) {
  const duration = options.duration ?? 1.8;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x334455:s=320x180:r=24:d=' + duration,
  ];
  if (options.audio !== false) {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=' + duration);
  }
  args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (options.audio === false) args.push('-an');
  else args.push('-c:a', 'aac', '-shortest');
  args.push('-movflags', '+faststart', filePath);
  await runCommand('ffmpeg', args, { timeoutMs: 30_000 });
}

async function makeAudio(filePath, duration = 1.8) {
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=' + duration,
    '-t', String(duration), '-c:a', 'pcm_s16le', filePath,
  ], { timeoutMs: 30_000 });
}

async function assertCookieTempRemoved(cookiePath) {
  await assert.rejects(stat(cookiePath), (error) => error.code === 'ENOENT');
  await assert.rejects(stat(dirname(cookiePath)), (error) => error.code === 'ENOENT');
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('YouTube cookies accept Netscape files, HttpOnly rows, BOM, and Windows newlines', () => {
  const raw = '\uFEFF# Netscape HTTP Cookie File\r\n'
    + '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-session\r\n'
    + '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-1PSID\tsynthetic-http-only\r\n';
  assert.equal(
    normalizeYoutubeCookies(raw),
    '# Netscape HTTP Cookie File\n'
      + '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-session\n'
      + '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-1PSID\tsynthetic-http-only\n',
  );
  assert.equal(
    normalizeYoutubeCookies('# HTTP Cookie File\nm.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tvalue'),
    '# HTTP Cookie File\nm.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tvalue\n',
  );
  assert.equal(
    normalizeYoutubeCookies('# Netscape HTTP Cookie File\nyoutube.com\tFALSE\t/\tTRUE\t\tSESSION\tvalue'),
    '# Netscape HTTP Cookie File\nyoutube.com\tFALSE\t/\tTRUE\t\tSESSION\tvalue\n',
  );
  assert.equal(
    normalizeYoutubeCookies('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000.5\tSID\tvalue'),
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1893456000.5\tSID\tvalue\n',
  );
});

test('YouTube cookies reject malformed, foreign-host, and oversized input without echoing it', () => {
  for (const value of [
    null,
    '{"cookies":[]}',
    'SID=synthetic-session; PREF=value',
    '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID',
    '# Netscape HTTP Cookie File\n.youtube.com\tMAYBE\t/\tTRUE\t0\tSID\tvalue',
    '# Netscape HTTP Cookie File\nm.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue',
    '# Netscape HTTP Cookie File\n.youtube.com\tFALSE\t/\tTRUE\t0\tSID\tvalue',
    '# Netscape HTTP Cookie File\n#HttpOnly_youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue',
    '# Netscape HTTP Cookie File\n# exported file with no cookies',
  ]) {
    assert.throws(normalizeYoutubeCookies.bind(null, value), (error) => error instanceof HttpError && error.status === 400);
  }

  for (const domain of ['example.com', 'youtube.com.evil.test', 'notyoutube.com']) {
    const foreign = '# Netscape HTTP Cookie File\n'
      + domain + '\tTRUE\t/\tTRUE\t0\tSID\tforeign-secret';
    assert.throws(normalizeYoutubeCookies.bind(null, foreign), (error) => (
      error instanceof HttpError
      && error.status === 400
      && /youtube\.com (?:cookies )?only/i.test(error.message)
      && !error.message.includes('foreign-secret')
    ));
  }

  assert.throws(
    normalizeYoutubeCookies.bind(null, 'x'.repeat(MAX_YOUTUBE_COOKIES_BYTES + 1)),
    (error) => error instanceof HttpError && error.status === 413 && !error.message.includes('x'.repeat(32)),
  );
  assert.throws(
    normalizeYoutubeCookies.bind(null, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\t' + '€'.repeat(MAX_YOUTUBE_COOKIES_BYTES / 2)),
    (error) => error instanceof HttpError && error.status === 413,
  );
});

test('YouTube imports keep cookies private and remove them after success, failure, and abort', async () => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const source = join(root, 'source.mp4');
  const cookieText = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-session\n';
  const normalizedCookies = normalizeYoutubeCookies(cookieText);
  await makeVideo(source);

  let behavior = 'success';
  let abortStarted;
  let abortSeen;
  const abortStartedPromise = new Promise((resolve) => { abortStarted = resolve; });
  const abortSeenPromise = new Promise((resolve) => { abortSeen = resolve; });
  const cookiePaths = [];
  const media = await createMediaService({
    dataDir,
    ytDlpRunner: async (command, args, options) => {
      assert.equal(command, 'yt-dlp');
      const cookiesIndex = args.indexOf('--cookies');
      assert.notEqual(cookiesIndex, -1);
      const cookiePath = args[cookiesIndex + 1];
      cookiePaths.push(cookiePath);
      assert.equal(args.includes('synthetic-session'), false);
      assert.equal(cookiePath.startsWith(join(dataDir, 'tmp') + '/'), false);
      assert.equal((await stat(dirname(cookiePath))).mode & 0o777, 0o700);
      assert.equal((await stat(cookiePath)).mode & 0o777, 0o600);
      assert.equal(await readFile(cookiePath, 'utf8'), normalizedCookies);

      if (behavior === 'failure') {
        throw new CommandError('The downloader failed.', { stderr: 'Sign in to confirm access.' });
      }
      if (behavior === 'timeout') {
        return await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          ...options,
          timeoutMs: 25,
        });
      }
      if (behavior === 'abort') {
        abortStarted();
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            abortSeen();
            reject(createAbortError());
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        });
        return;
      }

      const outputPath = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
      await copyFile(source, outputPath);
      return { stdout: '', stderr: '' };
    },
  });

  const imported = await media.importYoutube('https://youtu.be/jNQXAC9IVRw', { cookies: cookieText });
  assert.equal(imported.name, 'YouTube video jNQXAC9IVRw.mp4');
  await assertCookieTempRemoved(cookiePaths[0]);
  const manifestText = await readFile(join(dataDir, 'media-manifest.json'), 'utf8');
  assert.equal(manifestText.includes('synthetic-session'), false);

  behavior = 'failure';
  await assert.rejects(
    media.importYoutube('https://youtu.be/jNQXAC9IVRw', { cookies: cookieText }),
    (error) => error instanceof HttpError
      && error.status === 422
      && /expired or rejected/i.test(error.message)
      && !error.message.includes('Sign in to confirm'),
  );
  await assertCookieTempRemoved(cookiePaths[1]);

  behavior = 'timeout';
  await assert.rejects(
    media.importYoutube('https://youtu.be/jNQXAC9IVRw', { cookies: cookieText }),
    (error) => error instanceof HttpError
      && error.status === 422
      && error.cause instanceof CommandError
      && error.cause.timedOut
      && !error.message.includes('synthetic-session'),
  );
  await assertCookieTempRemoved(cookiePaths[2]);

  behavior = 'abort';
  const controller = new AbortController();
  const pendingImport = media.importYoutube('https://youtu.be/jNQXAC9IVRw', {
    cookies: cookieText,
    signal: controller.signal,
  });
  await abortStartedPromise;
  controller.abort();
  await assert.rejects(pendingImport, (error) => error.name === 'AbortError');
  await abortSeenPromise;
  await assertCookieTempRemoved(cookiePaths[3]);
});

test('runCommand kills its child when its AbortSignal is triggered', async () => {
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  setTimeout(() => controller.abort(), 25).unref?.();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('media IDs persist across restarts and support byte ranges without exposing paths', async (t) => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const source = join(root, 'source.mp4');
  await makeVideo(source);

  const media = await createMediaService({ dataDir, publicDir });
  const asset = await media.registerUpload(source, '../story.mp4', 'video');
  assert.equal(asset.name, 'story.mp4');
  assert.equal(asset.hasAudio, true);
  assert.ok(asset.duration > 1.5 && asset.duration <= 1.9);
  assert.match(asset.url, new RegExp('^/api/media/' + asset.id + '$'));
  assert.equal(asset.thumbnails.length, 8);
  assert.equal(asset.thumbnail, asset.thumbnails[0]);

  const internal = await media.get(asset.id);
  assert.equal(internal.kind, 'video');
  assert.equal(internal.hasAudio, true);
  assert.ok(internal.path.startsWith(join(dataDir, 'media') + '/'));
  const manifest = JSON.parse(await readFile(join(dataDir, 'media-manifest.json'), 'utf8'));
  assert.equal(manifest.assets[0].id, asset.id);
  assert.equal(Object.hasOwn(manifest.assets[0], 'path'), false);
  await assert.rejects(media.get('../etc/passwd'), (error) => error instanceof HttpError && error.status === 404);
  await assert.rejects(media.get(asset.id + '/../../etc/passwd'), (error) => error instanceof HttpError && error.status === 404);

  const restored = await createMediaService({ dataDir, publicDir });
  assert.deepEqual(restored.publicAsset(await restored.get(asset.id)), asset);
  const restoredAsset = await restored.get(asset.id);

  const server = createServer((req, res) => {
    void sendFileRange(req, res, restoredAsset.path, { contentType: restoredAsset.contentType }).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/media', { headers: { Range: 'bytes=0-127' } });
  assert.equal(response.status, 206);
  assert.match(response.headers.get('content-range'), /^bytes 0-127\/\d+$/);
  assert.equal((await response.arrayBuffer()).byteLength, 128);
  const invalidRange = await fetch('http://127.0.0.1:' + address.port + '/media', { headers: { Range: 'bytes=999999999-' } });
  assert.equal(invalidRange.status, 416);
});

test('unsupported containers become browser-ready MP4 with eight sampled contact thumbnails', async () => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const sourceMp4 = join(root, 'source.mp4');
  const sourceMkv = join(root, 'source.mkv');
  const legacyCodecMp4 = join(root, 'legacy-codec.mp4');
  await makeVideo(sourceMp4);
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', sourceMp4, '-map', '0', '-c', 'copy', '-f', 'matroska', sourceMkv,
  ], { timeoutMs: 30_000 });
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x334455:s=320x180:r=24:d=1.8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.8',
    '-t', '1.8', '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', legacyCodecMp4,
  ], { timeoutMs: 30_000 });
  assert.equal((await probeMedia(legacyCodecMp4)).videoCodec, 'mpeg4');

  const media = await createMediaService({ dataDir, publicDir });
  const asset = await media.registerUpload(sourceMkv, 'mountain trip.mkv', 'video');
  assert.equal(asset.name, 'mountain trip.mp4');
  assert.equal(asset.hasAudio, true);
  assert.equal(asset.thumbnails.length, 8);
  assert.equal(asset.thumbnail, asset.thumbnails[0]);
  const prepared = await media.get(asset.id);
  const probe = await probeMedia(prepared.path);
  assert.equal(prepared.contentType, 'video/mp4');
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  const files = await Promise.all(asset.thumbnails.map(async (_url, index) => {
    const thumbnail = await media.getThumbnail(asset.id, index);
    assert.equal(thumbnail.contentType, 'image/jpeg');
    return await readFile(thumbnail.path);
  }));
  assert.ok(files.every((file) => file.byteLength > 0));
  await assert.rejects(media.getThumbnail(asset.id, 8), (error) => error.status === 404);

  const legacyAsset = await media.registerUpload(legacyCodecMp4, 'legacy-codec.mp4', 'video');
  const legacyVideo = await probeMedia((await media.get(legacyAsset.id)).path);
  assert.equal(legacyVideo.videoCodec, 'h264');
  assert.equal(legacyVideo.audioCodec, 'aac');
});

test('audio registration is persistent and rejects non-audio or oversized files', async () => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const audioPath = join(root, 'music.wav');
  const invalidPath = join(root, 'invalid.txt');
  await makeAudio(audioPath, 1.2);
  await writeFile(invalidPath, 'not a media file');

  const media = await createMediaService({ dataDir, publicDir });
  const audio = await media.registerAudio(audioPath, 'music.wav');
  assert.equal(audio.hasAudio, true);
  assert.equal(audio.width, undefined);
  assert.equal((await media.get(audio.id)).kind, 'audio');
  const restored = await createMediaService({ dataDir, publicDir });
  assert.equal((await restored.get(audio.id)).duration, audio.duration);
  await assert.rejects(media.registerUpload(invalidPath, 'invalid.mp4', 'video'), (error) => error.status === 422);
  await assert.rejects(media.registerAudio(invalidPath, 'invalid.wav'), (error) => error.status === 422);
});

test('the YouTube allowlist accepts only single-video watch and short URLs', () => {
  assert.equal(isAllowedYoutubeUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://m.youtube.com/watch?v=jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://m.youtube.com/watch/?v=jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/shorts/jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/shorts/jNQXAC9IVRw/'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtu.be/jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtu.be/jNQXAC9IVRw/'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/watch?v=jNQXAC9IVRw&list=PL123'), false);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/shorts/jNQXAC9IVRw?LIST=PL123'), false);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/watch?v=jNQXAC9IVRw&v=AAAAAAAAAAA'), false);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com:8443/watch?v=jNQXAC9IVRw'), false);
  assert.equal(isAllowedYoutubeUrl('https://youtube.com.evil.test/watch?v=jNQXAC9IVRw'), false);
  assert.equal(isAllowedYoutubeUrl('file:///etc/passwd'), false);
});

test('media upload API validates content, persists assets, and returns JSON for path traversal', async (t) => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const source = join(root, 'source.mp4');
  const invalid = join(root, 'invalid.mp4');
  const audioSource = join(root, 'audio.wav');
  await mkdir(publicDir, { recursive: true });
  await makeVideo(source);
  await makeAudio(audioSource, 1.2);
  await writeFile(invalid, 'not a video');
  const bundledMedia = join(publicDir, 'media');
  await mkdir(bundledMedia, { recursive: true });
  await copyFile(source, join(bundledMedia, 'demo.mp4'));
  await copyFile(audioSource, join(bundledMedia, 'demo-music.wav'));
  await writeFile(join(publicDir, 'demo.json'), JSON.stringify({
    asset: { id: 'untrusted-id', name: 'Sample video', url: '/stale/path', duration: 9 },
    music: { id: 'untrusted-music', name: 'Quiet mornings', url: '/stale/music.wav' },
    captions: [],
    clips: [],
    heatmap: [],
    thumbnails: ['/media/demo-frame.jpg'],
  }));

  const youtubeCookieText = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic-api-session\n';
  let youtubeBehavior = 'success';
  let youtubeCallCount = 0;
  let resolveYoutubeStarted;
  let resolveYoutubeAborted;
  const youtubeStarted = new Promise((resolve) => { resolveYoutubeStarted = resolve; });
  const youtubeAborted = new Promise((resolve) => { resolveYoutubeAborted = resolve; });
  const youtubeCookiePaths = [];
  const youtubeCookieContents = [];
  const app = await createApp({
    dataDir,
    publicDir,
    useVite: false,
    ytDlpRunner: async (command, args, options) => {
      assert.equal(command, 'yt-dlp');
      youtubeCallCount += 1;
      const cookiesIndex = args.indexOf('--cookies');
      if (cookiesIndex === -1) {
        youtubeCookieContents.push(null);
      } else {
        const cookiePath = args[cookiesIndex + 1];
        youtubeCookiePaths.push(cookiePath);
        youtubeCookieContents.push(await readFile(cookiePath, 'utf8'));
        assert.equal(args.includes('synthetic-api-session'), false);
      }

      if (youtubeBehavior === 'abort') {
        resolveYoutubeStarted();
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            resolveYoutubeAborted();
            reject(createAbortError());
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        });
        return;
      }
      if (youtubeBehavior === 'failure') {
        throw new CommandError('The downloader failed.', { stderr: 'Sign in to confirm access.' });
      }

      const outputPath = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
      await copyFile(source, outputPath);
      return { stdout: '', stderr: '' };
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  });
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  assert.deepEqual(await (await fetch(base + '/api/health')).json(), { status: 'ok' });
  const crossOrigin = await fetch(base + '/api/health', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);

  const demo = await (await fetch(base + '/api/demo')).json();
  assert.equal(demo.asset.id, 'demo');
  assert.equal(demo.asset.url, '/api/media/demo');
  assert.equal(demo.asset.name, 'Sample video');
  assert.deepEqual(demo.captions, []);
  assert.deepEqual(demo.clips, []);
  assert.deepEqual(demo.heatmap, []);
  assert.deepEqual(demo.thumbnails, ['/media/demo-frame.jpg']);
  assert.equal(demo.music.id, 'demo-music');
  assert.equal(demo.music.url, '/api/media/demo-music');
  assert.equal(demo.music.name, 'Quiet mornings');

  const form = new FormData();
  form.append('video', new Blob([await readFile(source)], { type: 'video/mp4' }), 'sample.mp4');
  const uploaded = await fetch(base + '/api/media/upload', { method: 'POST', body: form });
  assert.equal(uploaded.status, 201);
  const { asset } = await uploaded.json();
  assert.equal(asset.thumbnails.length, 8);
  const rangeResponse = await fetch(base + asset.url, { headers: { Range: 'bytes=0-63' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal((await rangeResponse.arrayBuffer()).byteLength, 64);
  const lastThumbnail = await fetch(base + asset.thumbnails[7]);
  assert.equal(lastThumbnail.status, 200);
  assert.match(lastThumbnail.headers.get('content-type'), /image\/jpeg/);
  assert.ok((await lastThumbnail.arrayBuffer()).byteLength > 0);
  const invalidThumbnail = await fetch(base + '/api/media/' + asset.id + '/thumbnails/8');
  assert.equal(invalidThumbnail.status, 404);

  const audioForm = new FormData();
  audioForm.append('audio', new Blob([await readFile(audioSource)], { type: 'audio/wav' }), 'music.wav');
  const audioUpload = await fetch(base + '/api/media/audio', { method: 'POST', body: audioForm });
  assert.equal(audioUpload.status, 201);
  const { asset: audioAsset } = await audioUpload.json();
  assert.equal(audioAsset.hasAudio, true);
  const audioRange = await fetch(base + audioAsset.url, { headers: { Range: 'bytes=0-31' } });
  assert.equal(audioRange.status, 206);
  assert.equal((await audioRange.arrayBuffer()).byteLength, 32);

  const badForm = new FormData();
  badForm.append('video', new Blob([await readFile(invalid)], { type: 'video/mp4' }), 'bad.mp4');
  const rejected = await fetch(base + '/api/media/upload', { method: 'POST', body: badForm });
  assert.equal(rejected.status, 422);
  assert.equal(typeof (await rejected.json()).error, 'string');

  const traversal = await fetch(base + '/api/media/%2e%2e%2fetc%2fpasswd');
  assert.equal(traversal.status, 404);
  assert.match(traversal.headers.get('content-type'), /application\/json/);

  const deniedYoutube = await fetch(base + '/api/media/youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://youtu.be/jNQXAC9IVRw', rightsConfirmed: false }),
  });
  assert.equal(deniedYoutube.status, 400);
  const deniedPlaylist = await fetch(base + '/api/media/youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: 'https://youtube.com/watch?v=jNQXAC9IVRw&list=PL123',
      rightsConfirmed: true,
    }),
  });
  assert.equal(deniedPlaylist.status, 400);

  const postYoutube = (payload, options = {}) => fetch(base + '/api/media/youtube', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...options,
  });
  const headerCookies = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: 'SID=private-cookie-value; Domain=.youtube.com',
  });
  assert.equal(headerCookies.status, 400);
  assert.equal((await headerCookies.json()).error.includes('private-cookie-value'), false);
  const objectCookies = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: { SID: 'private-cookie-value' },
  });
  assert.equal(objectCookies.status, 400);
  assert.match((await objectCookies.json()).error, /Netscape-format cookies\.txt/i);
  const foreignCookies = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: '# Netscape HTTP Cookie File\nexample.com\tTRUE\t/\tTRUE\t0\tSID\tforeign-value',
  });
  assert.equal(foreignCookies.status, 400);
  assert.match((await foreignCookies.json()).error, /youtube\.com (?:cookies )?only/i);
  const oversizedCookies = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: 'x'.repeat(MAX_YOUTUBE_COOKIES_BYTES + 1),
  });
  assert.equal(oversizedCookies.status, 413);
  assert.equal(youtubeCallCount, 0);

  const legacyImport = await postYoutube({ url: 'https://youtu.be/jNQXAC9IVRw', rightsConfirmed: true });
  assert.equal(legacyImport.status, 201);
  assert.equal(youtubeCallCount, 1);
  assert.equal(youtubeCookieContents[0], null);

  const cookieImport = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: youtubeCookieText,
  });
  assert.equal(cookieImport.status, 201);
  assert.equal(youtubeCallCount, 2);
  assert.equal(youtubeCookieContents[1], normalizeYoutubeCookies(youtubeCookieText));
  await assertCookieTempRemoved(youtubeCookiePaths[0]);

  youtubeBehavior = 'failure';
  const failedImport = await postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: youtubeCookieText,
  });
  assert.equal(failedImport.status, 422);
  const failedImportMessage = (await failedImport.json()).error;
  assert.match(failedImportMessage, /expired or rejected/i);
  assert.doesNotMatch(failedImportMessage, /Sign in to confirm|synthetic-api-session/);
  await assertCookieTempRemoved(youtubeCookiePaths[1]);

  youtubeBehavior = 'abort';
  const requestController = new AbortController();
  const disconnectedImport = postYoutube({
    url: 'https://youtu.be/jNQXAC9IVRw',
    rightsConfirmed: true,
    cookies: youtubeCookieText,
  }, { signal: requestController.signal });
  await youtubeStarted;
  requestController.abort();
  await assert.rejects(disconnectedImport, (error) => error.name === 'AbortError');
  await youtubeAborted;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(youtubeCookiePaths[2]);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      assert.equal(error.code, 'ENOENT');
      break;
    }
  }
  await assertCookieTempRemoved(youtubeCookiePaths[2]);
});
