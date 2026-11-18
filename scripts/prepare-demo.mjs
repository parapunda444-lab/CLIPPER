import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const mediaDir = join(publicDir, 'media');
const videoPath = join(mediaDir, 'demo.mp4');
const musicPath = join(mediaDir, 'demo-music.wav');
const maxVideoBytes = 25_000_000;
const musicDuration = 28;
const sampleRate = 44_100;
const transition = 0.65;
const sourceVideos = [
  {
    key: 'alps',
    url: 'https://videos.pexels.com/video-files/34629123/14676379_3840_2160_30fps.mp4',
    creator: 'Oskar Gross',
    page: 'https://www.pexels.com/video/stunning-4k-drone-footage-of-mountain-landscape-34629123/',
  },
  {
    key: 'forest',
    url: 'https://videos.pexels.com/video-files/40950815/17512772_3840_2160_30fps.mp4',
    creator: 'Tom Jurman',
    page: 'https://www.pexels.com/video/drone-aerial-view-over-autumn-forest-canopy-40950815/',
  },
  {
    key: 'hiker',
    url: 'https://videos.pexels.com/video-files/30340210/13005461_3840_2160_30fps.mp4',
    creator: 'Gül Işık',
    page: 'https://www.pexels.com/video/solitary-hiker-in-majestic-mountain-valley-30340210/',
  },
];

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2_000_000) stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(command + ' exited with ' + code + ': ' + stderr.slice(-4000)));
    });
  });
}

async function probe(file) {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(result.stdout);
}

function streamOf(meta, type) {
  return (meta.streams || []).find((stream) => stream.codec_type === type);
}

async function existsWithContent(file, minimumBytes = 1) {
  try {
    return (await stat(file)).size >= minimumBytes;
  } catch {
    return false;
  }
}

async function downloadSource(source, destination) {
  const maxBytes = 300 * 1024 * 1024;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    try {
      const response = await fetch(source.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Cutline-Demo-Asset-Builder/1.0', Accept: 'video/mp4' },
      });
      if (!response.ok || !response.body) {
        throw new Error('Download returned HTTP ' + response.status + ' for ' + source.page);
      }
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'videos.pexels.com') {
        throw new Error('Unexpected download host for ' + source.page);
      }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (contentType !== 'video/mp4') {
        throw new Error('Expected video/mp4 for ' + source.page + ', got ' + (contentType || 'unknown'));
      }
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > maxBytes) {
        throw new Error('Source exceeds the 300 MB safety limit: ' + source.page);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      const actualSize = (await stat(destination)).size;
      if (actualSize < 1_000_000 || actualSize > maxBytes) {
        throw new Error('Downloaded source has an unexpected size: ' + source.page);
      }
      if (declaredSize && actualSize !== declaredSize) {
        throw new Error('Downloaded source size did not match its Content-Length: ' + source.page);
      }
      return;
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function chordAt(notes, time, phaseOffset, channel) {
  let value = 0;
  const base = 0.075 / Math.sqrt(notes.length);
  for (let index = 0; index < notes.length; index += 1) {
    const frequency = notes[index];
    const phase = 2 * Math.PI * frequency * (time + phaseOffset);
    const tone = 0.72 * Math.sin(phase)
      + 0.18 * Math.sin(phase * 1.003 + 0.27)
      + 0.10 * Math.sin(phase * 2 + 0.45);
    const pan = 0.84 + ((index % 3) - 1) * 0.075;
    value += base * tone * (channel === 0 ? pan : 1.68 - pan);
  }
  return value;
}

async function createMusicWav(file) {
  const chords = [
    [73.416, 110.000, 138.591, 184.997],
    [98.000, 146.832, 184.997, 246.942],
    [61.735, 92.499, 123.471, 164.814, 220.000],
    [73.416, 110.000, 164.814, 220.000, 293.665],
  ];
  const barDuration = musicDuration / chords.length;
  const frames = sampleRate * musicDuration;
  const dataBytes = frames * 2 * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const bar = Math.floor(time / barDuration) % chords.length;
    const local = time - Math.floor(time / barDuration) * barDuration;
    const blend = smoothstep((local - (barDuration - 0.9)) / 0.9);
    const next = (bar + 1) % chords.length;
    const swell = 0.94 + 0.06 * Math.sin(2 * Math.PI * local / barDuration);
    for (let channel = 0; channel < 2; channel += 1) {
      const from = chordAt(chords[bar], local, 0, channel);
      const to = chordAt(chords[next], local, -barDuration, channel);
      const value = clamp((from * (1 - blend) + to * blend) * swell, -0.92, 0.92);
      wav.writeInt16LE(Math.round(value * 32767), 44 + (frame * 2 + channel) * 2);
    }
  }
  await writeFile(file, wav);
}

async function ensureMusic() {
  let valid = false;
  if (await existsWithContent(musicPath, 1_000_000)) {
    try {
      const meta = await probe(musicPath);
      const audio = streamOf(meta, 'audio');
      valid = audio?.codec_name === 'pcm_s16le'
        && Math.abs(Number(meta.format.duration) - musicDuration) < 0.02;
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    console.log('Generating original 28-second ambient cue...');
    await createMusicWav(musicPath);
  }
}

async function sourceDuration(sourceFile) {
  const meta = await probe(sourceFile);
  const video = streamOf(meta, 'video');
  const duration = Number(meta.format.duration);
  if (!video || video.width < 1280 || video.height < 720 || !Number.isFinite(duration) || duration < 5) {
    throw new Error('Source video is missing HD picture data: ' + sourceFile);
  }
  return duration;
}

async function encodeVideo(sourceFiles, durations, destination, quality) {
  const fade = transition;
  const firstOffset = durations[0] - fade;
  const secondOffset = durations[0] + durations[1] - 2 * fade;
  const filters = [
    '[0:v]trim=duration=' + durations[0].toFixed(6) + ',setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB[v0]',
    '[1:v]trim=duration=' + durations[1].toFixed(6) + ',setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB[v1]',
    '[2:v]trim=duration=' + durations[2].toFixed(6) + ',setpts=PTS-STARTPTS,fps=30,scale=1280:720:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB[v2]',
    '[v0][v1]xfade=transition=fade:duration=' + fade + ':offset=' + firstOffset.toFixed(6) + ',format=yuv420p,settb=AVTB[v01]',
    '[v01][v2]xfade=transition=fade:duration=' + fade + ':offset=' + secondOffset.toFixed(6) + ',format=yuv420p,settb=AVTB[vout]',
  ].join(';');
  const estimatedDuration = durations.reduce((sum, value) => sum + value, 0) - 2 * fade;
  const fadeOutStart = Math.max(0, estimatedDuration - 3.5).toFixed(6);
  const audioFilter = '[3:a]atrim=duration=' + estimatedDuration.toFixed(6)
    + ',asetpts=PTS-STARTPTS,volume=0.88,afade=t=in:st=0:d=1.5,afade=t=out:st='
    + fadeOutStart + ':d=3.5[aout]';

  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', sourceFiles[0], '-i', sourceFiles[1], '-i', sourceFiles[2],
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex', filters + ';' + audioFilter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(quality.crf),
    '-maxrate', quality.maxrate, '-bufsize', quality.bufsize,
    '-profile:v', 'high', '-level:v', '3.1', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', '-shortest', destination,
  ]);
}

async function buildVideo() {
  console.log('Downloading licensed Pexels source footage...');
  const temporaryDir = await mkdtemp(join(tmpdir(), 'cutline-demo-'));
  const temporaryOutput = videoPath + '.part.mp4';
  try {
    const sourceFiles = [];
    for (const source of sourceVideos) {
      const path = join(temporaryDir, source.key + '.mp4');
      await downloadSource(source, path);
      sourceFiles.push(path);
    }
    const durations = [];
    for (const file of sourceFiles) durations.push(await sourceDuration(file));
    const expected = durations.reduce((sum, value) => sum + value, 0) - 2 * transition;
    if (expected < 90 || expected > 120) {
      throw new Error('The selected stock shots should produce 90-120 seconds, got ' + expected.toFixed(3));
    }

    console.log('Encoding 1280x720 H.264/AAC montage...');
    await rm(temporaryOutput, { force: true });
    await encodeVideo(sourceFiles, durations, temporaryOutput, { crf: 24, maxrate: '1800k', bufsize: '3600k' });
    if ((await stat(temporaryOutput)).size >= maxVideoBytes) {
      console.log('Reducing bitrate to keep the sample under 25 MB...');
      await rm(temporaryOutput, { force: true });
      await encodeVideo(sourceFiles, durations, temporaryOutput, { crf: 26, maxrate: '1450k', bufsize: '2900k' });
    }
    const result = await probe(temporaryOutput);
    const video = streamOf(result, 'video');
    const audio = streamOf(result, 'audio');
    const actualDuration = Number(result.format.duration);
    const size = (await stat(temporaryOutput)).size;
    if (video?.codec_name !== 'h264' || video.width !== 1280 || video.height !== 720
      || audio?.codec_name !== 'aac' || actualDuration < 90 || actualDuration > 120 || size >= maxVideoBytes) {
      throw new Error('Generated demo failed its H.264/AAC, 720p, duration, or 25 MB checks.');
    }
    await rename(temporaryOutput, videoPath);
  } finally {
    await rm(temporaryOutput, { force: true });
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

async function ensureVideo() {
  let valid = false;
  if (await existsWithContent(videoPath, 1_000_000)) {
    try {
      const meta = await probe(videoPath);
      const video = streamOf(meta, 'video');
      const audio = streamOf(meta, 'audio');
      const duration = Number(meta.format.duration);
      valid = video?.codec_name === 'h264' && video.width === 1280 && video.height === 720
        && audio?.codec_name === 'aac' && duration >= 90 && duration <= 120
        && (await stat(videoPath)).size < maxVideoBytes;
    } catch {
      valid = false;
    }
  }
  if (!valid) await buildVideo();
}

async function extractFrame(seconds, destination, width, height, quality = 3) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', seconds.toFixed(3), '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=' + width + ':' + height + ':flags=lanczos,format=yuvj420p',
    '-q:v', String(quality),
    destination,
  ]);
  if (!(await existsWithContent(destination, 512))) {
    throw new Error('Could not create demo still: ' + destination);
  }
}

async function ensureImage(path, seconds, width, height, quality = 3) {
  if (!(await existsWithContent(path, 512))) {
    await extractFrame(seconds, path, width, height, quality);
  }
}

const captionLines = [
  'Some mornings ask only that we arrive.',
  'The first light takes its time.',
  'A narrow path is still a way forward.',
  'Clouds loosen their hold, one ridge at a time.',
  'There is room here for a slower thought.',
  'Below, the forest gathers the light.',
  'Every shade of green has somewhere to go.',
  'The canopy rolls on, soft as a held breath.',
  'Even the farthest edge feels close enough.',
  'A little distance can change the day.',
  'We follow the quiet until it opens.',
  'The mountains keep their own time.',
  'A small figure crosses a very wide world.',
  'The ground rises, and the mind softens.',
  'Keep the moment; leave the hurry behind.',
  'There is still time to breathe.',
];

const heatScores = [
  0.48, 0.52, 0.58, 0.63, 0.71, 0.83, 0.77, 0.74,
  0.80, 0.87, 0.92, 0.88, 0.82, 0.85, 0.90, 0.94,
  0.89, 0.84, 0.79, 0.83, 0.88, 0.93, 0.91, 0.82,
];

const heatReasons = [
  'Gentle opening frame',
  'First wide mountain reveal',
  'Slow cloud movement',
  'Quiet valley detail',
  'Transition toward the tree line',
  'Forest canopy opens',
  'Soft autumn color',
  'Steady aerial movement',
  'A lighter patch in the canopy',
  'Broad forest texture',
  'Strongest scenic reveal',
  'Long, calm sweep',
  'A change in landscape',
  'Open horizon',
  'Return to the mountains',
  'Clear mountain silhouette',
  'A small human detail',
  'Room to let the shot breathe',
  'Late-story transition',
  'Warm closing landscape',
  'Quiet final passage',
  'Wide closing view',
  'Soft landing',
  'Unhurried ending',
];

async function writeDemoJson() {
  const meta = await probe(videoPath);
  const video = streamOf(meta, 'video');
  const duration = Math.round(Number(meta.format.duration) * 1000) / 1000;
  const captions = captionLines.map((text, index) => {
    const start = Math.round((index * 5.82 + 0.35) * 100) / 100;
    return {
      id: 'demo-caption-' + String(index + 1).padStart(2, '0'),
      start,
      end: Math.round(Math.min(duration, start + 4.75) * 100) / 100,
      text,
    };
  });
  const clips = [
    {
      id: 'quiet-open',
      title: 'A little room to breathe',
      description: 'A calm alpine opening that drifts into the forest canopy.',
      start: 8,
      end: 68,
      score: 0.94,
      tags: ['calm', 'mountains', 'forest'],
      poster: '/media/clip-mountain.jpg',
    },
    {
      id: 'forest-canopy',
      title: 'Where the forest opens',
      description: 'A slow aerial passage through warm autumn color.',
      start: 20,
      end: 80,
      score: 0.88,
      tags: ['forest', 'aerial', 'autumn'],
      poster: '/media/clip-canopy.jpg',
    },
    {
      id: 'wide-world',
      title: 'The long way home',
      description: 'A wide landscape with one small traveler in the frame.',
      start: 31.5,
      end: 91.5,
      score: 0.84,
      tags: ['wander', 'quiet', 'valley'],
      poster: '/media/clip-trail.jpg',
    },
  ];
  const heatmap = heatScores.map((score, index) => ({
    start: Math.round((index * duration / heatScores.length) * 100) / 100,
    end: Math.round(((index + 1) * duration / heatScores.length) * 100) / 100,
    score,
    reason: 'Demo example: ' + heatReasons[index],
  }));
  const thumbnails = Array.from({ length: 8 }, (_, index) =>
    '/media/demo-thumb-' + String(index + 1).padStart(2, '0') + '.jpg');
  const demo = {
    asset: {
      id: 'demo-nature-film',
      name: 'A little room to breathe.mp4',
      url: '/media/demo.mp4',
      duration,
      width: video.width,
      height: video.height,
      thumbnail: '/media/demo-poster.jpg',
      hasAudio: Boolean(streamOf(meta, 'audio')),
    },
    captions,
    clips,
    heatmap,
    source: 'demo',
    thumbnails,
    music: {
      id: 'demo-music',
      name: 'Quiet mornings',
      url: '/media/demo-music.wav',
      duration: musicDuration,
      hasAudio: true,
    },
    demoNotes: {
      captions: 'Original illustrative narration, not a transcript of spoken audio.',
      scores: 'Illustrative sample only; not AI analysis or viewer data.',
      audio: 'The video contains a quiet original instrumental bed and no spoken dialogue.',
    },
  };
  await writeFile(join(publicDir, 'demo.json'), JSON.stringify(demo, null, 2) + '\n');
}

async function main() {
  await mkdir(mediaDir, { recursive: true });
  await run('ffmpeg', ['-version']);
  await run('ffprobe', ['-version']);
  await ensureMusic();
  await ensureVideo();

  const stills = [
    ['demo-poster.jpg', 8, 1280, 720, 2],
    ['demo-thumb-01.jpg', 3, 320, 180, 3],
    ['demo-thumb-02.jpg', 15, 320, 180, 3],
    ['demo-thumb-03.jpg', 27, 320, 180, 3],
    ['demo-thumb-04.jpg', 39, 320, 180, 3],
    ['demo-thumb-05.jpg', 51, 320, 180, 3],
    ['demo-thumb-06.jpg', 63, 320, 180, 3],
    ['demo-thumb-07.jpg', 75, 320, 180, 3],
    ['demo-thumb-08.jpg', 87, 320, 180, 3],
    ['clip-mountain.jpg', 16, 640, 360, 2],
    ['clip-canopy.jpg', 50, 640, 360, 2],
    ['clip-trail.jpg', 86, 640, 360, 2],
  ];
  console.log('Preparing poster and timeline stills...');
  for (const [name, seconds, width, height, quality] of stills) {
    await ensureImage(join(mediaDir, name), seconds, width, height, quality);
  }
  await writeDemoJson();
  const meta = await probe(videoPath);
  console.log('Demo ready: ' + Number(meta.format.duration).toFixed(2) + ' seconds, '
    + (await stat(videoPath)).size + ' bytes.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
