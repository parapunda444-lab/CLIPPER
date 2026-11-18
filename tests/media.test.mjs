import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../server/index.mjs';
import { createMediaService, isAllowedYoutubeUrl } from '../server/media.mjs';
import { HttpError, runCommand, sendFileRange } from '../server/utils.mjs';

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

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
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
  assert.equal(isAllowedYoutubeUrl('https://youtube.com/shorts/jNQXAC9IVRw'), true);
  assert.equal(isAllowedYoutubeUrl('https://youtu.be/jNQXAC9IVRw'), true);
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
  }));

  const app = await createApp({ dataDir, publicDir, useVite: false });
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
  assert.equal(demo.music.id, 'demo-music');
  assert.equal(demo.music.url, '/api/media/demo-music');
  assert.equal(demo.music.name, 'Quiet mornings');

  const form = new FormData();
  form.append('video', new Blob([await readFile(source)], { type: 'video/mp4' }), 'sample.mp4');
  const uploaded = await fetch(base + '/api/media/upload', { method: 'POST', body: form });
  assert.equal(uploaded.status, 201);
  const { asset } = await uploaded.json();
  const rangeResponse = await fetch(base + asset.url, { headers: { Range: 'bytes=0-63' } });
  assert.equal(rangeResponse.status, 206);
  assert.equal((await rangeResponse.arrayBuffer()).byteLength, 64);

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
});
