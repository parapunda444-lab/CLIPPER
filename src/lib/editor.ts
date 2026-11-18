import type { Asset, Caption, Clip, Demo, Project, Settings } from '../types.ts';

export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export function timeLabel(seconds: number, precise = false) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const whole = Math.floor(safe);
  const base = `${Math.floor(whole / 60).toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
  return precise ? `${base}.${Math.floor((safe - whole) * 10)}` : base;
}
export function parseTime(value: string): number | null {
  const parts = value.trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  if (parts.length > 1 && Number(parts.at(-1)) >= 60) return null;
  if (parts.length === 3 && Number(parts[1]) >= 60) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}
export function defaultSettings(duration: number): Settings {
  return { start: 0, end: Math.min(60, duration), aspect: '9:16', cropX: 50, effect: 'none', showCaptions: true, subtitleStyle: 'pop', callout: 'none', musicId: null, voiceId: null, musicVolume: .18, sourceVolume: 1, voiceVolume: 1 };
}
export function newProject(asset: Asset): Project {
  return { id: crypto.randomUUID(), name: asset.name.replace(/\.[^.]+$/, ''), asset, captions: [], clips: [], heatmap: [], source: 'manual', settings: defaultSettings(asset.duration), selectedClipId: null, updatedAt: new Date().toISOString() };
}
export function selectClip(project: Project, clip: Clip): Project {
  const start = clamp(clip.start, 0, Math.max(0, project.asset.duration - .25));
  return { ...project, selectedClipId: clip.id, settings: { ...project.settings, start, end: clamp(clip.end, start + .25, Math.min(project.asset.duration, start + 180)), aspect: '9:16', showCaptions: true } };
}
export function demoProject(demo: Demo): Project {
  let project: Project = { ...newProject({ ...demo.asset, thumbnails: demo.thumbnails || demo.asset.thumbnails }), id: 'cutline-demo', source: 'demo', captions: demo.captions, clips: demo.clips, heatmap: demo.heatmap, music: demo.music, name: 'A little room to breathe' };
  if (demo.clips.length) project = selectClip(project, demo.clips[0]);
  return project;
}
export function bestSixty(clips: Clip[], duration: number): Clip | null {
  if (!clips.length) return null;
  const best = [...clips].sort((a, b) => b.score - a.score)[0];
  const length = Math.min(60, duration);
  const start = clamp(best.start, 0, Math.max(0, duration - length));
  return { ...best, start, end: start + length };
}
function srtTime(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${Math.floor(ms / 3600000).toString().padStart(2, '0')}:${Math.floor(ms / 60000 % 60).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')},${(ms % 1000).toString().padStart(3, '0')}`;
}
export function toSrt(captions: Caption[], start = 0, end = Infinity) {
  return captions.filter(c => c.end > start && c.start < end).map((c, i) => `${i + 1}\n${srtTime(Math.max(c.start, start) - start)} --> ${srtTime(Math.min(c.end, end) - start)}\n${c.text}\n`).join('\n');
}
export function parseSrt(text: string, duration: number): Caption[] {
  if (text.length > 2_000_000) throw new Error('Please import a subtitle file smaller than 2 MB.');
  const captions: Caption[] = [];
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const i = lines.findIndex(line => line.includes('-->'));
    if (i < 0) continue;
    const match = lines[i].match(/([\d:]+[,.]\d+)\s*-->\s*([\d:]+[,.]\d+)/);
    if (!match) throw new Error('A subtitle timestamp is invalid. Use standard SRT or WebVTT timestamps.');
    const start = parseTime(match[1].replace(',', '.'));
    const end = parseTime(match[2].replace(',', '.'));
    const content = lines.slice(i + 1).join('\n').replace(/<[^>]*>/g, '').trim();
    if (start === null || end === null || end <= start) throw new Error('Every caption needs an end time after its start time.');
    if (content.length > 2000) throw new Error('Keep each caption under 2,000 characters.');
    if (start >= duration || !content) continue;
    captions.push({ id: crypto.randomUUID(), start, end: Math.min(end, duration), text: content });
  }
  if (!captions.length) throw new Error('No captions match this video. Check the file and its timestamps.');
  if (captions.length > 2000) throw new Error('A project supports up to 2,000 captions.');
  return captions.sort((a, b) => a.start - b.start);
}
export function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function validYoutubeUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && ((['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) && ['/watch', '/shorts/' + url.pathname.split('/')[2]].includes(url.pathname) && (url.searchParams.has('v') || url.pathname.startsWith('/shorts/'))) || (url.hostname === 'youtu.be' && /^\/[\w-]{11}$/.test(url.pathname))); } catch { return false; }
}
export const effects = { none: 'none', cinematic: 'contrast(1.12) saturate(.82) brightness(.96)', vivid: 'saturate(1.35) contrast(1.06)', mono: 'grayscale(1)', warm: 'sepia(.23) saturate(1.15)' };
