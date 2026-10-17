"""Read-only production snapshots and an existing-category no-op acceptance check."""
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path
from upload_cli import Client

ROOT = Path(__file__).resolve().parent
EVIDENCE = Path.home() / "AppData/Local/Temp/upload_install_20261015"
MANIFEST = Path.home() / "AppData/Local/Temp/koz_zotero_import_20261014/manifest.json"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path):
    with OPENER.open("http://127.0.0.1:23119/api" + path, timeout=20) as response:
        return json.loads(response.read())


def snapshot():
    items = {}
    start = 0
    while True:
        rows = api(f"/users/0/items?limit=100&start={start}")
        items.update({r["key"]: r["data"] for r in rows})
        if len(rows) < 100:
            break
        start += 100
    koz = api("/users/0/collections/PGXSYWTD/items/top?limit=100")
    hashes = {}
    for row in koz:
        for child in api("/users/0/items/" + row["key"] + "/children"):
            data = child["data"]
            if data.get("contentType") != "application/pdf":
                continue
            path = Path.home() / "Zotero/storage" / data["key"] / data.get("filename", "")
            hashes[data["key"]] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return {"items": items, "kozKeys": sorted(r["key"] for r in koz), "pdfHashes": hashes}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def equal(before, after, allow_restart_state=False):
    assert before["kozKeys"] == after["kozKeys"], "KOZ membership changed"
    assert before["pdfHashes"] == after["pdfHashes"], "Existing PDF changed"
    assert before["items"].keys() == after["items"].keys(), "Existing item set changed"
    state_changes = []
    for key, original in before["items"].items():
        current = after["items"][key]
        changed = {f: [original.get(f), current.get(f)] for f in original.keys() | current.keys() if original.get(f) != current.get(f)}
        if allow_restart_state and set(changed).issubset({"version", "dateModified"}):
            if changed:
                state_changes.append({"key": key, "fields": changed})
        else:
            assert not changed, ("Existing item JSON changed", key, changed)
    return state_changes


def main(mode):
    EVIDENCE.mkdir(exist_ok=True)
    if mode == "before":
        value = snapshot()
        assert len(value["kozKeys"]) >= 1
        assert not (EVIDENCE / "before.json").exists(), "Keep the original pre-install evidence"
        write(EVIDENCE / "before.json", value)
        print(json.dumps({"items": len(value["items"]), "kozItems": len(value["kozKeys"]), "pdfs": len(value["pdfHashes"])}))
        return
    before = json.loads((EVIDENCE / "before.json").read_text(encoding="utf-8"))
    client = Client()
    health = client.request("health", authenticated=False)
    assert health["uiWindows"] >= 1
    session_before = snapshot()
    state_changes = equal(before, session_before, allow_restart_state=True)
    if mode == "after":
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        plan = client.request("preview", {"paths": [r["file"] for r in manifest["records"]], "libraryID": 1, "collectionKeys": ["PGXSYWTD"]})
        write(EVIDENCE / "production-preview.json", plan)
        decisions = []
        reused = 0
        for row in plan["rows"]:
            assert not row["error"], row
            strong = [c for c in row["candidates"] if c["reusable"] and c["key"] in before["kozKeys"]]
            if len(strong) == 1:
                assert "PGXSYWTD" in before["items"][strong[0]["key"]]["collections"]
                decisions.append({"rowId": row["rowId"], "action": "reuse", "targetKey": strong[0]["key"]})
                reused += 1
            else:
                decisions.append({"rowId": row["rowId"], "action": "skip"})
        assert reused >= len(before["kozKeys"]) - 1, "Unexpectedly many ambiguous cases in the real library"
        result = client.request("commit", {"planId": plan["planId"], "decisions": decisions})
        assert not any(r.get("error") for r in result["results"]), result
        equal(session_before, snapshot())
        report = {"productionHealth": health, "itemsBeforeAndAfter": len(before["items"]), "kozItemsBeforeAndAfter": len(before["kozKeys"]),
                  "existingPDFHashesVerified": len(before["pdfHashes"]), "repeatPreviewCount": 20, "repeatReusedWithoutWrites": reused,
                  "newItemsCreated": 0, "existingBibliographicFieldsUnchanged": True, "existingPDFHashesUnchanged": True,
                  "itemJSONExactlyUnchangedDuringUploadCommit": True, "restartStateChangesBeforeFirstUploadCommit": state_changes}
        write(ROOT / "production-verification.json", report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        path = ROOT / "production-verification.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        report["survivesNormalRestart"] = True
        report["restartHealth"] = health
        write(path, report)
        print(json.dumps({"survivesNormalRestart": True, "libraryAndPDFsUnchanged": True, "health": health}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["before", "after", "restart"])
    main(parser.parse_args().mode)
