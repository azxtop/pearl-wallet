import subprocess
import xml.etree.ElementTree as ET
import shutil
import os
from pathlib import Path

ADB = shutil.which("adb")
if not ADB and os.environ.get("ANDROID_HOME"):
    candidate = Path(os.environ["ANDROID_HOME"]) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")
    if candidate.is_file():
        ADB = str(candidate)
if not ADB:
    raise SystemExit("adb was not found; add platform-tools to PATH or set ANDROID_HOME")
remote = "/data/local/tmp/pearl-window.xml"
subprocess.run([ADB, "shell", "uiautomator", "dump", remote], capture_output=True, check=True)
try:
    read = subprocess.run([ADB, "exec-out", "cat", remote], capture_output=True, check=True)
finally:
    subprocess.run([ADB, "shell", "rm", "-f", remote], capture_output=True, check=False)
output = read.stdout.decode("utf-8", errors="ignore")
start = output.find("<?xml")
end = output.find("</hierarchy>")
if start < 0 or end < 0:
    print("No UI hierarchy available")
    raise SystemExit(1)
root = ET.fromstring(output[start:end + len("</hierarchy>")])
allowed = {"重试", "链上数据暂不可用", "Wallet", "SafeTrade", "Setting", "Total Balance", "接收 PRL", "解锁钱包", "使用指纹"}
for node in root.iter("node"):
    label = node.attrib.get("text", "")
    if label in allowed:
        print(label, node.attrib.get("bounds", ""))
