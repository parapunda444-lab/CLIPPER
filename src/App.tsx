import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CirclePlay,
  Clapperboard,
  CheckCheck,
  Download,
  ExternalLink,
  Film,
  Flame,
  FolderOpen,
  Keyboard,
  LayoutGrid,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Plus,
  Redo2,
  Scissors,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import type {
  Asset,
  Caption,
  Clip,
  ExportJob,
  HeatPoint,
  Panel,
  Project,
  Provider,
  Settings,
} from "./types";
import { DEFAULT_PROVIDER } from "./types";
import { api } from "./lib/api";
import {
  bestSixty,
  clamp,
  demoProject,
  newProject,
  selectClip,
  timeLabel,
} from "./lib/editor";
import { useStudio } from "./lib/useStudio";
import { Modal } from "./components/Modal";
import { ImportDialog } from "./components/ImportDialog";
import { ProviderDialog } from "./components/ProviderDialog";
import { VoiceDialog } from "./components/VoiceDialog";
import { ExportDialog } from "./components/ExportDialog";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
import { LeftPanel } from "./components/LeftPanel";
import { Inspector } from "./components/Inspector";

type View = "studio" | "projects" | "exports";
type Dialog =
  | "import"
  | "provider"
  | "voice"
  | "export"
  | "help"
  | "rename"
  | null;
function Mark() {
  return (
    <svg viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path
        d="M21 7H12a6 6 0 0 0-6 6v4a6 6 0 0 0 6 6h9v-6h-9v-4h9z"
        fill="currentColor"
      />
      <path d="m24 7-7 16" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  );
}
export default function App() {
  const studio = useStudio();
  const { project, edit, current } = studio;
  const [view, setView] = useState<View>("studio");
  const [panel, setPanel] = useState<Panel>("moments");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [provider, setProvider] = useState<Provider>(DEFAULT_PROVIDER);
  const [busy, setBusy] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [toast, setToast] = useState("");
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [exportError, setExportError] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [newName, setNewName] = useState("");
  const video = useRef<HTMLVideoElement | null>(null);
  const aiAbort = useRef<AbortController | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 7000);
  }, []);
  const onSettings = useCallback(
    (settings: Partial<Settings>) =>
      edit((p) => ({
        ...p,
        settings: { ...p.settings, ...settings },
        selectedClipId:
          "start" in settings || "end" in settings ? null : p.selectedClipId,
      })),
    [edit],
  );
  const onJob = useCallback(
    (job: ExportJob) =>
      setExports((list) => [job, ...list.filter((item) => item.id !== job.id)]),
    [],
  );
  const loadExports = useCallback(async () => {
    try {
      const result = await api<{ exports: ExportJob[] }>("/api/exports");
      setExports(result.exports);
      setExportError("");
    } catch (e) {
      setExportError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void loadExports();
  }, [loadExports]);
  useEffect(() => {
    if (view !== "exports") return;
    void loadExports();
    const timer = setInterval(() => void loadExports(), 3000);
    return () => clearInterval(timer);
  }, [view, loadExports]);
  useEffect(
    () => () => {
      aiAbort.current?.abort();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const seek = useCallback(
    (n: number) => {
      const p = current.current;
      if (!p) return;
      const value = clamp(n, 0, p.asset.duration);
      if (video.current) video.current.currentTime = value;
      setTime(value);
    },
    [current],
  );
  const toggle = useCallback(() => {
    const v = video.current;
    const p = current.current;
    if (!v || !p) return;
    if (v.paused) {
      if (
        v.currentTime < p.settings.start ||
        v.currentTime >= p.settings.end - 0.05
      )
        v.currentTime = p.settings.start;
      void v
        .play()
        .catch(() =>
          notify(
            "Playback could not start. Try re-uploading the video as an MP4.",
          ),
        );
    } else v.pause();
  }, [current, notify]);
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        dialog ||
        deleteProject ||
        busy ||
        view !== "studio" ||
        (e.target instanceof HTMLElement &&
          e.target.closest('input,textarea,select,[contenteditable="true"]'))
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek((video.current?.currentTime || 0) - 5);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        seek((video.current?.currentTime || 0) + 5);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? studio.redo() : studio.undo();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [dialog, deleteProject, busy, view, toggle, seek, studio]);
  useEffect(() => {
    if (dialog || view !== "studio") video.current?.pause();
  }, [dialog, view]);
  function go(next: View) {
    setView(next);
    setMobileNav(false);
  }
  function openProject(p: Project) {
    studio.open(p);
    setTime(p.settings.start);
    setPlaying(false);
    setView("studio");
    setPanel("moments");
  }
  function imported(asset: Asset) {
    openProject(newProject(asset));
    setDialog(null);
    notify("Your video is ready. Let’s make something great.");
  }
  function openDemo() {
    if (studio.demo) {
      openProject(demoProject(studio.demo));
      setDialog(null);
      notify("Sample project loaded. Everything you edit can be exported.");
    } else
      notify(
        studio.loadError ||
          "The sample is still loading. Please try again in a moment.",
      );
  }
  function chooseClip(clip: Clip) {
    edit((p) => selectClip(p, clip));
    seek(clip.start);
    notify(
      `${clip.title} · ${Math.round(clip.end - clip.start)} seconds selected.`,
    );
  }
  async function transcribe() {
    const p = current.current;
    if (!p || busy) return;
    if (!provider.apiKey) {
      setDialog("provider");
      return;
    }
    const controller = new AbortController();
    aiAbort.current = controller;
    setBusy("Transcribing…");
    try {
      const result = await api<{ captions: Caption[] }>(
        "/api/ai/transcribe",
        { mediaId: p.asset.id, provider },
        controller.signal,
      );
      studio.editProject(p.id, (latest) => ({
        ...latest,
        captions: result.captions,
        settings: { ...latest.settings, showCaptions: true },
      }));
      if (current.current?.id === p.id) setPanel("transcript");
      notify(`${result.captions.length} captions saved to ${p.name}.`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify((e as Error).message);
    } finally {
      if (aiAbort.current === controller) {
        setBusy("");
        aiAbort.current = null;
      }
    }
  }
  async function analyze(auto = false) {
    const p = current.current;
    if (!p || busy) return;
    if (auto && p.source === "demo") {
      const best = bestSixty(p.clips, p.asset.duration);
      if (best) {
        chooseClip(best);
        notify(
          "Best sample moment selected: 60s, portrait, captions on. Connect AI to analyze your own video.",
        );
        return;
      }
    }
    if (!provider.apiKey) {
      setDialog("provider");
      return;
    }
    const controller = new AbortController();
    aiAbort.current = controller;
    try {
      let captions = p.captions;
      if (!captions.length) {
        setBusy("Transcribing…");
        const result = await api<{ captions: Caption[] }>(
          "/api/ai/transcribe",
          { mediaId: p.asset.id, provider },
          controller.signal,
        );
        captions = result.captions;
        studio.editProject(p.id, (latest) => ({ ...latest, captions }));
      }
      setBusy("Finding moments…");
      const result = await api<{ clips: Clip[]; heatmap: HeatPoint[] }>(
        "/api/ai/analyze",
        { provider, captions, duration: p.asset.duration, targetDuration: 60 },
        controller.signal,
      );
      const best = auto ? bestSixty(result.clips, p.asset.duration) : null;
      studio.editProject(p.id, (latest) => {
        const next = {
          ...latest,
          captions,
          clips: result.clips,
          heatmap: result.heatmap,
          source: "ai" as const,
        };
        return best ? selectClip(next, best) : next;
      });
      if (current.current?.id === p.id) {
        if (best) seek(best.start);
        setPanel("moments");
      }
      notify(
        auto
          ? `Your clip is ready in ${p.name}.`
          : `AI predictions saved to ${p.name}. Choose your favorite moment.`,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") notify((e as Error).message);
    } finally {
      if (aiAbort.current === controller) {
        setBusy("");
        aiAbort.current = null;
      }
    }
  }
  function attachMusic(asset: Asset, projectId: string) {
    studio.editProject(projectId, (p) => ({
      ...p,
      music: asset,
      settings: { ...p.settings, musicId: asset.id },
    }));
    notify("Soundtrack saved to its project. Adjust the mix to make it yours.");
  }
  function attachVoice(asset: Asset, projectId: string) {
    studio.editProject(projectId, (p) => ({
      ...p,
      voice: asset,
      settings: { ...p.settings, voiceId: asset.id, sourceVolume: 0.3 },
    }));
    setDialog(null);
    notify("Voiceover added. Original audio lowered to 30% for a clearer mix.");
  }

  const rendering = exports.filter(
    (job) => job.status === "processing" || job.status === "queued",
  ).length;
  return (
    <div className="app-shell">
      <button
        className={`nav-scrim ${mobileNav ? "visible" : ""}`}
        aria-label="Close navigation"
        onClick={() => setMobileNav(false)}
      />
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("studio");
          }}
        >
          <span className="brand-mark">
            <Mark />
          </span>
          cutline<span className="brand-period">.</span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">Y</span>
          <div>
            <strong>Your workspace</strong>
            <small>A little space to create</small>
          </div>
          <span className="workspace-status" title="Single-user workspace" />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={view === "studio" ? "active" : ""}
            onClick={() => go("studio")}
          >
            <Clapperboard size={18} /> Clip studio{" "}
            {view === "studio" && <span className="nav-active-dot" />}
          </button>
          <button
            className={view === "projects" ? "active" : ""}
            onClick={() => go("projects")}
          >
            <FolderOpen size={18} /> My projects{" "}
            <span className="nav-count">{studio.library.length}</span>
          </button>
          <button
            className={view === "exports" ? "active" : ""}
            onClick={() => go("exports")}
          >
            <Download size={18} /> Exports{" "}
            {rendering > 0 && (
              <span className="nav-count rendering-count">{rendering}</span>
            )}
          </button>
        </nav>
        <span className="nav-label tools-label">THE CREATIVE TOOLKIT</span>
        <nav className="main-nav tool-nav" aria-label="Creative tools">
          <button
            className={
              view === "studio" && panel === "heatmap" ? "tool-active" : ""
            }
            onClick={() => {
              go("studio");
              setPanel("heatmap");
            }}
          >
            <Flame size={18} /> AI heatmap <span className="new-pill">NEW</span>
          </button>
          <button
            disabled={!project || !!busy}
            onClick={() => {
              setDialog("voice");
              setMobileNav(false);
            }}
          >
            <AudioLines size={18} /> Voices & audio
          </button>
          <button
            onClick={() => {
              setDialog("provider");
              setMobileNav(false);
            }}
          >
            <Settings2 size={18} /> AI connection{" "}
            <span
              className={`connection-dot ${provider.apiKey ? "connected" : ""}`}
            />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="creative-card">
            <span className="creative-spark">
              <Sparkles size={21} />
              <i />
            </span>
            <h3>
              Big stories.
              <br />
              Little masterpieces.
            </h3>
            <p>There’s a great clip in every story. Let’s find yours.</p>
            <button disabled={!!busy} onClick={() => setDialog("import")}>
              Create something <ArrowUpRight size={15} />
            </button>
            <div className="card-decoration" />
          </div>
          <button className="help-nav" onClick={() => setDialog("help")}>
            <CircleHelp size={17} /> A little help <ArrowUpRight size={14} />
          </button>
          <div className="sidebar-user">
            <span>YS</span>
            <div>
              <strong>Your studio</strong>
              <small>Made for your next idea</small>
            </div>
            <span className="user-dot" />
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-home">
              <LayoutGrid size={14} /> Workspace
            </span>
            <ChevronRight size={13} />
            <strong>
              {view === "studio"
                ? "Clip studio"
                : view === "projects"
                  ? "My projects"
                  : "Exports"}
            </strong>
          </div>
          <div className="header-actions">
            <span className={`save-status ${!studio.saved ? "warning" : ""}`}>
              <CheckCheck size={14} />
              {studio.saved
                ? "Saved on this browser"
                : "Browser storage unavailable"}
            </span>
            <button
              className="icon-button keyboard-button"
              aria-label="Keyboard shortcuts"
              onClick={() => setDialog("help")}
            >
              <Keyboard size={18} />
            </button>
            <span className="header-divider" />
            <button
              className="button primary header-export"
              disabled={!project || !!busy}
              onClick={() => setDialog("export")}
            >
              <Upload size={15} /> Export clip <ChevronDown size={13} />
            </button>
          </div>
        </header>
        <main>
          {view === "studio" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    A LITTLE CUT. A BIG DIFFERENCE.
                  </span>
                  <h1>
                    Your next standout clip<span>.</span>
                  </h1>
                  <p>Find the moment. Make it yours. Give it to the world.</p>
                </div>
                <button
                  className="button secondary new-project-button"
                  disabled={!!busy}
                  onClick={() => setDialog("import")}
                >
                  <Plus size={16} /> New project
                </button>
              </div>
              {project ? (
                <>
                  <div className="project-bar">
                    <div>
                      <span className="project-symbol">
                        <Film size={14} />
                      </span>
                      <button
                        className="project-name"
                        title="Rename project"
                        onClick={() => {
                          setNewName(project.name);
                          setDialog("rename");
                        }}
                      >
                        {project.name}
                        <MoreHorizontal size={16} />
                      </button>
                      <span
                        className={`project-tag ${project.source === "demo" ? "sample" : "original"}`}
                      >
                        {project.source === "demo"
                          ? "SAMPLE PROJECT"
                          : project.source === "ai"
                            ? "AI ANALYZED"
                            : "YOUR ORIGINAL"}
                      </span>
                    </div>
                    <div className="editor-history">
                      {busy && (
                        <span className="busy-inline">
                          <LoaderCircle size={13} className="spin" />
                          {busy}
                          <button
                            onClick={() => {
                              aiAbort.current?.abort();
                              setBusy("");
                              notify("AI request cancelled.");
                            }}
                          >
                            Cancel
                          </button>
                        </span>
                      )}
                      <button
                        className="icon-button"
                        aria-label="Undo edit"
                        disabled={!studio.canUndo || !!busy}
                        onClick={studio.undo}
                      >
                        <Undo2 size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Redo edit"
                        disabled={!studio.canRedo || !!busy}
                        onClick={studio.redo}
                      >
                        <Redo2 size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="studio-grid">
                    <LeftPanel
                      project={project}
                      panel={panel}
                      onPanel={setPanel}
                      onClip={chooseClip}
                      onAuto={() => void analyze(true)}
                      onAnalyze={() => void analyze()}
                      busy={busy}
                      onTranscribe={() => void transcribe()}
                      onCaptions={(captions) =>
                        edit((p) => ({ ...p, captions }))
                      }
                      onSeek={seek}
                      currentTime={time}
                      onNotify={notify}
                    />
                    <Player
                      project={project}
                      videoRef={video}
                      currentTime={time}
                      playing={playing}
                      onTime={setTime}
                      onPlaying={setPlaying}
                      onSeek={seek}
                      onToggle={toggle}
                    />
                    <Inspector
                      project={project}
                      onSettings={onSettings}
                      onMusic={attachMusic}
                      onVoice={() => setDialog("voice")}
                      onNotify={notify}
                      demoMusic={studio.demo?.music}
                    />
                  </div>
                  <Timeline
                    project={project}
                    currentTime={time}
                    onSeek={seek}
                    onSettings={onSettings}
                    onHeatmap={() => setPanel("heatmap")}
                  />
                  <footer className="studio-footer">
                    <span>
                      <span className="tiny-dot" /> A good story deserves to be
                      seen.
                    </span>
                    <span>
                      Made with a little creative magic <Sparkles size={12} />
                    </span>
                  </footer>
                </>
              ) : (
                <div className="loading-state">
                  {studio.loadError ? (
                    <>
                      <Film size={36} />
                      <h2>Your studio is ready for a video.</h2>
                      <p>{studio.loadError}</p>
                      <button
                        className="button primary"
                        onClick={() => setDialog("import")}
                      >
                        <Plus size={16} /> Import your video
                      </button>
                    </>
                  ) : (
                    <>
                      <LoaderCircle size={30} className="spin" />
                      <h2>Setting the scene…</h2>
                      <p>Your sample project is on its way.</p>
                    </>
                  )}
                </div>
              )}
            </>
          ) : view === "projects" ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR CREATIVE COLLECTION</span>
                  <h1>
                    Stories in the making<span>.</span>
                  </h1>
                  <p>
                    Your edits, captions and creative choices, saved in this
                    browser.
                  </p>
                </div>
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() => setDialog("import")}
                >
                  <Plus size={16} /> New project
                </button>
              </div>
              <div className="project-library">
                {studio.library.map((p) => (
                  <article className="project-library-card" key={p.id}>
                    <button
                      className="project-cover"
                      onClick={() => openProject(p)}
                    >
                      {p.asset.thumbnail ? (
                        <img src={p.asset.thumbnail} alt="" />
                      ) : (
                        <Film size={35} />
                      )}
                      <span className="cover-play">
                        <CirclePlay size={31} />
                      </span>
                      <span className="project-cover-duration">
                        {timeLabel(p.asset.duration)}
                      </span>
                      {p.source === "demo" && (
                        <span className="project-cover-badge">SAMPLE</span>
                      )}
                    </button>
                    <div className="project-library-copy">
                      <button onClick={() => openProject(p)}>
                        <h3>{p.name}</h3>
                        <p>
                          {p.settings.aspect} <span>·</span>{" "}
                          {Math.round(p.settings.end - p.settings.start)}s clip{" "}
                          <span>·</span> {p.captions.length} captions
                        </p>
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Remove ${p.name} from projects`}
                        disabled={p.id === project?.id}
                        title={
                          p.id === project?.id
                            ? "Open another project before removing this one"
                            : "Remove from browser"
                        }
                        onClick={() => setDeleteProject(p)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                ))}
                <button
                  className="project-library-new"
                  disabled={!!busy}
                  onClick={() => setDialog("import")}
                >
                  <span>
                    <Plus size={27} />
                  </span>
                  <h3>Start a new story</h3>
                  <p>That next great moment is waiting.</p>
                </button>
              </div>
              <div className="library-note">
                <FolderOpen size={16} />
                <p>
                  Projects are saved in this browser; uploaded media and
                  rendered files are stored in this workspace. Keep a downloaded
                  copy of your finished work.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">FROM YOUR STUDIO TO THE WORLD</span>
                  <h1>
                    Good things, ready to go<span>.</span>
                  </h1>
                  <p>
                    Your finished clips. Real MP4s, ready for their next
                    chapter.
                  </p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => void loadExports()}
                >
                  Refresh exports <Download size={15} />
                </button>
              </div>
              {exportError && (
                <p className="error-box" role="alert">
                  {exportError}
                </p>
              )}
              {exports.length ? (
                <div className="export-library">
                  {exports.map((job) => (
                    <article key={job.id} className="export-row">
                      <span
                        className={`export-row-icon ${job.status === "complete" ? "complete" : ""}`}
                      >
                        {job.status === "processing" ||
                        job.status === "queued" ? (
                          <LoaderCircle size={23} className="spin" />
                        ) : job.status === "complete" ? (
                          <Check size={23} />
                        ) : (
                          <Film size={23} />
                        )}
                      </span>
                      <div>
                        <h3>{job.name || "Your Cutline clip"}</h3>
                        <p>
                          {job.aspect || "MP4"}{" "}
                          {job.duration
                            ? `· ${Math.round(job.duration)} seconds`
                            : ""}{" "}
                          {job.createdAt
                            ? `· ${new Date(job.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                            : ""}
                        </p>
                        {job.error && (
                          <p className="export-row-error">{job.error}</p>
                        )}
                      </div>
                      <span className={`export-status ${job.status}`}>
                        {job.status === "complete"
                          ? "Ready to share"
                          : job.status === "error"
                            ? "Render failed"
                            : `${job.status === "queued" ? "Queued" : "Rendering"} · ${Math.round(job.progress)}%`}
                      </span>
                      {job.status === "complete" && (
                        <a className="button secondary" href={job.url} download>
                          <ArrowDownToLine size={15} /> Download MP4
                        </a>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="library-empty">
                  <span>
                    <Scissors size={36} />
                  </span>
                  <h2>Your first masterpiece belongs here.</h2>
                  <p>
                    Export a clip from the studio and we’ll keep the finished
                    file here for you.
                  </p>
                  <button
                    className="button primary"
                    onClick={() => go("studio")}
                  >
                    Back to the studio <ArrowRight size={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={16} />
          </span>
          <p>{toast}</p>
          <button
            onClick={() => setToast("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {dialog === "import" && (
        <ImportDialog
          onClose={() => setDialog(null)}
          onImported={imported}
          onDemo={openDemo}
        />
      )}{" "}
      {dialog === "provider" && (
        <ProviderDialog
          provider={provider}
          onClose={() => setDialog(null)}
          onSave={(value) => {
            setProvider(value);
            setDialog(null);
            notify(
              "Provider configured for this tab. Choose an AI action whenever you’re ready.",
            );
          }}
        />
      )}
      {dialog === "voice" && project && (
        <VoiceDialog
          project={project}
          provider={provider}
          onClose={() => setDialog(null)}
          onConnect={() => setDialog("provider")}
          onGenerated={(asset) => attachVoice(asset, project.id)}
        />
      )}{" "}
      {dialog === "export" && project && (
        <ExportDialog
          project={project}
          onClose={() => setDialog(null)}
          onJob={onJob}
        />
      )}{" "}
      {dialog === "rename" && project && (
        <Modal
          title="Give your story a name."
          eyebrow="PROJECT DETAILS"
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) {
                edit((p) => ({ ...p, name: newName.trim() }));
                setDialog(null);
              }
            }}
          >
            <label className="field-label" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className="text-input"
              maxLength={100}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={!newName.trim()}>
                Save name <Check size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "help" && (
        <Modal
          title="A little help. A lot of possibility."
          eyebrow="WELCOME TO CUTLINE"
          onClose={() => setDialog(null)}
        >
          <div className="help-steps">
            <div>
              <span>01</span>
              <div>
                <h3>Bring your story.</h3>
                <p>
                  Upload your original video or import a permitted YouTube link.
                  The sample project is here to explore.
                </p>
              </div>
            </div>
            <div>
              <span>02</span>
              <div>
                <h3>Find your moment.</h3>
                <p>
                  Connect your AI provider for transcription and engagement
                  predictions. Make a 60s clip, or use the timeline handles for
                  your own cut.
                </p>
              </div>
            </div>
            <div>
              <span>03</span>
              <div>
                <h3>Make it yours. Then share.</h3>
                <p>
                  Style your captions, choose your framing and sound, then
                  render a real MP4. Download it to post on your favorite
                  platform.
                </p>
              </div>
            </div>
          </div>
          <h3 className="shortcuts-title">
            <Keyboard size={17} /> Your creative shortcuts
          </h3>
          <div className="shortcuts">
            <span>Play / pause</span>
            <kbd>Space</kbd>
            <span>Seek 5 seconds</span>
            <div>
              <kbd>←</kbd> <kbd>→</kbd>
            </div>
            <span>Undo / redo</span>
            <kbd>⌘ / Ctrl + Z / ⇧ Z</kbd>
          </div>
          <div className="notice">
            <Sparkles size={17} />
            <p>
              AI predictions are estimates, not viewer data. The sample has
              illustrative captions and scores. Your API key stays in tab
              memory; provider charges may apply.
            </p>
          </div>
          <a
            className="subtle-link"
            href="/ASSET-LICENSES.md"
            target="_blank"
            rel="noreferrer"
          >
            Sample media credits <ExternalLink size={12} />
          </a>
        </Modal>
      )}
      {deleteProject && (
        <Modal
          title="Remove this project?"
          eyebrow="YOUR PROJECT LIBRARY"
          onClose={() => setDeleteProject(null)}
        >
          <p className="modal-intro">
            “{deleteProject.name}” will be removed from this browser’s project
            list. Uploaded media and exports will not be deleted.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteProject(null)}
            >
              <ArrowLeft size={15} /> Keep project
            </button>
            <button
              className="button danger"
              onClick={() => {
                studio.remove(deleteProject.id);
                setDeleteProject(null);
                notify("Project removed from this browser.");
              }}
            >
              <Trash2 size={15} /> Remove project
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
