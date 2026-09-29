import type { ChatMessage } from "../server.js";
import type { LaunchConfig } from "../config.js";
import type { LocalModel } from "../models.js";
import type { UiTheme } from "./theme.js";

export interface AssistantResult {
  finishReason?: string;
  tokPerSecond?: number;
  tokens?: number;
  /** Wall time for prompt prefill plus model thinking before the first token. */
  thoughtMs?: number;
  /** True when the user aborted generation with Esc. */
  interrupted?: boolean;
}

export interface AssistantStream {
  pushThinking(token: string): void;
  push(token: string): void;
  done(detail?: AssistantResult): void;
}

export interface ChatView {
  user(text: string): void;
  notice(text: string): void;
  startAssistant(): AssistantStream;
}

export interface HubControl {
  setHubStatus(text: string): void;
  enterChat(): void;
}

export interface PresetStore {
  loadPreset(id: string): Partial<LaunchConfig> | undefined;
  savePreset(id: string, cfg: LaunchConfig): void;
}

export interface UiDeps {
  config: LaunchConfig;
  localModels: LocalModel[];
  getServerStatus: () => string;
  getBaseUrl: () => string;
  onSend: (transcript: ChatMessage[], chat: ChatView, signal: AbortSignal) => void;
  onConfigChange: (next: LaunchConfig) => void;
  onRefreshModels: () => LocalModel[];
  skipModelScreen: boolean;
  onHubConfirm: (cfg: LaunchConfig, hub: HubControl) => void;
  onQuit?: () => void;
  presetStore?: PresetStore;
  mouse?: boolean;
}

export interface UiHandles extends ChatView {
  setContext(used?: number, total?: number): void;
  setRequestStats(tokPerSecond?: number): void;
  setStatus(text: string): void;
  destroy(): void;
}

export type Screen = "splash" | "models" | "edit" | "manual" | "keybinds" | "chat";

export interface AppUiOptions {
  splashMinMs?: number;
  splashTickMs?: number;
  perfIntervalMs?: number;
  thinkingTickMs?: number;
  theme?: UiTheme;
}

export type { UiTheme };
