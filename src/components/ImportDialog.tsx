import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Film, Link, LoaderCircle, UploadCloud, Youtube } from 'lucide-react';
import { Modal } from './Modal';
import { api, upload } from '../lib/api';
import { validYoutubeUrl } from '../lib/editor';
import type { Asset } from '../types';

export function ImportDialog({ onClose, onImported, onDemo }: { onClose: () => void; onImported: (asset: Asset) => void; onDemo: () => void }) {
  const [mode, setMode] = useState<'file' | 'youtube'>('file');
  const [url, setUrl] = useState(''); const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0); const [error, setError] = useState(''); const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null); const abortRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abortRef.current?.(), []);
  async function importFile(file?: File) {
    if (!file || busy) return;
    if (file.size > 300 * 1024 * 1024) { setError('Choose a video smaller than 300 MB.'); return; }
    setBusy(true); setError('');
    const task = upload<{asset: Asset}>('/api/media/upload', 'video', file, setProgress); abortRef.current = task.abort;
    try { const data = await task.promise; onImported(data.asset); } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setError((e as Error).message); } finally { setBusy(false); abortRef.current = null; }
  }
  async function importUrl() {
    if (!validYoutubeUrl(url)) { setError('Enter a valid YouTube video link, not a channel or playlist.'); return; }
    if (!rights) { setError('Confirm that you have permission to use this video.'); return; }
    setBusy(true); setError('');
    const controller = new AbortController(); abortRef.current = () => controller.abort();
    try { const data = await api<{asset: Asset}>('/api/media/youtube', { url, rightsConfirmed: true }, controller.signal); onImported(data.asset); } catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); } finally { setBusy(false); abortRef.current = null; }
  }
  return <Modal title="Start with a great story." eyebrow="NEW PROJECT" onClose={onClose}><p className="modal-intro">Bring your video. We’ll help you find the moments.</p><div className="segmented import-tabs"><button className={mode === 'file' ? 'active' : ''} onClick={() => { setMode('file'); setError(''); }} disabled={busy}><Film size={16}/> Upload a video</button><button className={mode === 'youtube' ? 'active' : ''} onClick={() => { setMode('youtube'); setError(''); }} disabled={busy}><Youtube size={17}/> YouTube link</button></div>{mode === 'file' ? <><input ref={fileRef} type="file" accept="video/*,.mkv,.mov,.m4v" className="sr-only" aria-label="Upload video file" onChange={e => void importFile(e.target.files?.[0])}/><button className={`dropzone ${drag ? 'dragging' : ''}`} disabled={busy} onClick={() => fileRef.current?.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); void importFile(e.dataTransfer.files[0]); }}><span className="upload-circle">{busy ? <LoaderCircle size={27} className="spin"/> : <UploadCloud size={27}/>}</span><strong>{busy ? progress < 100 ? `Uploading your video… ${progress}%` : 'Preparing your video…' : 'Drop your video here'}</strong><span>{busy ? 'Just a moment. Good things are coming.' : <>or <b>browse files</b> to get started</>}</span><small>MP4, MOV, WebM & more · Up to 300 MB · 30 minutes</small></button></> : <div className="youtube-form"><label htmlFor="youtube-url">Video URL</label><div className="input-with-icon"><Link size={17}/><input id="youtube-url" type="url" placeholder="https://youtube.com/watch?v=…" value={url} onChange={e => setUrl(e.target.value)} disabled={busy}/></div><label className="checkbox-row"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} disabled={busy}/><span>I own this video or have permission to edit it.</span></label><p className="help-text">Public videos only. Some videos are restricted by YouTube; you can always upload your original file instead.</p><button className="button primary full" disabled={busy || !url || !rights} onClick={() => void importUrl()}>{busy ? <LoaderCircle size={17} className="spin"/> : <Youtube size={17}/>} {busy ? 'Importing video…' : 'Import video'}</button></div>}{error && <p className="error-box" role="alert">{error}</p>}<div className="import-reassurance"><span><Check size={13}/> Your original stays untouched</span><span><Check size={13}/> Real MP4 exports</span></div><div className="modal-bottom"><span>Just exploring?</span><button className="text-button" disabled={busy} onClick={onDemo}>Open the sample project <ArrowUpRight size={15}/></button></div></Modal>;
}
