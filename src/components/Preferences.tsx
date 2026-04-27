import { useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import type { DateFormat, Language, Theme, TimeFormat } from "../types";
import { IconClose, IconGear, IconLock, IconUnlock } from "./icons";

interface Props {
  onClose?: () => void;
}

export default function Preferences({ onClose }: Props) {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

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

        <div className="flex items-center gap-2 mb-4">
          <IconGear className="text-accent" />
          <h2 className="text-xl font-semibold">{t("settings.preferences")}</h2>
        </div>

        <div className="max-h-[65vh] overflow-y-auto pr-1">
          <Row label={t("settings.language")}>
            <select
              value={settings.language}
              onChange={(e) => updateSettings({ language: e.target.value as Language })}
              className="input !w-auto !py-1 !text-sm"
            >
              <option value="pt">{t("settings.languagePt")}</option>
              <option value="en">{t("settings.languageEn")}</option>
            </select>
          </Row>

          <Row label={t("settings.theme")}>
            <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
              {(["classic", "modern"] as Theme[]).map((theme) => (
                <button
                  key={theme}
                  onClick={() => updateSettings({ theme })}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${
                    settings.theme === theme ? "bg-accent text-white" : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  {theme === "classic" ? t("settings.themeClassic") : t("settings.themeModern")}
                </button>
              ))}
            </div>
          </Row>

          <Row label={t("settings.dateFormat")}>
            <select
              value={settings.dateFormat}
              onChange={(e) => updateSettings({ dateFormat: e.target.value as DateFormat })}
              className="input !w-auto !py-1 !text-sm"
            >
              <option value="ddmmyyyy">DD/MM/AAAA</option>
              <option value="mmddyyyy">MM/DD/AAAA</option>
              <option value="iso">AAAA-MM-DD</option>
            </select>
          </Row>

          <Row label={t("settings.timeFormat")}>
            <div className="flex gap-1 bg-white/5 rounded-lg p-0.5">
              {(["24h", "12h"] as TimeFormat[]).map((tf) => (
                <button
                  key={tf}
                  onClick={() => updateSettings({ timeFormat: tf })}
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${
                    settings.timeFormat === tf ? "bg-accent text-white" : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  {tf === "24h" ? "24h" : "12h"}
                </button>
              ))}
            </div>
          </Row>

          <Row label={t("settings.showEpg")} desc={t("settings.showEpgDesc")}>
            <Toggle
              checked={settings.showEpg}
              onChange={(v) => updateSettings({ showEpg: v })}
            />
          </Row>

          <div className="pt-4 mt-2 border-t border-white/5">
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-slate-200">
              <IconLock className="text-amber-400" />
              {t("settings.adultPin")}
            </h3>
            <PinSection />
          </div>
        </div>

        <div className="flex gap-2 pt-4">
          <button onClick={onClose} className="btn-primary flex-1">
            {t("settings.back")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-white/5">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-200">{label}</div>
        {desc && <div className="text-[11px] text-slate-500 mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-white/10"
      }`}
      aria-checked={checked}
      role="switch"
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function PinSection() {
  const t = useT();
  const settings = useAppStore((s) => s.settings);
  const setAdultPin = useAppStore((s) => s.setAdultPin);
  const hasPin = settings.adultPinHash !== null;

  const [mode, setMode] = useState<"idle" | "new" | "confirm-remove">("idle");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{4,8}$/.test(newPin)) {
      setError(t("pin.errRange"));
      return;
    }
    if (newPin !== confirmPin) {
      setError(t("pin.errMismatch"));
      return;
    }
    setSaving(true);
    await setAdultPin(newPin);
    setSaving(false);
    setMode("idle");
    setNewPin("");
    setConfirmPin("");
  };

  const remove = async () => {
    await setAdultPin(null);
    setMode("idle");
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-400">{t("pin.desc")}</div>

      {hasPin && mode === "idle" && (
        <div className="space-y-2">
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center gap-2">
            <IconUnlock />
            {t("pin.active")}
          </div>
          <button
            onClick={() => setMode("confirm-remove")}
            className="w-full btn-ghost !text-red-300 hover:!bg-red-500/10 text-sm"
          >
            {t("pin.removePin")}
          </button>
        </div>
      )}

      {hasPin && mode === "confirm-remove" && (
        <div className="space-y-2">
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
            {t("pin.removeTitle")}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setMode("idle")} className="btn-ghost flex-1 text-sm">
              {t("settings.cancel")}
            </button>
            <button onClick={remove} className="btn-primary flex-1 !bg-red-500 hover:!bg-red-400 text-sm">
              {t("pin.yesRemove")}
            </button>
          </div>
        </div>
      )}

      {!hasPin && mode === "idle" && (
        <button onClick={() => setMode("new")} className="w-full btn-primary text-sm">
          <IconLock /> {t("pin.activate")}
        </button>
      )}

      {!hasPin && mode === "new" && (
        <form onSubmit={submit} className="space-y-2">
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">{t("pin.newPin")}</label>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              maxLength={8}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              className="input tabular-nums text-center tracking-widest"
            />
          </div>
          <div>
            <label className="text-[11px] text-slate-400 block mb-1">{t("pin.confirmPin")}</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className="input tabular-nums text-center tracking-widest"
            />
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setMode("idle");
                setNewPin("");
                setConfirmPin("");
                setError(null);
              }}
              className="btn-ghost flex-1 text-sm"
            >
              {t("settings.cancel")}
            </button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 text-sm">
              {saving ? t("pin.saving") : t("pin.activate")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
