from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[1]
KEY = ROOT / "private" / "pearlwallet-release.jks"
PROPERTIES = ROOT / "android" / "release-signing.properties"
KEYTOOL = Path(r"D:\Program Files\wolfram\SystemFiles\Java\Windows-x86-64\bin\keytool.exe")

if KEY.exists() or PROPERTIES.exists():
    raise SystemExit("Release signing material already exists; refusing to replace it")
KEY.parent.mkdir(parents=True, exist_ok=True)
password = secrets.token_urlsafe(32)
subprocess.run([
    str(KEYTOOL), "-genkeypair", "-v", "-keystore", str(KEY),
    "-alias", "pearlwallet", "-keyalg", "RSA", "-keysize", "4096",
    "-validity", "10000", "-storepass", password, "-keypass", password,
    "-dname", "CN=Pearl Wallet, OU=Mobile, O=Pearl Wallet, C=CN",
], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PROPERTIES.write_text(
    f"storeFile={KEY.as_posix()}\nstorePassword={password}\nkeyAlias=pearlwallet\nkeyPassword={password}\n",
    encoding="utf-8",
)
print("Release signing key created. Back up private/pearlwallet-release.jks and android/release-signing.properties together.")
