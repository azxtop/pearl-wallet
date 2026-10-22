import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// Exercise the real App handlers without rendering market/network effects.
const source = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) handlers.set(node.name.text, node.getText(source));
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "clearWalletSecrets" && node.initializer && ts.isCallExpression(node.initializer)) {
    handlers.set("clearWalletSecrets", node.initializer.arguments[0].getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("return observeWalletLifecycle(")) {
    handlers.set("lifecycleEffect", node.arguments[0].getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);

const secrets = ["ShowMnemonic", "BackupMnemonic", "BackupCheck", "Password", "PasswordAgain", "InputMnemonic",
  "BackupPassword", "FingerPassword", "OldPassword", "NewPassword", "AuthPassword", "WalletRemovalPassword"];

function fixture(requireUnlock = true) {
  const state = new Map<string, unknown>(secrets.map((name) => [name, "secret-test-fixture"]));
  const setters = Object.fromEntries([...secrets, "WalletRemovalOpen", "Preview", "PreviewScanSequence", "Busy", "WalletForeground",
    "Addresses", "FreshSnapshotKey", "WalletPage", "Recovery", "PendingAudit", "AutoFingerAttempted"].map((name) => [`set${name}`, vi.fn((value) => state.set(name, value))]));
  let background!: () => void, foreground!: () => void;
  const scope: Record<string, any> = {
    ...setters, document: { hidden: false }, walletBackground: { current: false }, walletAccessGeneration: { current: 0 },
    walletOperationSequence: { current: 0 }, secretRevealSequence: { current: 0 }, backupRevealTimer: { current: null },
    watchModeRef: { current: false }, UNLOCK_KEY: "test-unlock-setting", localStorage: { getItem: () => String(requireUnlock) },
    wallet: { lock: vi.fn(() => Promise.resolve({ ok: true })), export: vi.fn() },
    observeWalletLifecycle: (onBackground: () => void, onForeground: () => void) => { background = onBackground; foreground = onForeground; return vi.fn(); },
    activeTab: { current: "setting" }, blob: {}, backupPassword: "test-password", screenPrivacy: { setSecure: vi.fn() },
    run: async (action: () => Promise<void>) => action(),
    cleanupLegacyAfterAuthorization: vi.fn(() => true),
  };
  const handler = (name: string) => {
    expect(handlers.has(name)).toBe(true);
    const code = ts.transpile(`const handler = ${handlers.get(name)};`, { target: ts.ScriptTarget.ES2022 });
    return new Function(...Object.keys(scope), `${code}; return handler;`)(...Object.values(scope));
  };
  scope.clearWalletSecrets = handler("clearWalletSecrets");
  scope.accessCurrent = handler("accessCurrent");
  handler("lifecycleEffect")();
  return { scope, state, handler, background: () => background(), foreground: () => foreground() };
}

describe("App secret lifecycle and late authorization results", () => {
  it("immediately clears every secret and invalidates authorization on background, respecting public-balance preference", () => {
    for (const requireUnlock of [true, false]) {
      const app = fixture(requireUnlock);
      app.background();
      expect(app.scope.wallet.lock).toHaveBeenCalledOnce();
      expect(app.scope.walletAccessGeneration.current).toBe(1);
      expect(app.scope.accessCurrent(0)).toBe(false);
      expect(app.scope.accessCurrent(1)).toBe(false);
      for (const secret of secrets) expect(app.state.get(secret)).toBe("");
      expect(app.state.get("Preview")).toBeNull();
      expect(app.state.get("Busy")).toBe(false);
      expect(app.scope.setAddresses).toHaveBeenCalledTimes(requireUnlock ? 1 : 0);
      app.foreground();
      expect(app.scope.accessCurrent(0)).toBe(false);
      expect(app.scope.accessCurrent(1)).toBe(true);
      expect(app.state.get("ShowMnemonic")).toBe("");
    }
  });

  it("does not reveal a phrase if backgrounding happens while the native screen-protection call is pending", async () => {
    const app = fixture();
    let secure!: () => void;
    app.scope.wallet.export.mockResolvedValue({ mnemonic: "public-test-phrase" });
    app.scope.screenPrivacy.setSecure.mockImplementation(() => new Promise<void>((resolve) => { secure = resolve; }));
    const reveal = app.handler("exportMnemonic")();
    await Promise.resolve();
    expect(app.scope.screenPrivacy.setSecure).toHaveBeenCalledOnce();
    app.background(); secure(); await reveal;
    expect(app.state.get("ShowMnemonic")).toBe("");
    expect(app.scope.setShowMnemonic).not.toHaveBeenCalledWith("public-test-phrase");
  });

  it("manual lock clears the initial backup phrase and pending passwords as well", () => {
    const app = fixture();
    app.scope.setTab = vi.fn(); app.scope.setNotice = vi.fn();
    app.handler("lockWallet")();
    for (const secret of secrets) expect(app.state.get(secret)).toBe("");
    expect(app.scope.wallet.lock).toHaveBeenCalledOnce();
    expect(app.scope.accessCurrent(0)).toBe(false);
    expect(app.state.get("Recovery")).toBeNull();
    expect(app.state.get("PendingAudit")).toBeNull();
  });
});
