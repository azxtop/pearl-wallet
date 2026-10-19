import { Capacitor } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";

// Either surface reporting background is enough to lock. Wait for both to
// report foreground before allowing a fresh authorization.
export function observeWalletLifecycle(onBackground: () => void, onForeground: () => void): () => void {
  let nativeInactive = false;
  let background = false;
  let disposed = false;
  const update = () => {
    if (disposed) return;
    const next = document.hidden || nativeInactive;
    if (next === background) return;
    background = next;
    if (next) onBackground();
    else onForeground();
  };
  document.addEventListener("visibilitychange", update);
  const listener = Capacitor.isNativePlatform()
    ? NativeApp.addListener("appStateChange", ({ isActive }) => { nativeInactive = !isActive; update(); }).catch(() => null)
    : null;
  update();
  return () => {
    disposed = true;
    document.removeEventListener("visibilitychange", update);
    void listener?.then((handle) => handle?.remove()).catch(() => {});
  };
}
