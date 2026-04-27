import { useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { IconClose, IconPlus, IconTrash } from "./icons";
import type { Source } from "../types";

interface Props {
  onClose?: () => void;
}

type Mode = "list" | "m3u" | "xtream";

function genId() {
  return `src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function SourceManager({ onClose }: Props) {
  const sources = useAppStore((s) => s.sources);
  const activeSourceId = useAppStore((s) => s.activeSourceId);
  const addSource = useAppStore((s) => s.addSource);
  const removeSource = useAppStore((s) => s.removeSource);
  const setActiveSource = useAppStore((s) => s.setActiveSource);
  const t = useT();

  const [mode, setMode] = useState<Mode>("list");

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
                  onRemove={() => removeSource(s.id)}
                  removeLabel={t("source.confirmRemove", { name: s.name })}
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
      </div>
    </div>
  );
}

function SourceRow({
  source,
  active,
  onSelect,
  onRemove,
  removeLabel,
}: {
  source: Source;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
  removeLabel: string;
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

function M3UForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (src: Source) => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !url.trim()) return;
        onSave({ id: genId(), type: "m3u", name: name.trim(), url: url.trim() });
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
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (src: Source) => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !host.trim() || !username.trim() || !password.trim()) return;
        let h = host.trim();
        if (!/^https?:\/\//.test(h)) h = `http://${h}`;
        onSave({
          id: genId(),
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
