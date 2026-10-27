import { useEffect, useState } from "react";
import { diagnosticsStatus, exportDiagnostics } from "../lib/diagnostics";
import { useLanguage } from "../lib/i18n";

/**
 * Shown on launch when the previous session didn't end cleanly.
 *
 * "Didn't end cleanly" covers a crash, but also a freeze the user ended
 * from the Task Manager — no crash handler sees that one, but the
 * session marker does. This is the moment the user still remembers what
 * happened, so it's when to ask for the report.
 */
export default function CrashNotice() {
  const pt = useLanguage() !== "en";
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    diagnosticsStatus().then((s) => {
      if (s?.previousSessionCrashed) setVisible(true);
    });
  }, []);

  if (!visible) return null;

  const doExport = async () => {
    setBusy(true);
    setError(null);
    try {
      setExportedTo(await exportDiagnostics());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-[22rem] card shadow-2xl text-sm">
      <div className="font-semibold mb-1">
        {pt ? "O Lúmina fechou de forma inesperada" : "Lúmina closed unexpectedly"}
      </div>
      {!exportedTo ? (
        <>
          <p className="text-slate-300 mb-3">
            {pt
              ? "Na última vez, o app travou ou fechou sozinho. Exporte o diagnóstico e envie o arquivo para o suporte — ajuda a encontrar o problema."
              : "Last time, the app froze or closed on its own. Export the diagnostics and send the file to support — it helps find the problem."}
          </p>
          {error && <p className="text-red-400 text-xs mb-2 break-all">{error}</p>}
          <div className="flex gap-2">
            <button className="btn-primary flex-1" onClick={doExport} disabled={busy}>
              {busy
                ? pt
                  ? "Exportando…"
                  : "Exporting…"
                : pt
                ? "Exportar diagnóstico"
                : "Export diagnostics"}
            </button>
            <button className="btn-ghost" onClick={() => setVisible(false)}>
              {pt ? "Agora não" : "Not now"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-slate-300 mb-1">
            {pt
              ? "Arquivo salvo na Área de Trabalho. Envie-o para o suporte:"
              : "File saved to your Desktop. Send it to support:"}
          </p>
          <p className="text-xs text-slate-400 break-all mb-3">{exportedTo}</p>
          <button className="btn-primary w-full" onClick={() => setVisible(false)}>
            OK
          </button>
        </>
      )}
    </div>
  );
}
