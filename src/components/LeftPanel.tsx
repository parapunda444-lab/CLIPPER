import { useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Captions,
  ChevronRight,
  Film,
  Flame,
  LoaderCircle,
  Plus,
  Scissors,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import type { Caption, Clip, Panel, Project } from "../types";
import { downloadText, parseSrt, timeLabel, toSrt } from "../lib/editor";
import { TimeField } from "./Timeline";

export function LeftPanel({
  project,
  panel,
  onPanel,
  onClip,
  onAuto,
  onAnalyze,
  busy,
  onTranscribe,
  onCaptions,
  onSeek,
  currentTime,
  onNotify,
}: {
  project: Project;
  panel: Panel;
  onPanel: (p: Panel) => void;
  onClip: (c: Clip) => void;
  onAuto: () => void;
  onAnalyze: () => void;
  busy: string;
  onTranscribe: () => void;
  onCaptions: (c: Caption[]) => void;
  onSeek: (n: number) => void;
  currentTime: number;
  onNotify: (s: string) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const { asset, captions, clips, heatmap, settings } = project;
  const visible = captions.filter((c) =>
    c.text.toLowerCase().includes(query.toLowerCase()),
  );
  async function importSrt(f?: File) {
    if (!f) return;
    if (f.size > 2_000_000) {
      onNotify("Choose a subtitle file smaller than 2 MB.");
      return;
    }
    try {
      const values = parseSrt(await f.text(), asset.duration);
      onCaptions(values);
      onNotify(`Imported ${values.length} captions.`);
    } catch (e) {
      onNotify((e as Error).message);
    }
    if (file.current) file.current.value = "";
  }
  function editCaption(id: string, patch: Partial<Caption>) {
    onCaptions(captions.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  return (
    <section className="source-panel">
      <div className="source-card">
        <div className="source-image">
          {asset.thumbnail ? (
            <img src={asset.thumbnail} alt="Source video thumbnail" />
          ) : (
            <Film size={20} />
          )}
          <span>{timeLabel(asset.duration)}</span>
        </div>
        <div>
          <span className="eyebrow">YOUR SOURCE</span>
          <strong title={asset.name}>{asset.name}</strong>
          <small>
            {asset.width} × {asset.height} <span>·</span>{" "}
            {project.source === "demo" ? "Sample video" : "Original video"}
          </small>
        </div>
      </div>
      <div className="panel-tabs" role="tablist" aria-label="Source tools">
        <button
          role="tab"
          aria-selected={panel === "moments"}
          className={panel === "moments" ? "active" : ""}
          onClick={() => onPanel("moments")}
        >
          AI clips <span>{clips.length || "+"}</span>
        </button>
        <button
          role="tab"
          aria-selected={panel === "transcript"}
          className={panel === "transcript" ? "active" : ""}
          onClick={() => onPanel("transcript")}
        >
          Transcript
        </button>
        <button
          role="tab"
          aria-selected={panel === "heatmap"}
          className={panel === "heatmap" ? "active" : ""}
          onClick={() => onPanel("heatmap")}
          aria-label="Heatmap"
        >
          <Flame size={16} />
        </button>
      </div>
      {panel === "moments" ? (
        <div className="moments-panel">
          <div className="panel-section-heading">
            <div>
              <h3>Little clips. Big potential.</h3>
              <p>
                {clips.length
                  ? "A few moments worth sharing."
                  : "Let’s find your next great clip."}
              </p>
            </div>
            <Sparkles size={19} />
          </div>
          {project.source === "demo" && (
            <div className="sample-label">
              <span className="tiny-dot" /> Sample suggestions{" "}
              <span title="These are illustrative examples, not real audience data.">
                DEMO
              </span>
            </div>
          )}
          <div className="clip-list">
            {clips.length ? (
              clips.map((clip, i) => (
                <button
                  className={`clip-card ${project.selectedClipId === clip.id ? "selected" : ""}`}
                  key={clip.id}
                  onClick={() => onClip(clip)}
                >
                  <div className="clip-thumb">
                    <img
                      src={
                        clip.poster ||
                        asset.thumbnails?.[
                          Math.min(i * 3, asset.thumbnails.length - 1)
                        ] ||
                        asset.thumbnail
                      }
                      alt=""
                    />
                    <span>{Math.round(clip.end - clip.start)}s</span>
                  </div>
                  <div className="clip-copy">
                    <div className="clip-score">
                      <span>
                        <Sparkles size={11} /> {clip.score}
                      </span>
                      <small>
                        {project.source === "demo"
                          ? "SAMPLE SCORE"
                          : "AI PREDICTION"}
                      </small>
                    </div>
                    <strong>{clip.title}</strong>
                    <span className="clip-time">
                      {timeLabel(clip.start)} – {timeLabel(clip.end)}
                    </span>
                    <span className="clip-tag">
                      {clip.tags?.[0] || "Storytelling"}{" "}
                      <ChevronRight size={11} />
                    </span>
                  </div>
                  <span className="clip-number">0{i + 1}</span>
                </button>
              ))
            ) : (
              <div className="empty-moments">
                <span>
                  <WandSparkles size={28} />
                </span>
                <h4>Your best moments are in there.</h4>
                <p>
                  AI reads your transcript and suggests the most engaging parts.
                  No guessing, no fake view counts.
                </p>
              </div>
            )}
          </div>
          <div className="moments-bottom">
            <button
              className="button primary full"
              disabled={!!busy}
              onClick={onAuto}
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <WandSparkles size={16} />
              )}{" "}
              {busy ||
                (asset.duration < 60
                  ? `Make a ${Math.round(asset.duration)}s clip`
                  : "Make a 60s clip")}
              {!busy && <ArrowUpRight size={16} />}
            </button>
            <button
              className="reanalyze-button"
              disabled={!!busy}
              onClick={onAnalyze}
            >
              {clips.length ? "Analyze with my AI" : "Find standout moments"}{" "}
              <Sparkles size={12} />
            </button>
            <p>Portrait. Captions. Ready for your next post.</p>
          </div>
        </div>
      ) : panel === "transcript" ? (
        <div className="transcript-panel">
          <div className="transcript-toolbar">
            <span>{captions.length} captions</span>
            <div>
              <input
                ref={file}
                className="sr-only"
                type="file"
                accept=".srt,.vtt"
                aria-label="Import subtitles"
                onChange={(e) => void importSrt(e.target.files?.[0])}
              />
              <button
                className="icon-button"
                onClick={() => file.current?.click()}
                aria-label="Import SRT or VTT"
              >
                <ArrowUpFromLine size={15} />
              </button>
              <button
                className="icon-button"
                disabled={!captions.length}
                onClick={() =>
                  downloadText(
                    toSrt(captions, settings.start, settings.end),
                    `${project.name}.srt`,
                  )
                }
                aria-label="Download clip subtitles"
              >
                <ArrowDownToLine size={15} />
              </button>
            </div>
          </div>
          <input
            className="text-input transcript-search"
            placeholder="Find a word or a moment…"
            aria-label="Search transcript"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="transcript-list">
            {visible.length ? (
              visible.map((c) => (
                <div
                  key={c.id}
                  className={`transcript-line ${currentTime >= c.start && currentTime < c.end ? "active" : ""}`}
                >
                  <div>
                    <button
                      className="caption-seek"
                      onClick={() => onSeek(c.start)}
                    >
                      {timeLabel(c.start)}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Delete caption at ${timeLabel(c.start)}`}
                      onClick={() =>
                        onCaptions(captions.filter((item) => item.id !== c.id))
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <textarea
                    aria-label={`Caption at ${timeLabel(c.start)}`}
                    value={c.text}
                    maxLength={2000}
                    onChange={(e) =>
                      editCaption(c.id, { text: e.target.value })
                    }
                    rows={2}
                  />
                  <div className="caption-times">
                    <TimeField
                      label="Start"
                      value={c.start}
                      max={c.end - 0.01}
                      onChange={(start) => editCaption(c.id, { start })}
                    />
                    <TimeField
                      label="End"
                      value={c.end}
                      min={c.start + 0.01}
                      max={asset.duration}
                      onChange={(end) => editCaption(c.id, { end })}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-moments compact">
                <Captions size={27} />
                <h4>{query ? "No matching words." : "Every word matters."}</h4>
                <p>
                  {query
                    ? "Try another search."
                    : "Transcribe with AI, import subtitles, or write your own."}
                </p>
              </div>
            )}
          </div>
          <button
            className="add-caption"
            disabled={captions.length >= 2000}
            onClick={() => {
              const start = Math.min(currentTime, asset.duration - 0.25);
              onCaptions(
                [
                  ...captions,
                  {
                    id: crypto.randomUUID(),
                    start,
                    end: Math.min(start + 3, asset.duration),
                    text: "Your next great line.",
                  },
                ].sort((a, b) => a.start - b.start),
              );
              setQuery("");
            }}
          >
            <Plus size={13} /> Add caption at playhead
          </button>
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={onTranscribe}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Captions size={16} />
            )}{" "}
            {busy || "Transcribe with AI"}
          </button>
          <p className="panel-note">
            {project.source === "demo"
              ? "Demo captions are illustrative, not a speech transcript."
              : "AI transcribes the spoken audio in your video."}
          </p>
        </div>
      ) : (
        <div className="heatmap-panel">
          <div className="panel-section-heading">
            <div>
              <h3>Find the sweet spots.</h3>
              <p>Your story, seen from another angle.</p>
            </div>
            <Flame size={20} />
          </div>
          <div className="prediction-note">
            <Sparkles size={15} />
            <p>
              {project.source === "demo"
                ? "You’re exploring sample predictions."
                : "AI estimates which moments may hold attention."}{" "}
              This is not YouTube watch-time data.
            </p>
          </div>
          {heatmap.length ? (
            <>
              <div className="heatmap-stats">
                <div>
                  <strong>
                    {Math.max(...heatmap.map((h) => h.score))}
                    <span>/100</span>
                  </strong>
                  <small>
                    {project.source === "demo"
                      ? "Top sample score"
                      : "Top prediction"}
                  </small>
                </div>
                <div>
                  <strong>{clips.length}</strong>
                  <small>Suggested clips</small>
                </div>
              </div>
              <div className="heat-legend">
                <span />
                <div>
                  <small>Quiet moment</small>
                  <small>High potential</small>
                </div>
              </div>
              <h4 className="section-label">MOMENTS TO EXPLORE</h4>
              <div className="heat-reasons">
                {[...heatmap]
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 3)
                  .map((point, i) => (
                    <button key={i} onClick={() => onSeek(point.start)}>
                      <span>
                        {timeLabel(point.start)} <ArrowUpRight size={12} />
                      </span>
                      <p>{point.reason}</p>
                      <b>{point.score}</b>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div className="empty-moments compact">
              <Flame size={30} />
              <p>
                Analyze this video to reveal its potential. Results will appear
                here and on your timeline.
              </p>
            </div>
          )}
          <button
            className="button primary full"
            disabled={!!busy}
            onClick={onAnalyze}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}{" "}
            {busy || "Analyze my video"}
          </button>
          <button
            className="reanalyze-button"
            disabled={!!busy}
            onClick={onAuto}
          >
            <Scissors size={12} /> Auto-trim the best 60 seconds
          </button>
        </div>
      )}
    </section>
  );
}
