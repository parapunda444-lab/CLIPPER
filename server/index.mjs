import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { z } from 'zod';
import { createAIRouter } from './ai.mjs';
import { createExportService } from './export.mjs';
import { createMediaService, MAX_AUDIO_BYTES, MAX_VIDEO_BYTES } from './media.mjs';
import { HttpError, sendFileRange } from './utils.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const youtubeBodySchema = z.object({
  url: z.string().min(1).max(2048),
  cookies: z.string().optional(),
});

function mergeDemoAsset(metadata, registered) {
  const result = { ...registered, ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}) };
  result.id = registered.id;
  result.url = registered.url;
  result.duration = registered.duration;
  result.hasAudio = registered.hasAudio;
  if (registered.width !== undefined) result.width = registered.width;
  else delete result.width;
  if (registered.height !== undefined) result.height = registered.height;
  else delete result.height;
  return result;
}

function sendApiError(error, req, res, next) {
  if (res.headersSent) return next(error);
  let status = error instanceof HttpError ? error.status : Number(error.status);
  let message = error instanceof HttpError ? error.message : '';

  if (error instanceof multer.MulterError) {
    status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    if (error.code === 'LIMIT_FILE_SIZE') {
      message = req.path === '/media/audio' ? 'Audio files must be 40 MB or smaller.' : 'Videos must be 300 MB or smaller.';
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Use the expected upload field for this media type.';
    } else {
      message = 'The multipart upload could not be read.';
    }
  }

  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  if (!message) {
    if (status === 400) message = error.type === 'entity.parse.failed' ? 'The JSON request is invalid.' : 'The request is invalid.';
    else if (status === 413) message = 'The request is too large.';
    else message = 'The server could not complete this request.';
  }
  res.status(status).json({ error: message });
}

function guardSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
  }

  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  const protocol = forwardedProtocol || req.protocol;
  let expectedOrigin;
  try {
    expectedOrigin = new URL(protocol + '://' + host).origin;
  } catch {
    return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
  }
  if (!host || parsed.origin !== expectedOrigin) {
    return res.status(403).json({ error: 'Cross-origin API requests are not allowed.' });
  }
  next();
}

export async function createApp(options = {}) {
  const dataDir = resolve(options.dataDir ?? join(PROJECT_ROOT, '.data'));
  const publicDir = resolve(options.publicDir ?? join(PROJECT_ROOT, 'public'));
  const distDir = resolve(options.distDir ?? join(PROJECT_ROOT, 'dist'));
  const useVite = options.useVite ?? process.env.NODE_ENV !== 'production';
  const mediaService = await createMediaService({ dataDir, publicDir, ytDlpRunner: options.ytDlpRunner });
  const exportService = await createExportService({ dataDir, mediaService });
  const app = express();

  app.disable('x-powered-by');
  app.locals.mediaService = mediaService;
  app.locals.exportService = exportService;
  app.use('/api', guardSameOrigin);
  app.use(express.json({ limit: '8mb', strict: true }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/demo', async (_req, res, next) => {
    try {
      let demo;
      try {
        demo = JSON.parse(await readFile(join(publicDir, 'demo.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(404, 'The demo project is not available yet.');
        if (error instanceof SyntaxError) throw new HttpError(500, 'The demo project data is invalid.');
        throw error;
      }
      if (!demo || typeof demo !== 'object' || Array.isArray(demo)) {
        throw new HttpError(500, 'The demo project data is invalid.');
      }
      const registeredDemo = await mediaService.get('demo');
      const response = { ...demo, asset: mergeDemoAsset(demo.asset, mediaService.publicAsset(registeredDemo)) };
      try {
        const registeredMusic = await mediaService.get('demo-music');
        response.music = mergeDemoAsset(demo.music, mediaService.publicAsset(registeredMusic));
      } catch {
        // Demo projects may be shipped without bundled music.
        delete response.music;
      }
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, mediaService.uploadDir),
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  });
  const videoUpload = multer({
    storage,
    limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 4, parts: 5 },
  });
  const audioUpload = multer({
    storage,
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 4, parts: 5 },
  });

  async function handleUpload(kind, req, res, next) {
    try {
      if (!req.file) throw new HttpError(400, 'Choose a ' + kind + ' file to upload.');
      const asset = await mediaService.registerUpload(req.file.path, req.file.originalname, kind);
      res.status(201).json({ asset });
    } catch (error) {
      next(error);
    } finally {
      if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    }
  }

  app.post('/api/media/upload', videoUpload.single('video'), (req, res, next) => {
    void handleUpload('video', req, res, next);
  });
  app.post('/api/media/audio', audioUpload.single('audio'), (req, res, next) => {
    void handleUpload('audio', req, res, next);
  });

  app.post('/api/media/youtube', async (req, res, next) => {
    const controller = new AbortController();
    const abortRequest = () => controller.abort();
    const abortOnResponseClose = () => {
      if (!res.writableEnded) abortRequest();
    };
    req.once('aborted', abortRequest);
    res.once('close', abortOnResponseClose);
    try {
      if (req.body?.rightsConfirmed !== true) {
        throw new HttpError(400, 'Confirm that you have the rights to use this video.');
      }
      const parsed = youtubeBodySchema.safeParse({ url: req.body?.url, cookies: req.body?.cookies });
      if (!parsed.success) throw new HttpError(400, 'Provide a single-video YouTube watch, Shorts, or youtu.be URL.');
      const asset = await mediaService.importYoutube(parsed.data.url, {
        cookies: parsed.data.cookies,
        signal: controller.signal,
      });
      if (!controller.signal.aborted && !res.destroyed) res.status(201).json({ asset });
    } catch (error) {
      if (!controller.signal.aborted) next(error);
    } finally {
      req.removeListener('aborted', abortRequest);
      res.removeListener('close', abortOnResponseClose);
    }
  });

  app.get('/api/media/:id/thumbnail', async (req, res, next) => {
    try {
      const thumbnail = await mediaService.getThumbnail(req.params.id);
      await sendFileRange(req, res, thumbnail.path, { contentType: thumbnail.contentType });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/media/:id/thumbnails/:index', async (req, res, next) => {
    try {
      if (!/^\d+$/.test(req.params.index)) throw new HttpError(404, 'A thumbnail was not found.');
      const thumbnail = await mediaService.getThumbnail(req.params.id, Number(req.params.index));
      await sendFileRange(req, res, thumbnail.path, { contentType: thumbnail.contentType });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/media/:id', async (req, res, next) => {
    try {
      const asset = await mediaService.get(req.params.id);
      await sendFileRange(req, res, asset.path, { contentType: asset.contentType });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/export', async (req, res, next) => {
    try {
      const job = await exportService.create(req.body);
      res.status(202).json(job);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/exports', (_req, res) => {
    res.json({ exports: exportService.list() });
  });
  app.get('/api/exports/:id/download', async (req, res, next) => {
    try {
      const file = exportService.getFile(req.params.id);
      await sendFileRange(req, res, file.path, {
        contentType: 'video/mp4',
        downloadName: file.name,
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/exports/:id', (req, res, next) => {
    try {
      res.json(exportService.get(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/ai', await createAIRouter(mediaService));
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route was not found.' });
  });

  app.use(express.static(publicDir, { index: false, dotfiles: 'deny' }));
  let vite;
  if (useVite) {
    vite = await createViteServer({
      configFile: join(PROJECT_ROOT, 'vite.config.ts'),
      root: PROJECT_ROOT,
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir, { index: false, dotfiles: 'deny' }));
    app.get('/{*path}', (req, res, next) => {
      res.sendFile(join(distDir, 'index.html'), (error) => {
        if (error) next(new HttpError(404, 'The application has not been built yet.'));
      });
    });
  }

  app.use((error, req, res, next) => {
    if (req.path.startsWith('/api')) return sendApiError(error, req, res, next);
    if (res.headersSent) return next(error);
    res.status(500).type('text/plain').send('The server could not complete this request.');
  });

  app.locals.close = async () => {
    if (vite) await vite.close();
  };
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  const portValue = Number.parseInt(process.env.PORT || '3000', 10);
  const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535 ? portValue : 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log('Cutline server listening on port ' + port);
  });
  const shutdown = () => {
    server.close(() => {
      void app.locals.close().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
