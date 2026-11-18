import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  Film,
  Link,
  LoaderCircle,
  LockKeyhole,
  UploadCloud,
  X,
  Youtube,
} from "lucide-react";
import { Modal } from "./Modal";
import { api, upload } from "../lib/api";
import { validYoutubeUrl } from "../lib/editor";
import type { Asset } from "../types";

const MAX_COOKIES_BYTES = 128 * 1024;

export function ImportDialog({
  onClose,
  onImported,
  onDemo,
}: {
  onClose: () => void;
  onImported: (asset: Asset) => void;
  onDemo: () => void;
}) {
  const [mode, setMode] = useState<"file" | "youtube">("file");
  const [url, setUrl] = useState("");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [drag, setDrag] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [cookiesFile, setCookiesFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cookiesRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  useEffect(() => () => abortRef.current?.(), []);
  async function importFile(file?: File) {
    if (!file || busy) return;
    if (file.size > 300 * 1024 * 1024) {
      setError("Choose a video smaller than 300 MB.");
      return;
    }
    setBusy(true);
    setError("");
    const task = upload<{ asset: Asset }>(
      "/api/media/upload",
      "video",
      file,
      setProgress,
    );
    abortRef.current = task.abort;
    try {
      const data = await task.promise;
      onImported(data.asset);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        setError((e as Error).message);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }
  function selectCookies(file?: File) {
    if (!file || busy) return;
    setCookiesFile(null);
    setError("");
    if (!file.name.toLowerCase().endsWith(".txt")) {
      setError("Choose a Netscape-format cookies.txt file, not a JSON export.");
    } else if (!file.size || file.size > MAX_COOKIES_BYTES) {
      setError("Choose a non-empty cookies.txt file up to 128 KB.");
    } else {
      setCookiesFile(file);
    }
  }
  async function importUrl() {
    if (busy) return;
    if (!validYoutubeUrl(url)) {
      setError("Enter a valid YouTube video link, not a channel or playlist.");
      return;
    }
    if (!rights) {
      setError("Confirm that you have permission to use this video.");
      return;
    }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = () => controller.abort();
    try {
      const cookies = cookiesFile ? await cookiesFile.text() : undefined;
      controller.signal.throwIfAborted();
      if (
        cookies !== undefined &&
        !/^\uFEFF?# (?:Netscape )?HTTP Cookie File\r?\n/.test(cookies)
      ) {
        throw new Error("Export youtube.com cookies in Netscape cookies.txt format.");
      }
      const data = await api<{ asset: Asset }>(
        "/api/media/youtube",
        { url, rightsConfirmed: true, ...(cookies === undefined ? {} : { cookies }) },
        controller.signal,
      );
      onImported(data.asset);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
      setCookiesFile(null);
      abortRef.current = null;
    }
  }
  return (
    <Modal
      title="Start with a great story."
      eyebrow="NEW PROJECT"
      onClose={onClose}
    >
      <p className="modal-intro">
        Bring your video. We’ll help you find the moments.
      </p>
      <div className="segmented import-tabs">
        <button
          className={mode === "file" ? "active" : ""}
          onClick={() => {
            setMode("file");
            setCookiesFile(null);
            setCookiesOpen(false);
            setError("");
          }}
          disabled={busy}
        >
          <Film size={16} /> Upload a video
        </button>
        <button
          className={mode === "youtube" ? "active" : ""}
          onClick={() => {
            setMode("youtube");
            setError("");
          }}
          disabled={busy}
        >
          <Youtube size={17} /> YouTube link
        </button>
      </div>
      {mode === "file" ? (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,.mkv,.mov,.m4v"
            className="sr-only"
            aria-label="Upload video file"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <button
            className={`dropzone ${drag ? "dragging" : ""}`}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void importFile(e.dataTransfer.files[0]);
            }}
          >
            <span className="upload-circle">
              {busy ? (
                <LoaderCircle size={27} className="spin" />
              ) : (
                <UploadCloud size={27} />
              )}
            </span>
            <strong>
              {busy
                ? progress < 100
                  ? `Uploading your video… ${progress}%`
                  : "Preparing your video…"
                : "Drop your video here"}
            </strong>
            <span>
              {busy ? (
                "Just a moment. Good things are coming."
              ) : (
                <>
                  or <b>browse files</b> to get started
                </>
              )}
            </span>
            <small>MP4, MOV, WebM & more · Up to 300 MB · 30 minutes</small>
          </button>
        </>
      ) : (
        <div className="youtube-form">
          <label htmlFor="youtube-url">Video URL</label>
          <div className="input-with-icon">
            <Link size={17} />
            <input
              id="youtube-url"
              type="url"
              placeholder="https://youtube.com/watch?v=…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          </div>
          <section className="youtube-cookies">
            <button
              type="button"
              className="youtube-cookies-toggle"
              aria-expanded={cookiesOpen}
              aria-controls="youtube-cookies-options"
              onClick={() => setCookiesOpen(!cookiesOpen)}
            >
              <LockKeyhole size={15} />
              <span>YouTube cookies</span>
              <small>{cookiesFile ? "File selected" : "Optional"}</small>
              <ChevronDown size={15} />
            </button>
            <div id="youtube-cookies-options" hidden={!cookiesOpen}>
              <p className="help-text">
                If YouTube asks you to sign in, select your own youtube.com
                cookies.txt export. Netscape format only · Up to 128 KB.
              </p>
              <input
                ref={cookiesRef}
                type="file"
                accept=".txt,text/plain"
                className="sr-only"
                aria-label="Upload YouTube cookies file"
                disabled={busy}
                onChange={(e) => {
                  selectCookies(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <div className="youtube-cookie-file">
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => cookiesRef.current?.click()}
                >
                  <FileText size={15} />
                  <span>{cookiesFile ? cookiesFile.name : "Choose cookies.txt"}</span>
                </button>
                {cookiesFile && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Remove cookies file"
                    disabled={busy}
                    onClick={() => setCookiesFile(null)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <p className="help-text cookie-privacy">
                Cookies can give access to your account. Only use a server you
                trust. Sent to this app’s server for this import, then deleted;
                never saved in your project. Select the file again to retry.
              </p>
              <a
                className="text-button cookie-guide"
                href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
                target="_blank"
                rel="noreferrer"
              >
                How to export YouTube cookies <ArrowUpRight size={13} />
              </a>
            </div>
          </section>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              disabled={busy}
            />
            <span>I own this video or have permission to edit it.</span>
          </label>
          <p className="help-text">
            Cookies may help with sign-in, but YouTube can still block downloads.
            You can always upload a local copy you have permission to use.
          </p>
          <button
            className="button primary full"
            disabled={busy || !url || !rights}
            onClick={() => void importUrl()}
          >
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Youtube size={17} />
            )}{" "}
            {busy ? "Importing video…" : "Import video"}
          </button>
        </div>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <div className="import-reassurance">
        <span>
          <Check size={13} /> Your original stays untouched
        </span>
        <span>
          <Check size={13} /> Real MP4 exports
        </span>
      </div>
      <div className="modal-bottom">
        <span>Just exploring?</span>
        <button className="text-button" disabled={busy} onClick={onDemo}>
          Open the sample project <ArrowUpRight size={15} />
        </button>
      </div>
    </Modal>
  );
}
