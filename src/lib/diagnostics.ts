// Frontend side of crash/freeze diagnostics (see src-tauri/src/diagnostics.rs).
//
// JS errors used to go to the devtools console only — invisible in a
// release build. Everything here routes them into the same log file the
// Rust side writes, so an exported report has both halves of the story.

import { IS_TAURI } from "./platform";

export interface DiagnosticsStatus {
  previousSessionCrashed: boolean;
  logDir: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function diagnosticsStatus(): Promise<DiagnosticsStatus | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<DiagnosticsStatus>("diagnostics_status");
  } catch {
    return null;
  }
}

/** Writes a line into lumina.log. Never throws — logging must not crash. */
export function logToFile(level: "error" | "warn" | "info", message: string): void {
  if (!IS_TAURI) return;
  void invoke("log_frontend", { level, message }).catch(() => {});
}

/** Zips logs + crash dumps onto the Desktop; returns the file path. */
export async function exportDiagnostics(): Promise<string> {
  return invoke<string>("export_diagnostics");
}

export async function openLogDir(): Promise<void> {
  await invoke("open_log_dir");
}

/**
 * Global safety net for errors React can't see: exceptions thrown in
 * event handlers, timers, and rejected promises nobody awaited. Render
 * errors are caught by ErrorBoundary, which logs through logToFile too.
 */
export function installGlobalErrorHandlers(): void {
  if (!IS_TAURI) return;
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    const stack = e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : "";
    logToFile("error", `window.onerror: ${e.message}${where}${stack}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ""}` : String(e.reason);
    logToFile("error", `unhandled promise rejection: ${reason}`);
  });
  logToFile("info", `frontend started (${navigator.userAgent})`);
}
