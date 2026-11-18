# Cutline

A single-user video clipping studio built with React, TypeScript, Vite, Express and FFmpeg. Includes a locally bundled sample project: no account or AI key is needed to try the editor or export a video.

## Run

Use Node.js 24, FFmpeg (including ffprobe and the libass subtitle filter), and yt-dlp for optional YouTube imports. Setup installs yt-dlp 2026.10.26 with its default JavaScript dependencies; imports explicitly use the application's Node runtime and request up to 1080p.

```sh
npm ci
npm run dev
```

Open port 3000. `bash scripts/setup.sh` installs dependencies and prepares sample assets; on a root Debian-based sandbox it also installs missing FFmpeg. The managed Preview uses this setup and `npm run dev`.

```sh
npm run check          # Typecheck, production build, and automated tests
npm run build
npm start              # Serve the production build
npm run demo           # Verify or regenerate the bundled demo
```

The demo is bundled; regeneration downloads licensed footage only if its prepared files are absent. Source credits and font licenses are in [public/ASSET-LICENSES.md](public/ASSET-LICENSES.md).

## Editing

- Import a local video (up to 300 MB / 30 minutes), or an individual YouTube video you have permission to use. Optional sign-in cookies are supported; unavailable or platform-blocked videos may still fail. Uploading a permitted local copy remains available.
- Scrub and play the source, choose trim points, reframe portrait/landscape/square/original, apply color effects, and add a Like or Subscribe overlay.
- Import SRT/WebVTT, edit captions and timestamps, choose caption styles, or download subtitles with times relative to the selected clip.
- Mix source audio with the included music, uploaded music/voice recordings, or optional AI voiceovers.
- Export clips from 0.25 to 180 seconds as real H.264/AAC MP4s. Portrait is 720×1280, landscape 1280×720, square 720×720; original ratio is fitted within 1080px. Captions and overlays are burned in. Completed renders remain in the Exports library.

### YouTube sign-in cookies

In **New project → YouTube link → YouTube cookies**, choose your own `cookies.txt` export when YouTube asks you to sign in. Use Netscape/Mozilla format, up to 128 KB, containing only `youtube.com` cookies (including its subdomains). JSON exports and pasted browser Cookie headers are not supported. See the [official yt-dlp YouTube cookie guide](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies) for exporting the file; browser-wide exports can include credentials for unrelated websites and must not be used here.

Cookies are account credentials: never share them in chat, commit them to GitHub, or use someone else's session. Only import them into a server you trust. The file is sent to the server running Cutline (your PC when running locally), used by yt-dlp for that import, and removed from temporary storage when the operation finishes or is cancelled. It is not saved with projects or in browser storage. Select the file again for each attempt. Keep your original export secure and delete it when no longer needed; common cookie-export filenames are excluded from Git.

Cookies can expire or rotate, do not grant rights to a video, and do not guarantee that YouTube will allow a download. Using an account with yt-dlp can carry account restrictions or suspension risk; use cookies only when needed. No browser cookies are extracted automatically.

## Optional AI

Open **AI connection** for OpenAI, Groq, or a public HTTPS OpenAI-compatible endpoint. Model names are configurable. Keys live only in tab memory, travel to this server per requested operation, and are not persisted with projects. Reloading clears the connection. Provider calls occur only on explicit actions and may be billable.

Transcription uses timestamped speech recognition; clip suggestions and the heatmap are model predictions from the transcript, **not audience-retention analytics or frame-by-frame video analysis**. Auto-clip selects up to 60 seconds (the full source if shorter). The sample captions, scores and suggestions are clearly illustrative. Live-provider behavior requires a valid key; automated tests use mocked providers.

OpenAI/custom voiceovers accept up to 4,000 characters, subject to the provider's capabilities. Groq's documented Orpheus voices accept up to 200 characters at natural speed. You can always upload an existing voice recording without an AI provider.

## Storage and deployment

Projects and undo history belong to the browser (project settings persist in local storage; undo history lasts for the current editor session). Uploaded media, generated audio and rendered exports live in `.data/`, which must be preserved between server restarts. Media is not embedded in project storage, so keep a downloaded copy of finished work. Switching projects while AI or music uploads run saves results to the originating project.

This is a trusted, single-user workspace, not a multi-tenant hosted service. Do not expose it directly to the public internet: add authentication, per-user storage/quotas and a protected reverse proxy first. API requests are same-origin; provider endpoints reject local/private addresses and redirects. No API keys are required in environment files.
