import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { CommandError, HttpError, isSafeId, probeMedia, runCommand, sanitizeDisplayName } from './utils.mjs';

const MAX_QUEUE_SIZE = 20;
const MAX_STORED_EXPORTS = 100;
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 15 * 60_000;

const captionSchema = z.object({
  id: z.string().min(1).max(128),
  start: z.number().finite().min(0).max(1800),
  end: z.number().finite().min(0).max(1800),
  text: z.string().max(2000),
}).strict();

const requestSchema = z.object({
  mediaId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  start: z.number().finite().min(0).max(1800),
  end: z.number().finite().min(0).max(1800),
  aspect: z.enum(['9:16', '16:9', '1:1', 'original']).default('9:16'),
  cropX: z.number().finite().min(0).max(100).default(50),
  effect: z.enum(['none', 'cinematic', 'vivid', 'mono', 'warm']).default('none'),
  captions: z.array(captionSchema).max(2000).default([]),
  subtitleStyle: z.enum(['pop', 'clean', 'outline']).default('pop'),
  showCaptions: z.boolean().default(true),
  callout: z.enum(['none', 'subscribe', 'like']).default('none'),
  musicId: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/).nullable().default(null),
  musicVolume: z.number().finite().min(0).max(1).default(0.3),
  sourceVolume: z.number().finite().min(0).max(1).default(1),
  voiceId: z.string().max(80).regex(/^[A-Za-z0-9_-]+$/).nullable().default(null),
  voiceVolume: z.number().finite().min(0).max(1).default(0.3),
}).strict();

function outputDimensions(aspect, source) {
  if (aspect === '9:16') return { width: 720, height: 1280 };
  if (aspect === '16:9') return { width: 1280, height: 720 };
  if (aspect === '1:1') return { width: 720, height: 720 };
  const width = source.width || 1280;
  const height = source.height || 720;
  const scale = Math.min(1, 1080 / width, 1080 / height);
  return {
    width: Math.max(2, Math.floor(width * scale / 2) * 2),
    height: Math.max(2, Math.floor(height * scale / 2) * 2),
  };
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const wholeSeconds = Math.floor(centiseconds / 100) % 60;
  const fraction = centiseconds % 100;
  return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(wholeSeconds).padStart(2, '0') + '.' + String(fraction).padStart(2, '0');
}

export function escapeAssText(value) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/{/g, '\\{')
    .replace(/}/g, '\\}')
    .replace(/\n/g, '\\N');
}

export function createAssSubtitles(captions, clipStart, clipEnd, style, dimensions) {
  const horizontalMargin = Math.round(dimensions.width * 0.08);
  const bottomMargin = Math.round(dimensions.height * 0.13);
  const baseFontSize = Math.round(Math.min(dimensions.width, 720) * 0.064);
  const styleOptions = {
    pop: { fontSize: baseFontSize, bold: -1, outline: 16, shadow: 0, border: 3, back: '&H59000000' },
    clean: { fontSize: Math.round(baseFontSize * 0.72), bold: 0, outline: 12, shadow: 0, border: 3, back: '&H80000000' },
    outline: { fontSize: Math.round(baseFontSize * 0.9), bold: -1, outline: 4, shadow: 0, border: 1, back: '&HFF000000' },
  }[style] || { fontSize: baseFontSize, bold: -1, outline: 16, shadow: 0, border: 3, back: '&H59000000' };

  const lines = [
    '[Script Info]',
    'Title: Cutline export',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'PlayResX: ' + dimensions.width,
    'PlayResY: ' + dimensions.height,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Default,DejaVu Sans,' + styleOptions.fontSize + ',&H00FFFFFF,&H000000FF,&H00000000,' + styleOptions.back + ',' + styleOptions.bold + ',0,0,0,100,100,0,0,' + styleOptions.border + ',' + styleOptions.outline + ',' + styleOptions.shadow + ',2,' + horizontalMargin + ',' + horizontalMargin + ',' + bottomMargin + ',1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];

  const clipped = captions
    .filter((caption) => caption.end > clipStart && caption.start < clipEnd)
    .map((caption) => ({
      start: Math.max(caption.start, clipStart) - clipStart,
      end: Math.min(caption.end, clipEnd) - clipStart,
      text: escapeAssText(caption.text),
    }))
    .filter((caption) => caption.end > caption.start)
    .sort((left, right) => left.start - right.start);

  for (const caption of clipped) {
    lines.push('Dialogue: 0,' + assTime(caption.start) + ',' + assTime(caption.end) + ',Default,,' + horizontalMargin + ',' + horizontalMargin + ',' + bottomMargin + ',,' + caption.text);
  }
  return lines.join('\n') + '\n';
}

function effectFilter(effect) {
  const filters = {
    none: [],
    cinematic: ['eq=contrast=1.12:saturation=0.82:brightness=-0.02'],
    vivid: ['eq=saturation=1.35:contrast=1.06'],
    mono: ['hue=s=0'],
    warm: [
      'colorchannelmixer=rr=0.86139:rg=0.17687:rb=0.04347:gr=0.08027:gg=0.92778:gb=0.03864:br=0.06256:bg=0.12282:bb=0.80013',
      'eq=saturation=1.15',
    ],
  };
  return filters[effect] || [];
}

export function createVideoFilter(request, source, dimensions, hasCaptions) {
  const filters = [];
  if (request.aspect === 'original') {
    filters.push('scale=' + dimensions.width + ':' + dimensions.height + ':force_original_aspect_ratio=decrease:force_divisible_by=2');
  } else {
    filters.push('scale=' + dimensions.width + ':' + dimensions.height + ':force_original_aspect_ratio=increase:force_divisible_by=2');
    filters.push('crop=' + dimensions.width + ':' + dimensions.height + ':x=(iw-ow)*' + (request.cropX / 100).toFixed(4) + ':y=(ih-oh)/2');
  }
  filters.push(...effectFilter(request.effect));
  if (hasCaptions) filters.push('subtitles=filename=captions.ass');
  if (request.callout !== 'none') {
    const subscribe = request.callout === 'subscribe';
    const text = subscribe ? 'SUBSCRIBE' : 'Like this video';
    const color = subscribe ? 'white' : '0x252820';
    const box = subscribe ? '0xD93445@1' : 'white@1';
    const fontSize = Math.round(Math.min(dimensions.width, 720) * 0.05);
    const padding = Math.round(fontSize * 0.42);
    filters.push(
      "drawtext=font='DejaVu Sans':text='" + text + "':fontcolor=" + color
      + ':fontsize=' + fontSize + ':box=1:boxcolor=' + box + ':boxborderw=' + padding
      + ':x=w*0.07:y=h*0.08',
    );
  }
  return filters.join(',');
}

function timeFromProgress(line) {
  if (line.startsWith('out_time_us=') || line.startsWith('out_time_ms=')) {
    const value = Number(line.slice(line.indexOf('=') + 1));
    return Number.isFinite(value) ? value / 1_000_000 : null;
  }
  if (line.startsWith('out_time=')) {
    const value = line.slice('out_time='.length);
    const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

function publicJob(job) {
  const result = {
    id: job.id,
    status: job.status,
    progress: Math.max(0, Math.min(100, Math.round(job.progress))),
  };
  if (job.status === 'complete') result.url = '/api/exports/' + job.id + '/download';
  if (job.error) result.error = job.error;
  if (job.name) result.name = job.name;
  if (job.createdAt) result.createdAt = job.createdAt;
  if (Number.isFinite(job.duration)) result.duration = job.duration;
  if (job.aspect) result.aspect = job.aspect;
  return result;
}

export async function createExportService(options = {}) {
  if (!options.mediaService || typeof options.mediaService.get !== 'function') {
    throw new TypeError('createExportService requires a mediaService.');
  }
  const dataDir = resolve(options.dataDir ?? options.mediaService.dataDir ?? '.data');
  const exportDir = join(dataDir, 'exports');
  const workDir = join(dataDir, 'tmp', 'exports');
  const manifestPath = join(exportDir, 'manifest.json');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    mkdir(exportDir, { recursive: true, mode: 0o700 }),
    mkdir(workDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([chmod(dataDir, 0o700), chmod(exportDir, 0o700), chmod(workDir, 0o700)]);

  const jobs = new Map();
  const queue = [];
  let running = false;
  let activeJobs = 0;
  let drainScheduled = false;

  async function persistCompleted(completingJob) {
    const completed = [...jobs.values()]
      .filter((job) => job.status === 'complete' || job.id === completingJob?.id)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, MAX_STORED_EXPORTS)
      .map((job) => ({
        id: job.id,
        status: 'complete',
        progress: 100,
        name: job.name,
        createdAt: job.createdAt,
        duration: job.duration,
        aspect: job.aspect,
      }));
    const tempPath = manifestPath + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(tempPath, JSON.stringify({ version: 1, exports: completed }, null, 2), { mode: 0o600 });
      await rename(tempPath, manifestPath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }

    const retained = new Set(completed.map((job) => job.id));
    for (const job of jobs.values()) {
      if (job.status === 'complete' && !retained.has(job.id)) {
        await rm(job.outputPath, { force: true }).catch(() => {});
        jobs.delete(job.id);
      }
    }
  }

  async function restoreCompleted() {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      return;
    }
    if (manifest?.version !== 1 || !Array.isArray(manifest.exports)) return;
    for (const stored of manifest.exports) {
      if (!isSafeId(stored?.id) || stored.status !== 'complete' || !Number.isFinite(stored.duration)) continue;
      const outputPath = join(exportDir, stored.id + '.mp4');
      try {
        const info = await stat(outputPath);
        if (!info.isFile() || info.size <= 0) continue;
      } catch {
        continue;
      }
      const job = {
        id: stored.id,
        status: 'complete',
        progress: 100,
        name: sanitizeDisplayName(stored.name, 'Cutline export.mp4'),
        createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date(0).toISOString(),
        duration: Math.max(0, Math.min(180, stored.duration)),
        aspect: ['9:16', '16:9', '1:1', 'original'].includes(stored.aspect) ? stored.aspect : 'original',
        outputPath,
      };
      jobs.set(job.id, job);
    }
  }

  await restoreCompleted();

  async function render(job) {
    const temporaryDir = join(workDir, 'export-' + job.id);
    const temporaryOutput = join(temporaryDir, 'result.mp4');
    let outputPath;

    try {
      await mkdir(temporaryDir, { recursive: true });
      const source = await options.mediaService.get(job.request.mediaId);
      const music = job.request.musicId ? await options.mediaService.get(job.request.musicId) : null;
      const voice = job.request.voiceId ? await options.mediaService.get(job.request.voiceId) : null;
      const dimensions = outputDimensions(job.request.aspect, source);
      const clippedCaptions = job.request.showCaptions
        ? job.request.captions.filter((caption) => caption.end > job.request.start && caption.start < job.request.end)
        : [];
      if (clippedCaptions.length) {
        await writeFile(join(temporaryDir, 'captions.ass'), createAssSubtitles(
          clippedCaptions,
          job.request.start,
          job.request.end,
          job.request.subtitleStyle,
          dimensions,
        ), { mode: 0o600 });
      }

      const duration = job.duration;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-progress', 'pipe:1',
        '-stats_period', '0.5',
        '-ss', job.request.start.toFixed(3),
        '-i', source.path,
      ];
      let nextInput = 1;
      let musicIndex;
      let voiceIndex;
      if (music) {
        musicIndex = nextInput++;
        args.push('-stream_loop', '-1', '-i', music.path);
      }
      if (voice) {
        voiceIndex = nextInput++;
        args.push('-i', voice.path);
      }

      const audioFilters = [];
      if (source.hasAudio) {
        audioFilters.push('[0:a:0]atrim=duration=' + duration.toFixed(3) + ',asetpts=PTS-STARTPTS,volume=' + job.request.sourceVolume.toFixed(3) + '[src]');
      }
      if (music) {
        audioFilters.push('[' + musicIndex + ':a:0]atrim=duration=' + duration.toFixed(3) + ',asetpts=PTS-STARTPTS,volume=' + job.request.musicVolume.toFixed(3) + '[music]');
      }
      if (voice) {
        audioFilters.push('[' + voiceIndex + ':a:0]atrim=duration=' + duration.toFixed(3) + ',asetpts=PTS-STARTPTS,volume=' + job.request.voiceVolume.toFixed(3) + '[voice]');
      }
      if (!audioFilters.length) {
        const silenceIndex = nextInput++;
        args.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        audioFilters.push('[' + silenceIndex + ':a:0]atrim=duration=' + duration.toFixed(3) + ',asetpts=PTS-STARTPTS[silence]');
      }

      const audioLabels = [];
      if (source.hasAudio) audioLabels.push('[src]');
      if (music) audioLabels.push('[music]');
      if (voice) audioLabels.push('[voice]');
      if (!audioLabels.length) audioLabels.push('[silence]');
      if (audioLabels.length > 1) {
        audioFilters.push(audioLabels.join('') + 'amix=inputs=' + audioLabels.length + ':duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
      } else {
        audioFilters.push(audioLabels[0] + 'alimiter=limit=0.95[aout]');
      }

      const hasCaptions = clippedCaptions.length > 0;
      const videoFilter = createVideoFilter(job.request, source, dimensions, hasCaptions);
      const graph = audioFilters.join(';');
      const finalOutput = join(exportDir, job.id + '.mp4');
      outputPath = finalOutput;
      args.push(
        '-filter_complex', graph,
        '-map', '0:v:0',
        '-map', '[aout]',
        '-vf', videoFilter,
        '-t', duration.toFixed(3),
        '-r', '30',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        '-max_muxing_queue_size', '1024',
        '-f', 'mp4',
        temporaryOutput,
      );

      let progressLine = '';
      await runCommand('ffmpeg', args, {
        cwd: temporaryDir,
        timeoutMs: EXPORT_TIMEOUT_MS,
        maxStdoutBytes: 1_000_000,
        maxStderrBytes: 24_000,
        onStdoutData: (chunk) => {
          progressLine += chunk.toString('utf8');
          const lines = progressLine.split(/\r?\n/);
          progressLine = lines.pop() || '';
          for (const line of lines) {
            const seconds = timeFromProgress(line);
            if (seconds === null) continue;
            const percentage = 3 + seconds / duration * 92;
            job.progress = Math.max(job.progress, Math.min(96, Math.round(percentage)));
          }
        },
      });

      const outputInfo = await stat(temporaryOutput);
      if (outputInfo.size <= 0 || outputInfo.size > MAX_EXPORT_BYTES) {
        throw new HttpError(422, 'The rendered export is empty or exceeds the file size limit.');
      }
      await chmod(temporaryOutput, 0o600);
      const rendered = await probeMedia(temporaryOutput, { timeoutMs: 30_000 });
      if (!rendered.hasVideo || !rendered.hasAudio || rendered.videoCodec !== 'h264' || rendered.audioCodec !== 'aac') {
        throw new HttpError(422, 'The export did not contain the expected H.264 video and AAC audio.');
      }
      if (rendered.width !== dimensions.width || rendered.height !== dimensions.height) {
        throw new HttpError(422, 'The rendered export dimensions did not match the selected aspect ratio.');
      }
      if (rendered.duration < Math.max(0.1, duration - 0.35) || rendered.duration > duration + 0.35) {
        throw new HttpError(422, 'The rendered export duration did not match the selected trim.');
      }

      await rename(temporaryOutput, finalOutput);
      job.outputPath = finalOutput;
      job.progress = 98;
      job.updatedAt = Date.now();
      await persistCompleted(job);
      job.progress = 100;
      job.status = 'complete';
    } catch (error) {
      if (outputPath) await rm(outputPath, { force: true }).catch(() => {});
      job.status = 'error';
      job.progress = Math.min(job.progress, 99);
      job.error = error instanceof HttpError
        ? error.message
        : error instanceof CommandError && error.code === 'ENOENT'
          ? 'FFmpeg is not available on this server.'
          : error instanceof CommandError
            ? 'FFmpeg could not render this export. Check the source media and settings.'
            : 'The export could not be completed.';
      job.updatedAt = Date.now();
    } finally {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      void drain();
    });
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        activeJobs = 1;
        job.status = 'processing';
        job.progress = Math.max(job.progress, 1);
        job.updatedAt = Date.now();
        await render(job);
        activeJobs = 0;
      }
    } finally {
      activeJobs = 0;
      running = false;
      if (queue.length) scheduleDrain();
    }
  }

  async function create(input) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message || 'The export settings are invalid.');
    const request = parsed.data;
    for (const caption of request.captions) {
      if (caption.end <= caption.start) throw new HttpError(400, 'Every caption must end after it starts.');
    }

    if (queue.length + activeJobs >= MAX_QUEUE_SIZE) {
      throw new HttpError(429, 'The export queue is full. Try again when a render finishes.');
    }
    const source = await options.mediaService.get(request.mediaId);
    if (source.kind !== 'video') throw new HttpError(400, 'Exports need a registered video asset.');
    if (request.start >= source.duration || request.end > source.duration + 0.1) {
      throw new HttpError(400, 'The selected trim must be inside the source video.');
    }
    const effectiveEnd = Math.min(request.end, source.duration);
    const duration = effectiveEnd - request.start;
    if (duration < 0.25 || duration > 180) {
      throw new HttpError(400, 'Choose a clip between 0.25 and 180 seconds long.');
    }

    if (request.musicId) {
      const music = await options.mediaService.get(request.musicId);
      if (music.kind !== 'audio') throw new HttpError(400, 'Background music must be a registered audio asset.');
    }
    if (request.voiceId) {
      const voice = await options.mediaService.get(request.voiceId);
      if (voice.kind !== 'audio') throw new HttpError(400, 'Voiceover must be a registered audio asset.');
    }

    const id = randomUUID();
    const sourceName = basename(source.name).replace(/\.[^.]+$/, '');
    const job = {
      id,
      status: 'queued',
      progress: 0,
      name: sanitizeDisplayName((sourceName || 'Cutline') + ' clip.mp4', 'Cutline export.mp4'),
      createdAt: new Date().toISOString(),
      duration: Math.round(duration * 1000) / 1000,
      aspect: request.aspect,
      request: { ...request, end: effectiveEnd },
      outputPath: join(exportDir, id + '.mp4'),
    };
    jobs.set(id, job);
    queue.push(job);
    scheduleDrain();
    return publicJob(job);
  }

  function get(id) {
    if (!isSafeId(id)) throw new HttpError(404, 'Export was not found.');
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'Export was not found.');
    return publicJob(job);
  }

  function getFile(id) {
    if (!isSafeId(id)) throw new HttpError(404, 'Export was not found.');
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, 'Export was not found.');
    if (job.status !== 'complete') throw new HttpError(409, 'This export is not ready to download.');
    return { path: job.outputPath, name: job.name };
  }

  function list() {
    return [...jobs.values()]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map(publicJob);
  }

  return { create, get, getFile, list };
}
