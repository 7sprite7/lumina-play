import { useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { IconClose, IconPlus, IconTrash } from "./icons";
import type { M3USource, Source, XtreamSource } from "../types";

interface Props {
  onClose?: () => void;
}

type Mode = "list" | "m3u" | "xtream" | "edit-m3u" | "edit-xtream";

function genId() {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function SourceManager({ onClose }: Props) {
  const sources = useAppStore((s) => s.sources);
  const activeSourceId = useAppStore((s) => s.activeSourceId);
  const addSource = useAppStore((s) => s.addSource);
  const removeSource = useAppStore((s) => s.removeSource);
  const updateSource = useAppStore((s) => s.updateSource);
  const setActiveSource = useAppStore((s) => s.setActiveSource);
  const t = useT();

  const [mode, setMode] = useState<Mode>("list");
  const [editing, setEditing] = useState<Source | null>(null);

  const startEdit = (source: Source) => {
    setEditing(source);
    setMode(source.type === "m3u" ? "edit-m3u" : "edit-xtream");
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-xl card relative">
        {onClose && (
          <button
            onClick={onClose}
            className="absolute top-3 right-3 text-slate-400 hover:text-slate-100"
            aria-label={t("player.close")}
          >
            <IconClose />
          </button>
        )}

        <h2 className="text-xl font-semibold mb-4">{t("settings.manageTitle")}</h2>

        {mode === "list" && (
          <>
            <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
              {sources.length === 0 && (
                <p className="text-slate-400 text-sm">{t("settings.noSources")}</p>
              )}
              {sources.map((s) => (
                <SourceRow
                  key={s.id}
                  source={s}
                  active={s.id === activeSourceId}
                  onSelect={async () => {
                    if (s.id !== activeSourceId) await setActiveSource(s.id);
                    onClose?.();
                  }}
                  onEdit={() => startEdit(s)}
                  onRemove={() => removeSource(s.id)}
                  removeLabel={t("source.confirmRemove", { name: s.name })}
                  editLabel={t("source.edit")}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={() => setMode("m3u")}>
                <IconPlus /> {t("settings.addM3U")}
              </button>
              <button className="btn-primary flex-1" onClick={() => setMode("xtream")}>
                <IconPlus /> {t("settings.addXtream")}
              </button>
            </div>
          </>
        )}

        {mode === "m3u" && (
          <M3UForm
            onCancel={() => setMode("list")}
            onSave={async (src) => {
              await addSource(src);
              setMode("list");
              onClose?.();
            }}
          />
        )}
        {mode === "xtream" && (
          <XtreamForm
            onCancel={() => setMode("list")}
            onSave={async (src) => {
              await addSource(src);
              setMode("list");
              onClose?.();
            }}
          />
        )}
        {mode === "edit-m3u" && editing?.type === "m3u" && (
          <M3UForm
            initial={editing}
            onCancel={() => {
              setMode("list");
              setEditing(null);
            }}
            onSave={async (src) => {
              await updateSource(src);
              setMode("list");
              setEditing(null);
            }}
          />
        )}
        {mode === "edit-xtream" && editing?.type === "xtream" && (
          <XtreamForm
            initial={editing}
            onCancel={() => {
              setMode("list");
              setEditing(null);
            }}
            onSave={async (src) => {
              await updateSource(src);
              setMode("list");
              setEditing(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function SourceRow({
  source,
  active,
  onSelect,
  onEdit,
  onRemove,
  removeLabel,
  editLabel,
}: {
  source: Source;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onRemove: () => void;
  removeLabel: string;
  editLabel: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
        active ? "border-accent bg-accent/10" : "border-bg-700 hover:bg-bg-700"
      }`}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{source.name}</div>
        <div className="text-xs text-slate-400 truncate">
          {source.type === "m3u" ? source.url : `${source.host} • ${source.username}`}
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-bg-700 text-slate-300">
        {source.type}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        className="text-slate-500 hover:text-sky-300"
        aria-label={editLabel}
        title={editLabel}
      >
        <IconPencil />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(removeLabel)) onRemove();
        }}
        className="text-slate-500 hover:text-red-400"
        aria-label="Remove"
      >
        <IconTrash />
      </button>
    </div>
  );
}

function IconPencil({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}

function M3UForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: M3USource;
  onCancel: () => void;
  onSave: (src: M3USource) => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [epgUrl, setEpgUrl] = useState(initial?.epgUrl ?? "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !url.trim()) return;
        onSave({
          id: initial?.id ?? genId(),
          type: "m3u",
          name: name.trim(),
          url: url.trim(),
          epgUrl: epgUrl.trim() || undefined,
        });
      }}
      className="space-y-3"
    >
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t("source.name")}</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("source.myList")}
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t("source.m3uUrl")}</label>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://..."
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">
          {t("source.epgUrl")}{" "}
          <span className="text-slate-500">({t("source.optional")})</span>
        </label>
        <input
          className="input"
          value={epgUrl}
          onChange={(e) => setEpgUrl(e.target.value)}
          placeholder="http://.../xmltv.php"
        />
        <div className="text-[11px] text-slate-500 mt-1">
          {t("source.epgUrlHint")}
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onCancel}>
          {t("settings.cancel")}
        </button>
        <button type="submit" className="btn-primary flex-1">
          {t("settings.save")}
        </button>
      </div>
    </form>
  );
}

function XtreamForm({
  initial,
  onCancel,
  onSave,
}: {
  initial?: XtreamSource;
  onCancel: () => void;
  onSave: (src: XtreamSource) => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !host.trim() || !username.trim() || !password.trim()) return;
        let h = host.trim();
        if (!/^https?:\/\//.test(h)) h = `http://${h}`;
        onSave({
          id: initial?.id ?? genId(),
          type: "xtream",
          name: name.trim(),
          host: h,
          username: username.trim(),
          password: password.trim(),
        });
      }}
      className="space-y-3"
    >
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t("source.name")}</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("source.myServer")}
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">{t("source.host")}</label>
        <input
          className="input"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="http://servidor.com:8080"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-slate-400 block mb-1">{t("source.username")}</label>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">{t("source.password")}</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost flex-1" onClick={onCancel}>
          {t("settings.cancel")}
        </button>
        <button type="submit" className="btn-primary flex-1">
          {t("settings.save")}
        </button>
      </div>
    </form>
  );
}
