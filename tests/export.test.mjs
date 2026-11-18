import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createExportService, createAssSubtitles, createVideoFilter } from '../server/export.mjs';
import { createApp } from '../server/index.mjs';
import { createMediaService } from '../server/media.mjs';
import { runCommand } from '../server/utils.mjs';

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'cutline-export-test-'));
  temporaryRoots.push(root);
  return root;
}

async function makeVideo(filePath, options = {}) {
  const duration = options.duration ?? 2.2;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x426a50:s=320x180:r=24:d=' + duration,
  ];
  if (options.audio !== false) {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000:duration=' + duration);
  }
  args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (options.audio === false) args.push('-an');
  else args.push('-c:a', 'aac', '-shortest');
  args.push('-movflags', '+faststart', filePath);
  await runCommand('ffmpeg', args, { timeoutMs: 30_000 });
}

async function makeAudio(filePath, frequency = 700, duration = 1.7) {
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=' + frequency + ':sample_rate=48000:duration=' + duration,
    '-t', String(duration), '-c:a', 'pcm_s16le', filePath,
  ], { timeoutMs: 30_000 });
}

async function waitForJob(service, id) {
  for (let index = 0; index < 500; index += 1) {
    const job = service.get(id);
    if (job.status === 'complete' || job.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Export job did not finish within the test timeout.');
}

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test('FFmpeg exports trimmed H.264/AAC with crop, effects, captions, callouts, and mixed audio', async () => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const sourcePath = join(root, 'source.mp4');
  const musicPath = join(root, 'music.wav');
  const voicePath = join(root, 'voice.wav');
  await makeVideo(sourcePath);
  await makeAudio(musicPath, 650);
  await makeAudio(voicePath, 920);

  const mediaService = await createMediaService({ dataDir, publicDir });
  const source = await mediaService.registerUpload(sourcePath, 'studio story.mp4', 'video');
  const music = await mediaService.registerAudio(musicPath, 'ambient.wav');
  const voice = await mediaService.registerAudio(voicePath, 'voice.wav');
  const exports = await createExportService({ dataDir, mediaService });
  const job = await exports.create({
    mediaId: source.id,
    start: 0.4,
    end: 1.6,
    aspect: '9:16',
    cropX: 75,
    effect: 'vivid',
    captions: [{ id: 'caption-1', start: 0.1, end: 1.2, text: 'Hello {\\an8} world' }],
    subtitleStyle: 'outline',
    showCaptions: true,
    callout: 'subscribe',
    musicId: music.id,
    musicVolume: 0.2,
    sourceVolume: 0.5,
    voiceId: voice.id,
    voiceVolume: 0.3,
  });
  assert.equal(job.status, 'queued');
  assert.equal(job.progress, 0);
  const result = await waitForJob(exports, job.id);
  assert.equal(result.status, 'complete', result.error);
  assert.equal(result.progress, 100);
  assert.equal(result.aspect, '9:16');
  assert.ok(result.url.startsWith('/api/exports/' + job.id + '/download'));

  const exportedFile = exports.getFile(job.id);
  const probe = await (await import('../server/utils.mjs')).probeMedia(exportedFile.path);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  assert.equal(probe.width, 720);
  assert.equal(probe.height, 1280);
  assert.ok(probe.duration >= 0.85 && probe.duration <= 1.4);

  const subtitles = createAssSubtitles(
    [{ id: 'safe', start: 0, end: 2, text: 'Literal {\\an8} tag' }],
    0,
    2,
    'pop',
    { width: 720, height: 1280 },
  );
  assert.doesNotMatch(subtitles, /Literal \{\\an8\} tag/);
  assert.match(subtitles, /Dialogue: 0,/);
  assert.match(subtitles, /WrapStyle: 0/);
  assert.match(subtitles, /PlayResY: 1280/);
  const popStyle = subtitles.match(/^Style: Default,.*$/m)[0].slice('Style: '.length).split(',');
  assert.equal(popStyle[2], '46');
  assert.equal(popStyle[3], '&H00FFFFFF');
  assert.equal(popStyle[6], '&H59000000');
  assert.equal(popStyle[7], '-1');
  assert.equal(popStyle[15], '3');
  assert.equal(popStyle[21], '166');
  const cleanStyle = createAssSubtitles([], 0, 2, 'clean', { width: 720, height: 1280 })
    .match(/^Style: Default,.*$/m)[0].slice('Style: '.length).split(',');
  assert.equal(cleanStyle[2], '33');
  assert.equal(cleanStyle[6], '&H80000000');
  const outlineStyle = createAssSubtitles([], 0, 2, 'outline', { width: 1280, height: 720 })
    .match(/^Style: Default,.*$/m)[0].slice('Style: '.length).split(',');
  assert.equal(outlineStyle[15], '1');
  assert.equal(outlineStyle[16], '4');
  assert.equal(outlineStyle[21], '94');

  const video = { width: 1280, height: 720 };
  const portrait = { width: 720, height: 1280 };
  const subscribe = createVideoFilter(
    { aspect: '9:16', cropX: 50, effect: 'none', callout: 'subscribe' },
    video,
    portrait,
    false,
  );
  assert.ok(subscribe.includes("text='SUBSCRIBE':fontcolor=white:fontsize=36:box=1:boxcolor=0xD93445@1"));
  assert.ok(subscribe.includes(':x=w*0.07+15:y=h*0.08+15'));
  const like = createVideoFilter(
    { aspect: '9:16', cropX: 50, effect: 'none', callout: 'like' },
    video,
    portrait,
    false,
  );
  assert.ok(like.includes("text='Like this video':fontcolor=0x252820:fontsize=36:box=1:boxcolor=white@1"));
  assert.ok(like.includes(':x=w*0.07+15:y=h*0.08+15'));
  const warmLike = createVideoFilter(
    { aspect: '16:9', cropX: 50, effect: 'warm', callout: 'none' },
    video,
    { width: 1280, height: 720 },
    false,
  );
  assert.ok(warmLike.includes('colorchannelmixer=rr=0.86039:rg=0.17687'));
  assert.ok(warmLike.includes('eq=saturation=1.15'));
  const cinematic = createVideoFilter(
    { aspect: '16:9', cropX: 50, effect: 'cinematic', callout: 'none' },
    video,
    { width: 1280, height: 720 },
    false,
  );
  assert.ok(cinematic.includes('eq=contrast=1.12:saturation=0.82,lutrgb=r=val*0.96:g=val*0.96:b=val*0.96'));
  assert.ok(createVideoFilter(
    { aspect: '16:9', cropX: 50, effect: 'vivid', callout: 'none' },
    video,
    { width: 1280, height: 720 },
    false,
  ).includes('eq=saturation=1.35:contrast=1.06'));
  assert.ok(createVideoFilter(
    { aspect: '16:9', cropX: 50, effect: 'mono', callout: 'none' },
    video,
    { width: 1280, height: 720 },
    false,
  ).includes('hue=s=0'));

  const registeredSource = await mediaService.get(source.id);
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', registeredSource.path,
    '-vf', createVideoFilter(
      { aspect: 'original', cropX: 50, effect: 'warm', callout: 'like' },
      video,
      { width: 320, height: 180 },
      false,
    ),
    '-t', '1', '-an', '-f', 'null', '-',
  ], { timeoutMs: 30_000 });
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', registeredSource.path,
    '-vf', createVideoFilter(
      { aspect: 'original', cropX: 50, effect: 'cinematic', callout: 'none' },
      video,
      { width: 320, height: 180 },
      false,
    ),
    '-t', '1', '-an', '-f', 'null', '-',
  ], { timeoutMs: 30_000 });

  const restored = await createExportService({ dataDir, mediaService });
  assert.equal(restored.get(job.id).status, 'complete');
  assert.equal(restored.list()[0].id, job.id);
  assert.throws(() => restored.get('../etc/passwd'), (error) => error.status === 404);
  assert.throws(() => restored.getFile('missing-export'), (error) => error.status === 404);
});

test('silent source video still exports a valid AAC track, and invalid trims or media IDs are rejected', async () => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const sourcePath = join(root, 'silent.mp4');
  await makeVideo(sourcePath, { audio: false });
  const mediaService = await createMediaService({ dataDir, publicDir });
  const source = await mediaService.registerUpload(sourcePath, 'silent.mp4', 'video');
  assert.equal(source.hasAudio, false);

  const exports = await createExportService({ dataDir, mediaService });
  await assert.rejects(
    exports.create({ mediaId: '../etc/passwd', start: 0, end: 1 }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    exports.create({ mediaId: source.id, start: 0, end: 1, musicId: source.id }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    exports.create({ mediaId: source.id, start: 0, end: source.duration + 1 }),
    (error) => error.status === 400,
  );

  const job = await exports.create({
    mediaId: source.id,
    start: 0.2,
    end: 1.4,
    aspect: 'original',
    cropX: 50,
    effect: 'mono',
    captions: [],
    showCaptions: false,
    callout: 'like',
    musicId: null,
    sourceVolume: 1,
    voiceId: null,
  });
  const result = await waitForJob(exports, job.id);
  assert.equal(result.status, 'complete', result.error);
  const probe = await (await import('../server/utils.mjs')).probeMedia(exports.getFile(job.id).path);
  assert.equal(probe.videoCodec, 'h264');
  assert.equal(probe.audioCodec, 'aac');
  assert.equal(probe.width, 320);
  assert.equal(probe.height, 180);
  assert.ok(probe.duration >= 1 && probe.duration <= 1.4);
});

test('export API queues renders, reports completion, and range-streams persisted MP4 downloads', async (t) => {
  const root = await temporaryRoot();
  const dataDir = join(root, 'data');
  const publicDir = join(root, 'public');
  const sourcePath = join(root, 'api-source.mp4');
  await makeVideo(sourcePath);
  const app = await createApp({ dataDir, publicDir, useVite: false });
  const source = await app.locals.mediaService.registerVideo(sourcePath, 'api story.mp4');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  });
  const base = 'http://127.0.0.1:' + server.address().port;

  const created = await fetch(base + '/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mediaId: source.id,
      start: 0.2,
      end: 1.2,
      aspect: '16:9',
      cropX: 50,
      effect: 'none',
      captions: [],
      showCaptions: false,
      callout: 'none',
    }),
  });
  assert.equal(created.status, 202);
  const queued = await created.json();
  assert.equal(queued.status, 'queued');

  let completed;
  for (let index = 0; index < 500; index += 1) {
    const response = await fetch(base + '/api/exports/' + queued.id);
    completed = await response.json();
    if (completed.status === 'complete' || completed.status === 'error') break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(completed.status, 'complete', completed.error);
  assert.ok((await (await fetch(base + '/api/exports')).json()).exports.some((job) => job.id === queued.id));

  const download = await fetch(base + completed.url, { headers: { Range: 'bytes=0-127' } });
  assert.equal(download.status, 206);
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  assert.equal((await download.arrayBuffer()).byteLength, 128);
  const traversal = await fetch(base + '/api/exports/%2e%2e%2fetc%2fpasswd');
  assert.equal(traversal.status, 404);
  assert.match(traversal.headers.get('content-type'), /application\/json/);
});
