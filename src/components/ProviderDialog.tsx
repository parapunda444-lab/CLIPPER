import { useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  PlugZap,
} from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { DEFAULT_PROVIDER } from "../types";
import type { Provider } from "../types";
export function ProviderDialog({
  provider,
  onSave,
  onClose,
}: {
  provider: Provider;
  onSave: (p: Provider) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(provider);
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const preset = value.baseUrl.includes("api.openai.com")
    ? "openai"
    : value.baseUrl.includes("api.groq.com")
      ? "groq"
      : "custom";
  function update(key: keyof Provider, val: string) {
    setValue((v) => ({ ...v, [key]: val }));
    setResult("");
    setError("");
  }
  async function test() {
    setTesting(true);
    setError("");
    setResult("");
    try {
      await api("/api/ai/test", { provider: value });
      setResult("Connection verified. Your provider is ready.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  return (
    <Modal
      title="Your AI. Your creative edge."
      eyebrow="AI CONNECTION"
      onClose={onClose}
    >
      <p className="modal-intro">
        Connect an OpenAI-compatible provider for transcription, clip discovery
        and voiceovers.
      </p>
      <div className="provider-options">
        {["openai", "groq", "custom"].map((id) => (
          <button
            key={id}
            className={preset === id ? "selected" : ""}
            onClick={() => {
              setResult("");
              setError("");
              setValue(
                id === "openai"
                  ? { ...DEFAULT_PROVIDER, apiKey: "" }
                  : id === "groq"
                    ? {
                        baseUrl: "https://api.groq.com/openai/v1",
                        apiKey: "",
                        model: "llama-3.3-70b-versatile",
                        transcriptionModel: "whisper-large-v3-turbo",
                        voiceModel: "canopylabs/orpheus-v1-english",
                      }
                    : { ...value, baseUrl: "", apiKey: "" },
              );
            }}
          >
            <span>{id === "openai" ? "◎" : id === "groq" ? "g" : "⌘"}</span>
            {id === "openai" ? "OpenAI" : id === "groq" ? "Groq" : "Custom"}
            {preset === id && <Check size={13} />}
          </button>
        ))}
      </div>
      <label className="field-label" htmlFor="base-url">
        API base URL
      </label>
      <input
        id="base-url"
        type="url"
        className="text-input"
        placeholder="https://your-provider.com/v1"
        value={value.baseUrl}
        onChange={(e) => update("baseUrl", e.target.value)}
      />
      <label className="field-label" htmlFor="api-key">
        API key <LockKeyhole size={12} />
      </label>
      <div className="input-with-icon">
        <KeyRound size={16} />
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          placeholder="Paste your provider API key"
          value={value.apiKey}
          onChange={(e) => update("apiKey", e.target.value)}
        />
      </div>
      <p className="help-text">
        Kept in memory for this tab only. Never saved to your project or browser
        storage.
      </p>
      <button
        className={`advanced-toggle ${advanced ? "open" : ""}`}
        onClick={() => setAdvanced(!advanced)}
      >
        Model settings <ChevronDown size={15} />
      </button>
      {advanced && (
        <div className="model-fields">
          {(
            [
              ["model", "Clip analysis model"],
              ["transcriptionModel", "Transcription model"],
              ["voiceModel", "Voice model"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                className="text-input"
                value={value[key]}
                onChange={(e) => update(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      )}
      <div className="notice">
        <PlugZap size={17} />
        <p>
          You’re in control. AI requests run only when you choose them and may
          incur charges from your provider. Predictions are not real audience
          analytics.
        </p>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {result && (
        <p className="success-box" role="status">
          <Check size={15} />
          {result}
        </p>
      )}
      <div className="modal-actions">
        <button
          className="button secondary"
          disabled={testing || !value.apiKey || !value.baseUrl}
          onClick={() => void test()}
        >
          {testing ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <PlugZap size={16} />
          )}{" "}
          Test connection
        </button>
        <button
          className="button primary"
          disabled={testing || !value.apiKey || !value.baseUrl || !value.model}
          onClick={() => onSave(value)}
        >
          Save for this session <Check size={16} />
        </button>
      </div>
      <a
        className="subtle-link"
        href="https://platform.openai.com/api-keys"
        target="_blank"
        rel="noreferrer"
      >
        Manage your OpenAI keys <ExternalLink size={12} />
      </a>
    </Modal>
  );
}
