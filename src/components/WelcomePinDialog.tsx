import { useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { IconCheck, IconLock, IconTv } from "./icons";

export default function WelcomePinDialog() {
  const t = useT();
  const setAdultPin = useAppStore((s) => s.setAdultPin);
  const markOnboarded = useAppStore((s) => s.markOnboarded);

  const [mode, setMode] = useState<"ask" | "pin" | "done">("ask");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dismiss = async () => {
    await markOnboarded();
  };

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
    setMode("done");
    // auto-close after a moment
    setTimeout(() => {
      markOnboarded();
    }, 1400);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md card relative">
        <div className="flex items-center gap-2 mb-4">
          <IconTv className="text-accent w-6 h-6" />
          <h2 className="text-xl font-semibold">{t("welcome.title")}</h2>
        </div>

        {mode === "ask" && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
              <IconLock className="text-amber-400 shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-amber-200">{t("welcome.pinQuestion")}</div>
                <div className="text-xs text-slate-400 mt-1">{t("welcome.pinDesc")}</div>
              </div>
            </div>

            <div className="flex gap-2">
              <button onClick={dismiss} className="btn-ghost flex-1">
                {t("welcome.notNow")}
              </button>
              <button onClick={() => setMode("pin")} className="btn-primary flex-1">
                <IconLock /> {t("welcome.yesSetPin")}
              </button>
            </div>
          </div>
        )}

        {mode === "pin" && (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-slate-400">{t("pin.desc")}</p>
            <div>
              <label className="text-xs text-slate-400 block mb-1">{t("pin.newPin")}</label>
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                maxLength={8}
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                className="input tabular-nums text-center text-lg tracking-widest"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">{t("pin.confirmPin")}</label>
              <input
                type="password"
                inputMode="numeric"
                maxLength={8}
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                className="input tabular-nums text-center text-lg tracking-widest"
              />
            </div>
            {error && <div className="text-sm text-red-400">{error}</div>}
            <div className="flex gap-2">
              <button type="button" onClick={dismiss} className="btn-ghost flex-1">
                {t("welcome.notNow")}
              </button>
              <button type="submit" disabled={saving} className="btn-primary flex-1">
                {saving ? t("pin.saving") : t("pin.activate")}
              </button>
            </div>
          </form>
        )}

        {mode === "done" && (
          <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 flex items-center gap-3">
            <IconCheck />
            <span>{t("welcome.pinSetSuccess")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
