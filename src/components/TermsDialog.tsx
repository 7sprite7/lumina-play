import { useLanguage } from "../lib/i18n";
import { IS_TAURI } from "../lib/platform";
import { termsFor } from "../lib/terms";

interface Props {
  /**
   * "accept": first run (or new terms version) — blocks the app until the
   * user accepts, with a way out that closes the app instead.
   * "view": opened from Preferences, just to read again.
   */
  mode: "accept" | "view";
  onAccept?: () => void;
  onClose?: () => void;
}

export default function TermsDialog({ mode, onAccept, onClose }: Props) {
  const language = useLanguage();
  const sections = termsFor(language);
  const pt = language !== "en";

  const quit = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (e) {
      console.warn("[Terms] close failed", e);
    }
  };

  return (
    // z above everything else, including the player and the PIN welcome:
    // nothing in the app should be usable before the terms are accepted.
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-2xl card flex flex-col max-h-[90vh]">
        <h2 className="text-xl font-semibold mb-1">
          {pt ? "Termos de uso" : "Terms of use"}
        </h2>
        <p className="text-sm text-slate-300 mb-4">
          {pt
            ? "O Lúmina Play é apenas um reprodutor. Ele não fornece nenhum conteúdo — tudo o que você assistir vem das listas que você mesmo adicionar."
            : "Lúmina Play is only a player. It provides no content — everything you watch comes from the lists you add yourself."}
        </p>

        <div className="flex-1 min-h-0 overflow-y-auto pr-2 space-y-4 text-sm">
          {sections.map((s) => (
            <section key={s.title}>
              <h3 className="font-semibold text-slate-100 mb-1">{s.title}</h3>
              <p className="text-slate-300 leading-relaxed">{s.body}</p>
            </section>
          ))}
        </div>

        <div className="flex gap-2 pt-4 mt-2 border-t border-white/5">
          {mode === "accept" ? (
            <>
              {/* No "decline and continue": the app is unusable without
                  agreeing, so the alternative is to leave. In a browser a
                  page can't close itself, so the button only exists in
                  the desktop app. */}
              {IS_TAURI && (
                <button onClick={quit} className="btn-ghost">
                  {pt ? "Não aceito — sair" : "I don't accept — quit"}
                </button>
              )}
              <button onClick={onAccept} className="btn-primary flex-1">
                {pt ? "Li e aceito os termos" : "I have read and accept the terms"}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="btn-primary flex-1">
              {pt ? "Fechar" : "Close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
