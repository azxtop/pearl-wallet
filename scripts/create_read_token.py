from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parents[1]
frontend = ROOT / ".env.production.local"
backend = ROOT / "deploy" / ".env"
if frontend.exists() or backend.exists():
    raise SystemExit("Read token already exists; refusing to replace it")
token = secrets.token_urlsafe(48)
frontend.write_text(f"VITE_SAFETRADE_READ_TOKEN={token}\n", encoding="utf-8")
backend.write_text(f"PEARL_READ_TOKEN={token}\n", encoding="utf-8")
print("Read token created for app and server")
