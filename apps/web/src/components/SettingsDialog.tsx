import { useState } from "react";
import { X } from "lucide-react";
import { DEFAULT_AI_SETTINGS, loadAiSettings, saveAiSettings } from "../lib/ai/settings.ts";

/**
 * AI provider settings — any OpenAI-compatible endpoint (OpenAI, Azure,
 * Ollama, vLLM, OpenRouter…). Stored in localStorage only.
 */
export function SettingsDialog(props: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState(loadAiSettings);

  if (!props.open) return null;

  const save = () => {
    saveAiSettings(settings);
    props.onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={props.onClose}
    >
      <div className="glass-panel w-96 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="micro-label !text-[11px]">AI Provider</span>
          <button className="icon-btn" onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>

        <label className="field-label">Base URL · OpenAI-compatible</label>
        <input
          className="field-input"
          placeholder={DEFAULT_AI_SETTINGS.baseUrl}
          value={settings.baseUrl}
          onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
          spellCheck={false}
        />

        <label className="field-label">API key</label>
        <input
          className="field-input"
          type="password"
          placeholder="sk-…"
          value={settings.apiKey}
          onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
        />

        <label className="field-label">Model</label>
        <input
          className="field-input"
          placeholder={DEFAULT_AI_SETTINGS.model}
          value={settings.model}
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
          spellCheck={false}
        />

        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          Requests stream directly from your browser to this endpoint. The key is stored locally
          and never sent anywhere else.
        </p>

        <button
          className="mt-4 w-full rounded-lg py-2 text-[13px] font-semibold transition-opacity hover:opacity-90"
          style={{ background: "var(--accent)", color: "var(--accent-contrast)" }}
          onClick={save}
        >
          Save
        </button>
      </div>
    </div>
  );
}
