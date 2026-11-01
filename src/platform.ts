// Everything that needs the desktop shell. In a plain browser (npm run dev)
// these fall back to browser behaviour or do nothing, so the UI can be
// developed without building the Windows app.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn(`[platform] ${what} failed`, e);
  }
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/**
 * How much bigger the page is drawn than the window's own pixels. Windows'
 * "Text size" setting (Accessibility) enlarges the whole web view, e.g. 1.1
 * at 110%, so a 720 px layout needs a 792 px window.
 */
async function pageZoom(w: Awaited<ReturnType<typeof currentWindow>>): Promise<number> {
  const inner = (await w.innerSize()).toLogical(await w.scaleFactor());
  const zoom = window.innerWidth > 0 ? inner.width / window.innerWidth : 1;
  return Number.isFinite(zoom) && zoom > 0.5 && zoom < 4 ? Math.round(zoom * 100) / 100 : 1;
}

/** Size the window to fit a layout of `width` x `height` CSS pixels. */
export function setWindowSize(width: number, height: number): Promise<void> {
  return safely('resize', async () => {
    if (!isTauri) return;
    const { LogicalSize } = await import('@tauri-apps/api/dpi');
    const w = await currentWindow();
    const zoom = await pageZoom(w);
    // Users can't resize the widget, but some window managers also refuse
    // programmatic resizes of a fixed-size window, so unlock it briefly.
    await w.setResizable(true);
    await w.setSize(new LogicalSize(Math.ceil(width * zoom), Math.ceil(height * zoom)));
    await w.setResizable(false);
  });
}

/** Keep the widget underneath normal windows, like a desktop gadget. */
export function setKeepBehind(on: boolean): Promise<void> {
  return safely('always-on-bottom', async () => {
    if (!isTauri) return;
    await (await currentWindow()).setAlwaysOnBottom(on);
  });
}

export function syncAutostart(on: boolean): Promise<void> {
  return safely('autostart', async () => {
    if (!isTauri) return;
    const autostart = await import('@tauri-apps/plugin-autostart');
    const enabled = await autostart.isEnabled();
    if (on && !enabled) await autostart.enable();
    if (!on && enabled) await autostart.disable();
  });
}

export function notify(title: string, body: string): Promise<void> {
  return safely('notification', async () => {
    if (isTauri) {
      const n = await import('@tauri-apps/plugin-notification');
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === 'granted';
      if (granted) n.sendNotification({ title, body });
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') new Notification(title, { body });
  });
}

export function openExternal(url: string): Promise<void> {
  return safely('open link', async () => {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  });
}

/** Events sent by the tray menu (see src-tauri/src/lib.rs). */
export function onTray(event: 'tray-refresh' | 'tray-settings', handler: () => void): Promise<void> {
  return safely(`listen ${event}`, async () => {
    if (!isTauri) return;
    const { listen } = await import('@tauri-apps/api/event');
    await listen(event, () => handler());
  });
}

export function showWindow(): Promise<void> {
  return safely('show', async () => {
    if (!isTauri) return;
    const w = await currentWindow();
    await w.show();
  });
}
