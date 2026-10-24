import { useEffect, useRef } from 'react';

export function UpdateNotice({ version, busy, error, onLater, onUpdate }: { version: string; busy: boolean; error: string; onLater: () => void; onUpdate: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="update-backdrop" onClick={onLater}>
    <div className="update-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-description" tabIndex={-1}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onLater(); }
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const target = event.shiftKey ? buttons.at(-1) : buttons[0];
          if (document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1)) || document.activeElement === dialog.current) { event.preventDefault(); target?.focus(); }
        }
      }}>
      <span className="update-version">v{version}</span>
      <h2 id="update-title">发现新版本</h2>
      <p id="update-description">新版 Pearl Wallet 已可下载。</p>
      {error && <p className="update-error" role="alert">{error}</p>}
      <div className="update-actions"><button type="button" onClick={onLater}>稍后</button><button type="button" className="primary" disabled={busy} onClick={onUpdate}>{busy ? '正在下载…' : '立即更新'}</button></div>
    </div>
  </div>;
}
