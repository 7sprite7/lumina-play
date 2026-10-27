// Desktop "picture-in-picture" for the native mpv path.
//
// The browser PiP API only works on a <video> element, and on Windows
// the video isn't in one: mpv paints into its own top-level window owned
// by the app. So PiP here means turning the APP WINDOW itself into a
// small, borderless, always-on-top mini player in a screen corner — the
// mpv popup follows, since it tracks the window's moves and resizes.
//
// Everything changed on the way in is recorded and put back on the way
// out: size, position, maximised/fullscreen state, decorations, the
// always-on-top flag, and the window's minimum size (tauri.conf.json
// sets 960x600, which would otherwise refuse to shrink to a mini player).

/** Video area of the mini player, 16:9. */
export const MINI_W = 480;
export const MINI_VIDEO_H = 270;
/**
 * Control strip under the video. Permanent rather than hover-revealed:
 * the controls can't be drawn over the mpv surface, so revealing them
 * would shrink the video and letterbox it on every mouse move.
 */
export const MINI_STRIP_H = 36;
const MARGIN = 16;
/** Keep in sync with tauri.conf.json `minWidth` / `minHeight`. */
const APP_MIN_W = 960;
const APP_MIN_H = 600;

interface SavedWindowState {
  fullscreen: boolean;
  maximized: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

let saved: SavedWindowState | null = null;

export function isMiniPlayerActive(): boolean {
  return saved !== null;
}

export async function enterMiniPlayer(): Promise<void> {
  if (saved) return;
  const { getCurrentWindow, currentMonitor, LogicalSize, PhysicalPosition } = await import(
    "@tauri-apps/api/window"
  );
  const win = getCurrentWindow();
  const [fullscreen, maximized, pos, size] = await Promise.all([
    win.isFullscreen(),
    win.isMaximized(),
    win.outerPosition(),
    win.outerSize(),
  ]);
  saved = { fullscreen, maximized, x: pos.x, y: pos.y, width: size.width, height: size.height };

  // Leave fullscreen / maximised first: a maximised window ignores setSize.
  if (fullscreen) await win.setFullscreen(false);
  if (maximized) await win.unmaximize();

  await win.setMinSize(null);
  await win.setDecorations(false);
  await win.setAlwaysOnTop(true);
  await win.setSize(new LogicalSize(MINI_W, MINI_VIDEO_H + MINI_STRIP_H));

  // Bottom-right of the monitor the app is on, inside the WORK area so it
  // doesn't land behind the taskbar.
  const monitor = await currentMonitor();
  if (monitor) {
    const scale = monitor.scaleFactor;
    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
    const w = Math.round(MINI_W * scale);
    const h = Math.round((MINI_VIDEO_H + MINI_STRIP_H) * scale);
    const m = Math.round(MARGIN * scale);
    await win.setPosition(
      new PhysicalPosition(
        area.position.x + area.size.width - w - m,
        area.position.y + area.size.height - h - m,
      ),
    );
  }
}

/**
 * @param restoreFullscreen false when leaving because the player is
 *   closing — going back to fullscreen over the catalogue would be wrong.
 */
export async function exitMiniPlayer(restoreFullscreen = true): Promise<void> {
  if (!saved) return;
  const state = saved;
  saved = null;
  const { getCurrentWindow, LogicalSize, PhysicalSize, PhysicalPosition } = await import(
    "@tauri-apps/api/window"
  );
  const win = getCurrentWindow();

  await win.setAlwaysOnTop(false);
  await win.setDecorations(true);
  await win.setMinSize(new LogicalSize(APP_MIN_W, APP_MIN_H));
  await win.setSize(new PhysicalSize(state.width, state.height));
  await win.setPosition(new PhysicalPosition(state.x, state.y));
  if (state.maximized) await win.maximize();
  if (state.fullscreen && restoreFullscreen) await win.setFullscreen(true);
}
