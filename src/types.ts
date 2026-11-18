export type Aspect = "9:16" | "16:9" | "1:1" | "original";
export type Effect = "none" | "cinematic" | "vivid" | "mono" | "warm";
export type SubtitleStyle = "pop" | "clean" | "outline";
export interface Asset {
  id: string;
  name: string;
  url: string;
  duration: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  thumbnails?: string[];
  hasAudio?: boolean;
}
export interface Caption {
  id: string;
  start: number;
  end: number;
  text: string;
}
export interface Clip {
  id: string;
  title: string;
  description: string;
  start: number;
  end: number;
  score: number;
  tags: string[];
  poster?: string;
}
export interface HeatPoint {
  start: number;
  end: number;
  score: number;
  reason: string;
}
export interface Settings {
  start: number;
  end: number;
  aspect: Aspect;
  cropX: number;
  effect: Effect;
  captions?: never;
  showCaptions: boolean;
  subtitleStyle: SubtitleStyle;
  callout: "none" | "subscribe" | "like";
  musicId: string | null;
  voiceId: string | null;
  musicVolume: number;
  sourceVolume: number;
  voiceVolume: number;
}
export interface Project {
  id: string;
  name: string;
  asset: Asset;
  captions: Caption[];
  clips: Clip[];
  heatmap: HeatPoint[];
  source: "demo" | "ai" | "manual";
  settings: Settings;
  selectedClipId: string | null;
  updatedAt: string;
  music?: Asset;
  voice?: Asset;
}
export interface Demo {
  asset: Asset;
  captions: Caption[];
  clips: Clip[];
  heatmap: HeatPoint[];
  thumbnails?: string[];
  music?: Asset;
}
export interface Provider {
  baseUrl: string;
  apiKey: string;
  model: string;
  transcriptionModel: string;
  voiceModel: string;
}
export interface ExportJob {
  id: string;
  status: "queued" | "processing" | "complete" | "error";
  progress: number;
  url?: string;
  error?: string;
  name?: string;
  createdAt?: string;
  duration?: number;
  aspect?: string;
}
export type Panel = "moments" | "transcript" | "heatmap";
export const DEFAULT_PROVIDER: Provider = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  transcriptionModel: "whisper-1",
  voiceModel: "gpt-4o-mini-tts",
};
