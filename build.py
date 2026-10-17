"""Build a native Zotero XPI without external packages."""
import zipfile
import json
from pathlib import Path

root = Path(__file__).resolve().parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
target = root / f"Upload-{version}.xpi"
files = ["manifest.json", "bootstrap.js", "core.js", "upload.js", "content/review.xhtml", "content/review.css", "content/review.js", "content/upload.svg"]
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for filename in files:
        archive.write(root / filename, filename)
print(target)
