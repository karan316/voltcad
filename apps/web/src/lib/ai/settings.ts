/**
 * AI provider settings — user supplies an OpenAI-compatible endpoint + key.
 * Stored ONLY in localStorage (never sent to any VoltCAD server).
 */
export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const KEY = "voltcad.ai";

export const DEFAULT_AI_SETTINGS: AiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
};

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_AI_SETTINGS;
    return { ...DEFAULT_AI_SETTINGS, ...(JSON.parse(raw) as Partial<AiSettings>) };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

export function aiConfigured(settings = loadAiSettings()): boolean {
  return settings.apiKey.trim().length > 0 && settings.baseUrl.trim().length > 0;
}
