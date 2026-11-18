import { useRef, useState, useEffect } from "react";
import {
  AudioLines,
  Captions,
  ChevronRight,
  GripVertical,
  Scissors,
  Sparkles,
} from "lucide-react";
import { clamp, parseTime, timeLabel } from "../lib/editor";
import type { Project, Settings } from "../types";

export function TimeField({
  label,
  value,
  onChange,
  max,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  max: number;
  min?: number;
}) {
  const [text, setText] = useState(timeLabel(value, true));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(timeLabel(value, true));
    setInvalid(false);
  }, [value]);
  function submit() {
    const n = parseTime(text);
    if (n === null || n < min || n > max) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(n);
  }
  return (
    <label
      className={`time-field ${invalid ? "invalid" : ""}`}
      title={
        invalid
          ? `Use a time between ${timeLabel(min, true)} and ${timeLabel(max, true)}`
          : undefined
      }
    >
      <span>{label}</span>
      <input
        aria-label={`${label} time`}
        aria-invalid={invalid}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={submit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setText(timeLabel(value, true));
            setInvalid(false);
          }
        }}
      />
    </label>
  );
}
export function Timeline({
  project,
  currentTime,
  onSeek,
  onSettings,
  onHeatmap,
}: {
  project: Project;
  currentTime: number;
  onSeek: (n: number) => void;
  onSettings: (s: Partial<Settings>) => void;
  onHeatmap: () => void;
}) {
  const { asset, settings: s, heatmap } = project;
  const track = useRef<HTMLDivElement>(null);
  const duration = asset.duration || 1;
  const startPct = (s.start / duration) * 100,
    endPct = (s.end / duration) * 100;
  const thumbs = asset.thumbnails?.length
    ? asset.thumbnails
    : Array.from({ length: 10 }, () => asset.thumbnail || "");
  const at = (x: number) => {
    const box = track.current!.getBoundingClientRect();
    return clamp(((x - box.left) / box.width) * duration, 0, duration);
  };
  function drag(
    e: React.PointerEvent<HTMLButtonElement>,
    which: "start" | "end",
  ) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const element = e.currentTarget;
    const move = (event: PointerEvent) => {
      const pos = Math.round(at(event.clientX) * 10) / 10;
      onSettings(
        which === "start"
          ? { start: clamp(pos, Math.max(0, s.end - 180), s.end - 0.25) }
          : {
              end: clamp(
                pos,
                s.start + 0.25,
                Math.min(duration, s.start + 180),
              ),
            },
      );
    };
    const end = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
      element.removeEventListener("pointercancel", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
    element.addEventListener("pointercancel", end);
  }
  const points = heatmap.length
    ? heatmap.map((p) => [
        clamp(((p.start + p.end) / 2 / duration) * 1000, 0, 1000),
        36 - (clamp(p.score, 0, 100) / 100) * 32,
      ])
    : [];
  const line = points.length
    ? `M0 ${points[0][1]} ` +
      points.map((p) => `L${p[0]} ${p[1]}`).join(" ") +
      ` L1000 ${points.at(-1)![1]}`
    : "";
  return (
    <section className="timeline-card" aria-label="Video timeline">
      <div className="timeline-heading">
        <div>
          <Scissors size={16} />
          <h3>Your timeline</h3>
          <span className="timeline-duration">
            {(s.end - s.start).toFixed(1).replace(".0", "")}s selected
          </span>
        </div>
        <div className="trim-fields">
          <TimeField
            label="In"
            value={s.start}
            max={s.end - 0.25}
            min={Math.max(0, s.end - 180)}
            onChange={(start) => onSettings({ start })}
          />
          <ChevronRight size={12} />
          <TimeField
            label="Out"
            value={s.end}
            max={Math.min(duration, s.start + 180)}
            min={s.start + 0.25}
            onChange={(end) => onSettings({ end })}
          />
        </div>
      </div>
      <div className="timeline-body">
        <div className="timeline-track-label">
          <button onClick={onHeatmap}>
            <Sparkles size={13} /> AI heatmap
          </button>
          <span>
            {project.source === "demo"
              ? "Sample predictions"
              : heatmap.length
                ? "AI predictions"
                : "Not analyzed yet"}
          </span>
        </div>
        <div className="timeline-tracks" ref={track}>
          <div className="heatmap-track" onClick={(e) => onSeek(at(e.clientX))}>
            {line ? (
              <svg
                viewBox="0 0 1000 40"
                preserveAspectRatio="none"
                aria-label="Predicted engagement across the video"
                role="img"
              >
                <defs>
                  <linearGradient id="heat-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#c1d97a" stopOpacity=".6" />
                    <stop offset="1" stopColor="#e9eddf" stopOpacity=".1" />
                  </linearGradient>
                  <linearGradient id="heat-line">
                    <stop offset="0" stopColor="#b0b7a5" />
                    <stop offset=".3" stopColor="#99b855" />
                    <stop offset=".6" stopColor="#d6ab57" />
                    <stop offset="1" stopColor="#91b54b" />
                  </linearGradient>
                </defs>
                <path d={`${line} L1000 40 L0 40Z`} fill="url(#heat-fill)" />
                <path
                  d={line}
                  fill="none"
                  stroke="url(#heat-line)"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : (
              <div className="unanalyzed-track">
                Connect AI to discover your strongest moments
              </div>
            )}
          </div>
          <div className="film-track" onClick={(e) => onSeek(at(e.clientX))}>
            {thumbs.map((src, i) => (
              <div className="film-thumb" key={i}>
                {src && <img src={src} alt="" draggable={false} />}
              </div>
            ))}
            <div
              className="track-dim"
              style={{ left: 0, width: `${startPct}%` }}
            />
            <div
              className="track-dim"
              style={{ left: `${endPct}%`, right: 0 }}
            />
            <div
              className="clip-range"
              style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
            >
              <span>
                <Scissors size={10} />{" "}
                {project.selectedClipId ? "Selected clip" : "Custom clip"}
              </span>
            </div>
            {(["start", "end"] as const).map((which) => (
              <button
                key={which}
                className={`trim-handle ${which}`}
                style={{
                  left: `${((which === "start" ? s.start : s.end) / duration) * 100}%`,
                }}
                aria-label={`${which === "start" ? "Start" : "End"} trim handle`}
                role="slider"
                aria-valuemin={
                  which === "start" ? Math.max(0, s.end - 180) : s.start + 0.25
                }
                aria-valuemax={
                  which === "start"
                    ? s.end - 0.25
                    : Math.min(duration, s.start + 180)
                }
                aria-valuenow={s[which]}
                aria-valuetext={timeLabel(s[which], true)}
                onPointerDown={(e) => drag(e, which)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                    e.preventDefault();
                    const n = s[which] + (e.key === "ArrowRight" ? 0.5 : -0.5);
                    onSettings(
                      which === "start"
                        ? {
                            start: clamp(
                              n,
                              Math.max(0, s.end - 180),
                              s.end - 0.25,
                            ),
                          }
                        : {
                            end: clamp(
                              n,
                              s.start + 0.25,
                              Math.min(duration, s.start + 180),
                            ),
                          },
                    );
                  }
                }}
              >
                <GripVertical size={13} />
              </button>
            ))}
          </div>
          <div className="caption-track">
            <Captions size={11} />
            <span>
              {s.showCaptions && project.captions.length
                ? `${project.captions.filter((c) => c.end > s.start && c.start < s.end).length} captions · ${s.subtitleStyle}`
                : "No captions in this clip"}
            </span>
            {s.musicId && (
              <span className="timeline-audio">
                <AudioLines size={11} /> Music
              </span>
            )}
            {s.voiceId && (
              <span className="timeline-audio">
                <AudioLines size={11} /> Voiceover
              </span>
            )}
          </div>
          <div
            className="timeline-playhead"
            style={{
              left: `${clamp((currentTime / duration) * 100, 0, 100)}%`,
            }}
          >
            <span />
          </div>
          <div className="time-ruler">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>{timeLabel((duration * i) / 6)}</span>
            ))}
          </div>
        </div>
      </div>
      <footer className="timeline-footer">
        <span>
          <span className="tiny-dot" /> Drag the handles to make it yours
        </span>
        <span>
          Original video is always preserved <CheckMark />
        </span>
      </footer>
    </section>
  );
}
function CheckMark() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3 8 3 3 7-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
