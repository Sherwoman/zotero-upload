"""Authenticated loopback client. Preview is read-only; commit requires explicit decisions."""
import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path



def _default_profile():
    """Locate the Zotero profile that holds upload-local.json, else the first profile."""
    root = Path(os.environ.get("APPDATA", "")) / "Zotero/Zotero/Profiles"
    if root.is_dir():
        profiles = sorted(p for p in root.iterdir() if p.is_dir())
        for profile in profiles:
            if (profile / "upload-local.json").is_file():
                return profile
        if profiles:
            return profiles[0]
    return root / "default"


DEFAULT_PROFILE = _default_profile()


class Client:
    def __init__(self, profile=DEFAULT_PROFILE):
        self.access = json.loads((Path(profile) / "upload-local.json").read_text(encoding="utf-8"))
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        from urllib.parse import urlsplit
        url = urlsplit(self.access["baseURL"])
        if url.scheme != "http" or url.hostname != "127.0.0.1" or url.path != "/upload/v1":
            raise ValueError("Upload access file must point to the local loopback API")

    def request(self, route, data=None, authenticated=True, extra_headers=None):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["Authorization"] = "Bearer " + self.access["token"]
        headers.update(extra_headers or {})
        body = None if data is None else json.dumps(data).encode("utf-8")
        req = urllib.request.Request(self.access["baseURL"] + "/" + route, data=body, headers=headers)
        try:
            with self.opener.open(req, timeout=1200) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {error.code}: {detail}") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health")
    commands.add_parser("context")
    preview = commands.add_parser("preview")
    preview.add_argument("paths", nargs="+", type=Path)
    preview.add_argument("--library", type=int, default=1)
    preview.add_argument("--collection", action="append", default=[])
    preview.add_argument("--out", type=Path, required=True)
    commit = commands.add_parser("commit")
    commit.add_argument("decisions", type=Path, help="JSON with planId and explicit rowId/action/targetKey choices")
    args = parser.parse_args()
    client = Client(args.profile)
    if args.command == "preview":
        paths = []
        for path in args.paths:
            paths.extend(sorted(path.glob("*.pdf")) if path.is_dir() else [path])
        result = client.request("preview", {"paths": [str(p.resolve()) for p in paths], "libraryID": args.library, "collectionKeys": args.collection})
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"planId": result["planId"], "rows": len(result["rows"]), "reusable": sum(any(c["reusable"] for c in r["candidates"]) for r in result["rows"]), "output": str(args.out)}, ensure_ascii=False))
    elif args.command == "commit":
        print(json.dumps(client.request("commit", json.loads(args.decisions.read_text(encoding="utf-8"))), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(client.request(args.command, None if args.command == "health" else {}), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
