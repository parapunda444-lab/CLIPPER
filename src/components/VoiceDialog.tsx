import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Check,
  FileAudio,
  LoaderCircle,
  Mic2,
  Play,
  Sparkles,
  Upload,
} from "lucide-react";
import { Modal } from "./Modal";
import { api, upload } from "../lib/api";
import type { Asset, Project, Provider } from "../types";
const voices = [
  ["coral", "Coral", "Warm & expressive", "C"],
  ["marin", "Marin", "Clear & natural", "M"],
  ["cedar", "Cedar", "Grounded & warm", "C"],
  ["alloy", "Alloy", "Balanced & versatile", "A"],
  ["ash", "Ash", "Calm & composed", "A"],
  ["ballad", "Ballad", "Smooth & melodic", "B"],
  ["echo", "Echo", "Crisp & confident", "E"],
  ["fable", "Fable", "Expressive storyteller", "F"],
  ["nova", "Nova", "Bright & energetic", "N"],
  ["onyx", "Onyx", "Rich & resonant", "O"],
  ["sage", "Sage", "Thoughtful & steady", "S"],
  ["shimmer", "Shimmer", "Light & upbeat", "S"],
  ["verse", "Verse", "Dynamic & engaging", "V"],
];
const groqEnglish = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];
const groqArabic = ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"];
const groqVoices = (arabic: boolean) =>
  (arabic ? groqArabic : groqEnglish).map((v) => [
    v,
    v[0].toUpperCase() + v.slice(1),
    "Orpheus voice",
    v[0].toUpperCase(),
  ]);
export function VoiceDialog({
  project,
  provider,
  onClose,
  onConnect,
  onGenerated,
}: {
  project: Project;
  provider: Provider;
  onClose: () => void;
  onConnect: () => void;
  onGenerated: (asset: Asset) => void;
}) {
  const isGroq = /^https:\/\/api\.groq\.com(?::443)?(?:\/|$)/i.test(
    provider.baseUrl,
  );
  const arabic =
    isGroq && provider.voiceModel === "canopylabs/orpheus-arabic-saudi";
  const options = isGroq ? groqVoices(arabic) : voices;
  const textLimit = isGroq ? 200 : 4000;
  const [voice, setVoice] = useState(options[0][0]);
  const [custom, setCustom] = useState("");
  const [speed, setSpeed] = useState("1");
  const script = () =>
    project.captions
      .filter(
        (c) => c.end > project.settings.start && c.start < project.settings.end,
      )
      .map((c) => c.text)
      .join(" ");
  const [text, setText] = useState(script().slice(0, textLimit));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      audio.current?.pause();
      abortRef.current?.();
    },
    [],
  );
  async function generate(preview = false) {
    if (!provider.apiKey) {
      onConnect();
      return;
    }
    setBusy(preview ? "preview" : "generate");
    setError("");
    audio.current?.pause();
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = () => controller.abort();
    try {
      const data = await api<{ asset: Asset }>(
        "/api/ai/voice",
        {
          provider,
          text: preview
            ? arabic
              ? "قصتك التالية تبدأ بلحظة تستحق أن تتذكرها."
              : "A little room to breathe. Your next great story starts with a single moment."
            : text,
          voice: custom.trim() || voice,
          speed: isGroq ? 1 : Number(speed),
        },
        controller.signal,
      );
      if (preview) {
        audio.current = new Audio(data.asset.url);
        audio.current.onended = () => setPlaying(false);
        await audio.current.play();
        setPlaying(true);
      } else onGenerated(data.asset);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy("");
      abortRef.current = null;
    }
  }
  async function uploadVoice(file?: File) {
    if (!file) return;
    if (file.size > 40 * 1024 * 1024) {
      setError("Choose an audio file smaller than 40 MB.");
      return;
    }
    setBusy("upload");
    setError("");
    const task = upload<{ asset: Asset }>("/api/media/audio", "audio", file);
    abortRef.current = task.abort;
    try {
      const result = await task.promise;
      onGenerated(result.asset);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy("");
      abortRef.current = null;
    }
  }
  return (
    <Modal
      wide
      title="Find your story’s voice."
      eyebrow="VOICEOVER STUDIO"
      onClose={onClose}
    >
      <p className="modal-intro">
        A voice that feels right. A story that stays with people.
      </p>
      <div className="voice-layout">
        <section>
          <div className="section-label">
            CHOOSE A VOICE <span>{options.length} voices</span>
          </div>
          <div className="voice-grid">
            {options.map(([id, name, description, letter], i) => (
              <button
                key={id}
                disabled={!!busy}
                className={`voice-option ${voice === id && !custom ? "selected" : ""}`}
                onClick={() => {
                  setVoice(id);
                  setCustom("");
                }}
              >
                <span className={`voice-avatar voice-color-${i % 5}`}>
                  {letter}
                </span>
                <span>
                  <b>{name}</b>
                  <small>{description}</small>
                </span>
                {voice === id && !custom && <Check size={14} />}
              </button>
            ))}
          </div>
          <label className="field-label" htmlFor="custom-voice">
            Or use a custom voice ID
          </label>
          <input
            id="custom-voice"
            className="text-input"
            placeholder="Your provider’s voice ID"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <p className="help-text">
            Voice availability depends on your speech model.
          </p>
        </section>
        <section className="voice-script">
          <div className="section-label">
            YOUR SCRIPT{" "}
            <button
              className="text-button"
              onClick={() => setText(script().slice(0, textLimit))}
            >
              Use captions
            </button>
          </div>
          <textarea
            aria-label="Voiceover script"
            maxLength={textLimit}
            placeholder="Write the words you want your audience to remember…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="script-count">
            <span>AI-generated voice</span>
            <span>
              {text.length.toLocaleString()} / {textLimit.toLocaleString()}
            </span>
          </div>
          <label className="field-label" htmlFor="voice-speed">
            Speaking speed
          </label>
          <select
            id="voice-speed"
            disabled={isGroq}
            className="text-input"
            value={speed}
            onChange={(e) => setSpeed(e.target.value)}
          >
            <option value="0.75">0.75× · Take it slow</option>
            <option value="1">1× · Natural pace</option>
            <option value="1.25">1.25× · A little energy</option>
            <option value="1.5">1.5× · Quick & punchy</option>
          </select>
          {isGroq && (
            <p className="help-text">
              Groq supports up to 200 characters at natural speed per voiceover.
            </p>
          )}
          <button
            className="button secondary full"
            disabled={!!busy}
            onClick={() => {
              if (playing) {
                audio.current?.pause();
                setPlaying(false);
              } else void generate(true);
            }}
          >
            {busy === "preview" ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={15} />
            )}{" "}
            {playing ? "Stop preview" : "Preview this voice"}
          </button>
          <div className="notice small">
            <AudioLines size={17} />
            <p>
              Preview and generation use your provider and may be billable. The
              generated audio becomes part of your MP4.
            </p>
          </div>
          {!provider.apiKey && (
            <button className="text-button" onClick={onConnect}>
              Connect AI to use these voices <Sparkles size={13} />
            </button>
          )}
        </section>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <input
          ref={uploadRef}
          className="sr-only"
          type="file"
          accept="audio/*"
          aria-label="Upload voiceover recording"
          onChange={(e) => void uploadVoice(e.target.files?.[0])}
        />
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => uploadRef.current?.click()}
        >
          {busy === "upload" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Upload size={16} />
          )}{" "}
          Upload recording
        </button>
        <button
          className="button primary"
          disabled={!!busy || !text.trim()}
          onClick={() => void generate()}
        >
          {busy === "generate" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Mic2 size={16} />
          )}{" "}
          {busy === "generate" ? "Creating voiceover…" : "Generate voiceover"}
        </button>
      </div>
      <div className="help-text inline-help">
        <FileAudio size={13} /> Voiceover starts at the beginning of your
        selected clip.
      </div>
    </Modal>
  );
}
