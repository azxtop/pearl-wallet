import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWalletLifecycle } from "./wallet-lifecycle";

const native = vi.hoisted(() => ({ enabled: false, addListener: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native.enabled } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: native.addListener } }));

function documentFixture(hidden = false) {
  const document = Object.assign(new EventTarget(), { hidden });
  vi.stubGlobal("document", document);
  return (next: boolean) => { document.hidden = next; document.dispatchEvent(new Event("visibilitychange")); };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); native.enabled = false; });

describe("wallet lifecycle", () => {
  it("locks immediately on background, requires a new foreground transition, and removes listeners", () => {
    const visibility = documentFixture();
    const background = vi.fn(), foreground = vi.fn();
    const dispose = observeWalletLifecycle(background, foreground);
    visibility(true);
    expect(background).toHaveBeenCalledOnce();
    visibility(true);
    expect(background).toHaveBeenCalledOnce();
    expect(foreground).not.toHaveBeenCalled();
    visibility(false);
    expect(foreground).toHaveBeenCalledOnce();
    dispose(); visibility(true);
    expect(background).toHaveBeenCalledOnce();
  });

  it("honors native background even while document is visible, and waits for both foreground signals", async () => {
    const visibility = documentFixture();
    native.enabled = true;
    let appState!: (event: { isActive: boolean }) => void;
    const remove = vi.fn();
    native.addListener.mockImplementation((_event, listener) => { appState = listener; return Promise.resolve({ remove }); });
    const background = vi.fn(), foreground = vi.fn();
    const dispose = observeWalletLifecycle(background, foreground);
    appState({ isActive: false });
    expect(background).toHaveBeenCalledOnce();
    visibility(true); appState({ isActive: true });
    expect(foreground).not.toHaveBeenCalled();
    visibility(false);
    expect(foreground).toHaveBeenCalledOnce();
    dispose(); await Promise.resolve(); await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    appState({ isActive: false });
    expect(background).toHaveBeenCalledOnce();
  });

  it("locks if mounted in background and cleans up native registration resolved after unmount", async () => {
    documentFixture(true); native.enabled = true;
    let register!: (handle: { remove: () => void }) => void;
    native.addListener.mockImplementation(() => new Promise((resolve) => { register = resolve; }));
    const background = vi.fn();
    const dispose = observeWalletLifecycle(background, vi.fn());
    expect(background).toHaveBeenCalledOnce();
    dispose(); const remove = vi.fn(); register({ remove });
    await Promise.resolve(); await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
  });
});
