import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { exportDiagnostics, installGlobalErrorHandlers } from "./lib/diagnostics";
import { IS_TAURI } from "./lib/platform";
import "./index.css";

// Before anything renders, so an error during startup is captured too.
installGlobalErrorHandlers();

/**
 * Last-resort screen. Without a boundary at the root, a render error
 * outside the catalogue (which has its own) unmounts the whole tree and
 * leaves a black window — the "app crashed" reports with nothing to go
 * on. This keeps a way out: reload, or export the report.
 */
function RootCrashFallback({ error }: { error: Error }) {
  const [exported, setExported] = React.useState<string | null>(null);
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-4 p-8 text-center bg-[#0b0d12] text-slate-100">
      <div className="text-lg font-semibold">O Lúmina Play encontrou um erro.</div>
      <div className="text-sm text-slate-400 max-w-lg">
        Recarregue para continuar. Se acontecer de novo, exporte o diagnóstico e envie o arquivo
        para o suporte.
      </div>
      <div className="text-xs text-slate-500 max-w-xl break-all">{error.message}</div>
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Recarregar
        </button>
        {IS_TAURI && (
          <button
            className="btn-ghost"
            onClick={() => exportDiagnostics().then(setExported).catch(() => {})}
          >
            Exportar diagnóstico
          </button>
        )}
      </div>
      {exported && (
        <div className="text-xs text-slate-400 max-w-xl break-all">
          Arquivo salvo na Área de Trabalho: {exported}
        </div>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary fallback={(error) => <RootCrashFallback error={error} />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
