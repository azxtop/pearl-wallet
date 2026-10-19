import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PROFILES_KEY } from "./lib/profiles";
import App from "./App";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("boots the actual App into recovery without exposing creation controls or overwriting unreadable ciphertext", () => {
  const original = '{"version":2,"profiles":[{"ciphertext":"recoverable-public-fixture"}';
  const values = new Map([[PROFILES_KEY, original]]);
  const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem, removeItem: vi.fn() });
  vi.stubGlobal("document", { hidden: false });
  // Effects do not run during this render; React warns about useLayoutEffect.
  vi.spyOn(console, "error").mockImplementation((message) => {
    if (!String(message).includes("useLayoutEffect")) throw new Error(String(message));
  });
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain("钱包数据需要恢复");
  expect(html).toContain("复制加密恢复数据");
  expect(html).not.toContain("创建钱包");
  expect(values.get(PROFILES_KEY)).toBe(original);
  expect(setItem.mock.calls.some(([key]) => key === PROFILES_KEY)).toBe(false);
});
