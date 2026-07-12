import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  PenLine,
  Plus,
  RotateCw,
  Scissors,
  Trash2,
} from "lucide-react";
import type { FeatureNode } from "@voltcad/model-api";
import { useEditorStore } from "../state/document-store.ts";
import { useSketchStore } from "../state/sketch-store.ts";
import { humanizeError } from "../lib/pretty.ts";
import { Checkbox } from "./ui/checkbox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectPositioner,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";

/**
 * MODEL tab — feature history + named parameters.
 * Clicking a feature expands an inline editor (expression fields commit on
 * blur/Enter so regen never runs per keystroke).
 */
export function ModelPanel() {
  const features = useEditorStore((s) => s.doc.features);
  const statuses = useEditorStore((s) => s.statuses);
  const activeId = useEditorStore((s) => s.activeFeatureId);
  const setActive = useEditorStore((s) => s.setActiveFeature);
  const removeFeature = useEditorStore((s) => s.removeFeature);
  const [pendingDelete, setPendingDelete] = useState<FeatureNode | null>(null);

  return (
    <div className="chat-scroll flex-1 overflow-y-auto">
      <div className="micro-label px-4 pt-4 pb-1">Features</div>
      {features.length === 0 && (
        <p className="px-4 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
          Empty part — insert a primitive from the toolbar or ask the copilot.
        </p>
      )}
      {features.map((f) => (
        <FeatureRow
          key={f.id}
          feature={f}
          status={statuses[f.id]?.status}
          error={statuses[f.id]?.error?.message}
          expanded={activeId === f.id}
          onToggle={() => setActive(activeId === f.id ? null : f.id)}
          onDelete={() => setPendingDelete(f)}
        />
      ))}
      <ParametersSection />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent className="glass-panel border-0">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Features that depend on it may fail to regenerate. This can be undone by
              re-adding the feature, but its references will need repair.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) removeFeature(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const FEATURE_ICONS: Record<string, typeof PenLine> = {
  sketch: PenLine,
  extrude: Plus,
  revolve: RotateCw,
  fillet: Scissors,
  chamfer: Scissors,
};

const OP_ITEMS: Record<string, string> = {
  new: "New body",
  add: "Add",
  cut: "Cut",
  intersect: "Intersect",
};

function FeatureRow(props: {
  feature: FeatureNode;
  status?: string;
  error?: string;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { feature: f } = props;
  const toggleSuppress = useEditorStore((s) => s.toggleSuppress);
  const Icon = FEATURE_ICONS[f.type] ?? Plus;
  const Chevron = props.expanded ? ChevronDown : ChevronRight;

  return (
    <div className="mx-2 mb-0.5 rounded-lg" style={props.expanded ? { background: "rgb(127 127 127 / 0.07)" } : undefined}>
      <div
        className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-[rgb(127_127_127/0.08)] ${f.suppressed ? "opacity-40" : ""}`}
        onClick={props.onToggle}
        onDoubleClick={() => {
          if (f.type === "sketch")
            useSketchStore.getState().begin({ kind: "datum", plane: "XY" }, f.id);
        }}
        title={f.type === "sketch" ? "Double-click to edit sketch" : undefined}
      >
        <Chevron size={13} style={{ color: "var(--text-muted)" }} />
        <Icon size={14} strokeWidth={1.7} style={{ color: "var(--text-secondary)" }} />
        <span className="flex-1 truncate">{f.name}</span>
        {props.status === "error" && <CircleAlert size={13} style={{ color: "var(--err)" }} />}
        <span className="hidden items-center gap-0.5 group-hover:flex">
          {f.type === "sketch" && (
            <button
              className="icon-btn"
              data-tip="Edit sketch"
              onClick={(e) => {
                e.stopPropagation();
                useSketchStore.getState().begin({ kind: "datum", plane: "XY" }, f.id);
              }}
            >
              <PenLine size={12} />
            </button>
          )}
          <button
            className="icon-btn"
            data-tip={f.suppressed ? "Unsuppress" : "Suppress"}
            onClick={(e) => {
              e.stopPropagation();
              toggleSuppress(f.id);
            }}
          >
            {f.suppressed ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            className="icon-btn"
            data-tip="Delete"
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete();
            }}
          >
            <Trash2 size={12} style={{ color: "var(--err)" }} />
          </button>
        </span>
      </div>
      {props.error && (
        <p className="px-8 pb-1.5 text-[11px] leading-snug" style={{ color: "var(--err)" }}>
          {humanizeError(props.error, useEditorStore.getState().doc)}
        </p>
      )}
      {props.expanded && <FeatureEditor feature={f} />}
    </div>
  );
}

function FeatureEditor({ feature: f }: { feature: FeatureNode }) {
  const update = useEditorStore((s) => s.updateFeatureParams);
  const rename = useEditorStore((s) => s.renameFeature);
  const params = f.params as Record<string, unknown>;
  const setField = (key: string, value: unknown) => update(f.id, { ...params, [key]: value });

  return (
    <div className="px-8 pb-3" onClick={(e) => e.stopPropagation()}>
      <label className="field-label">Name</label>
      <input className="field-input" value={f.name} onChange={(e) => rename(f.id, e.target.value)} />
      {(f.type === "extrude" || f.type === "revolve") && (
        <>
          <CommitField
            label={f.type === "extrude" ? "Distance · mm" : "Angle · deg"}
            value={String(params[f.type === "extrude" ? "distance" : "angle"] ?? "")}
            onCommit={(v) => setField(f.type === "extrude" ? "distance" : "angle", v)}
          />
          <label className="field-label">Result</label>
          <Select
            items={OP_ITEMS}
            value={String(params.op ?? "new")}
            onValueChange={(v) => setField("op", String(v))}
          >
            <SelectTrigger size="sm" className="w-full font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectPositioner>
              <SelectContent className="font-mono text-xs">
                {Object.entries(OP_ITEMS).map(([value, label]) => (
                  <SelectItem key={value} value={value} className="py-1 text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectPositioner>
          </Select>
          {f.type === "extrude" && (
            <label className="mt-2.5 flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              <Checkbox
                checked={Boolean(params.symmetric)}
                onCheckedChange={(v) => setField("symmetric", v === true)}
              />
              Symmetric
            </label>
          )}
        </>
      )}
      {f.type === "fillet" && (
        <CommitField
          label="Radius · mm"
          value={String(params.radius ?? "")}
          onCommit={(v) => setField("radius", v)}
        />
      )}
      {f.type === "chamfer" && (
        <CommitField
          label="Distance · mm"
          value={String(params.distance ?? "")}
          onCommit={(v) => setField("distance", v)}
        />
      )}
      {f.type === "sketch" && (
        <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          {(params.entities as unknown[])?.length ?? 0} entities on{" "}
          {(params.plane as { plane?: string })?.plane}
        </p>
      )}
    </div>
  );
}

function ParametersSection() {
  const parameters = useEditorStore((s) => s.doc.parameters);
  const setParameter = useEditorStore((s) => s.setParameter);
  const removeParameter = useEditorStore((s) => s.removeParameter);
  const [newName, setNewName] = useState("");

  return (
    <>
      <div className="micro-label px-4 pt-5 pb-1">Parameters</div>
      <div className="px-4 pb-6">
        {Object.entries(parameters).map(([name, value]) => (
          <div key={name} className="group mb-1.5 flex items-center gap-2">
            <span className="w-24 truncate font-mono text-[11px] font-medium" style={{ color: "var(--label)" }}>
              {name}
            </span>
            <CommitInline value={String(value)} onCommit={(v) => setParameter(name, v)} />
            <button className="icon-btn opacity-0 group-hover:opacity-100" data-tip="Remove" onClick={() => removeParameter(name)}>
              <Trash2 size={11} />
            </button>
          </div>
        ))}
        <div className="mt-2 flex items-center gap-2">
          <input
            className="field-input !mt-0"
            placeholder="new parameter…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
                setParameter(newName, 10);
                setNewName("");
              }
            }}
          />
        </div>
      </div>
    </>
  );
}

/** Expression input committing on blur/Enter. */
function CommitField(props: { label: string; value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(props.value);
  return (
    <>
      <label className="field-label">{props.label}</label>
      <CommitInline value={props.value} onCommit={props.onCommit} draft={draft} setDraft={setDraft} />
    </>
  );
}

function CommitInline(props: {
  value: string;
  onCommit: (v: string) => void;
  draft?: string;
  setDraft?: (v: string) => void;
}) {
  const [localDraft, setLocalDraft] = useState(props.value);
  const draft = props.draft ?? localDraft;
  const setDraft = props.setDraft ?? setLocalDraft;
  return (
    <input
      className="field-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== props.value && props.onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
