"""Isolated test fixtures and authenticated integration checks; never writes production data."""
import argparse
import hashlib
import http.client
import json
import shutil
import sqlite3
import time
import urllib.request
import zipfile
from pathlib import Path
from upload_cli import Client

ROOT = Path(__file__).resolve().parent
TEST = Path.home() / "AppData/Local/Temp/upload_plugin_test_20261014"
OLD = Path.home() / "AppData/Local/Temp/koz_zotero_import_20261014"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare():
    assert not TEST.exists(), "Keep previous evidence; use a fresh explicitly verified test directory"
    profile, data = TEST / "profile", TEST / "data"
    profile.mkdir(parents=True)
    data.mkdir()
    shutil.copy2(OLD / "zotero_before_approved_import.sqlite", data / "zotero.sqlite")
    manifest = json.loads((OLD / "manifest.json").read_text(encoding="utf-8"))
    existing = next(r for r in manifest["records"] if r.get("existingKey"))
    write_json(TEST / "fixture.json", existing)
    with sqlite3.connect(data / "zotero.sqlite") as db:
        existing_keys = [r["existingKey"] for r in manifest["records"] if r.get("existingKey")]
        placeholders = ",".join("?" for _ in existing_keys)
        query = "SELECT i.key,a.path FROM itemAttachments a JOIN items i USING(itemID) JOIN items p ON p.itemID=a.parentItemID WHERE p.key IN (" + placeholders + ")"
        for key, attachment_path in db.execute(query, existing_keys):
            source = Path.home() / "Zotero/storage" / key
            if source.is_dir():
                shutil.copytree(source, data / "storage" / key)
    prefs = {"extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(data),
             "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
             "extensions.zotero.httpServer.enabled": True, "extensions.zotero.httpServer.port": 23121,
             "extensions.zotero.httpServer.localAPI.enabled": True, "marionette.port": 2829,
             "upload.suppressPrompts": True}
    (profile / "prefs.js").write_text("\n".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()) + "\n", encoding="utf-8")
    addon = json.loads((ROOT / "manifest.json").read_text())
    addon["name"] = "Upload isolated fixture"
    addon["applications"]["zotero"]["id"] = "upload-fixture@local.codex"
    with zipfile.ZipFile(TEST / "fixture.xpi", "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(addon))
        z.write(ROOT / "test_seed.js", "bootstrap.js")
    print(json.dumps({"profile": str(profile), "data": str(data), "existingKey": existing["existingKey"]}))


def wait_file(name, timeout=30):
    path = TEST / name
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        if (TEST / "seed-error.txt").exists():
            raise RuntimeError((TEST / "seed-error.txt").read_text())
        time.sleep(0.5)
    raise TimeoutError(name)


def api(path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:23121/api" + path, timeout=20) as response:
        return json.loads(response.read())


def count():
    return len(api("/users/0/items/top?limit=100&start=0")) + len(api("/users/0/items/top?limit=100&start=100")) + len(api("/users/0/items/top?limit=100&start=200")) + len(api("/users/0/items/top?limit=100&start=300")) + len(api("/users/0/items/top?limit=100&start=400"))


def rejection(client, route, body, expected, **kwargs):
    try:
        client.request(route, body, **kwargs)
    except RuntimeError as error:
        assert f"HTTP {expected}" in str(error), error
    except http.client.RemoteDisconnected:
        # Zotero rejects an untrusted Origin before dispatching our endpoint.
        assert expected == 403 and kwargs.get("extra_headers", {}).get("Origin")
    else:
        raise AssertionError("Unsafe request accepted")


def run():
    client = Client(TEST / "profile")
    ready = wait_file("seed-ready.json")
    fixture = json.loads((TEST / "fixture.json").read_text(encoding="utf-8"))
    manifest = json.loads((OLD / "manifest.json").read_text(encoding="utf-8"))
    before = count()
    result = {"health": client.request("health", authenticated=False), "beforeCount": before}
    rejection(client, "commit", {"planId": "x", "decisions": []}, 401, authenticated=False)
    rejection(client, "context", {}, 403, extra_headers={"Origin": "https://example.com"})
    rejection(client, "commit", {"planId": "x", "decisions": [], "overwrite": True}, 400)
    rejection(client, "commit", {"planId": "x", "decisions": [{"rowId": "r", "action": "replace"}]}, 400)
    result["unsafeRequestsRejected"] = True
    canonical_key = fixture["existingKey"]
    original = api("/users/0/items/" + canonical_key)["data"]
    originals = {r["existingKey"]: api("/users/0/items/" + r["existingKey"])["data"] for r in manifest["records"] if r.get("existingKey")}
    hashes = {a["path"]: hashlib.sha256(Path(a["path"]).read_bytes()).hexdigest() for a in ready["canonical"]["attachments"] if a["path"] and Path(a["path"]).exists()}
    assert hashes, "Need an existing PDF for preservation test"
    # Preview the whole real KOZ package against a pre-import library clone.
    preview = client.request("preview", {"paths": [r["file"] for r in manifest["records"]], "libraryID": 1, "collectionKeys": [ready["collectionKey"]]})
    write_json(TEST / "preview.json", preview)
    assert count() == before, "Preview created entries"
    decisions = []
    ambiguous = []
    for row, expected in zip(preview["rows"], manifest["records"]):
        assert not row["error"], row
        strong = [c for c in row["candidates"] if c["reusable"]]
        if expected.get("existingKey"):
            if strong:
                assert any(c["key"] == expected["existingKey"] for c in strong), (expected["title"], row)
                decisions.append({"rowId": row["rowId"], "action": "reuse", "targetKey": expected["existingKey"]})
            else:
                assert any(c["key"] == expected["existingKey"] for c in row["candidates"]), row
                decisions.append({"rowId": row["rowId"], "action": "skip"})
                ambiguous.append(expected["title"])
        else:
            assert not strong, (expected["title"], row)
            decisions.append({"rowId": row["rowId"], "action": "new"})
    committed = client.request("commit", {"planId": preview["planId"], "decisions": decisions})
    write_json(TEST / "committed.json", committed)
    assert len(committed["results"]) == 20 and not any(r.get("error") for r in committed["results"]), committed
    reused = sum(r["action"] == "reuse" for r in committed["results"])
    assert reused >= 8 and reused + len(ambiguous) == 9
    assert count() == before + 11, (before, count())
    after = api("/users/0/items/" + canonical_key)["data"]
    for key in original:
        if key not in ("collections", "version"):
            assert after.get(key) == original[key], (key, original[key], after.get(key))
    assert set(after["collections"]) == set(original["collections"]) | {ready["collectionKey"]}
    for path, digest in hashes.items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
    for key, metadata in originals.items():
        changed = api("/users/0/items/" + key)["data"]
        for field in metadata:
            if field not in ("collections", "version"):
                assert changed.get(field) == metadata[field], (key, field)
        assert set(metadata["collections"]).issubset(changed["collections"])
    for outcome, expected in zip(committed["results"], manifest["records"]):
        if outcome["action"] != "new":
            continue
        item_data = api("/users/0/items/" + outcome["key"])["data"]
        attachments = [item_data] if item_data["itemType"] == "attachment" else [r["data"] for r in api("/users/0/items/" + outcome["key"] + "/children") if r["data"]["itemType"] == "attachment"]
        assert len(attachments) == 1
        attachment = attachments[0]
        copied = TEST / "data/storage" / attachment["key"] / attachment["filename"]
        assert hashlib.sha256(copied.read_bytes()).digest() == hashlib.sha256(Path(expected["file"]).read_bytes()).digest()
    result.update({"previewCreatedZeroItems": True, "reused": reused, "ambiguousPreservedForReview": ambiguous,
                   "created": 11, "newPDFHashesVerified": True, "canonicalMetadataPreserved": True, "canonicalPDFHashesPreserved": True})
    write_json(TEST / "main-verified.json", {"result": result, "after": after, "hashes": hashes})
    # Ordinary native import: notifier must propose review, not silently mutate or trash.
    write_json(TEST / "native-request.json", {})
    verify_native(client, ready, fixture, result, after, hashes)


def verify_native(client, ready, fixture, result, after, hashes):
    canonical_key = fixture["existingKey"]
    native = wait_file("native-ready.json", 40)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        pending = client.request("context", {})["pending"]
        if len(pending) >= 2:
            break
        time.sleep(1)
    assert len(pending) >= 2, pending
    for new in native:
        plan = next(p for p in pending if p["rows"][0]["sourceKey"] == new["key"])
        row = plan["rows"][0]
        if new["conflict"]:
            assert not any(c["reusable"] for c in row["candidates"]), row
            rejection(client, "commit", {"planId": plan["planId"], "decisions": [{"rowId": row["rowId"], "action": "reuse", "targetKey": canonical_key}]}, 400)
            assert api("/users/0/items/" + new["key"])["data"].get("deleted", 0) == 0
        else:
            assert any(c["key"] == canonical_key and c["reusable"] for c in row["candidates"]), row
            native_result = client.request("commit", {"planId": plan["planId"], "decisions": [{"rowId": row["rowId"], "action": "reuse", "targetKey": canonical_key}]})
            assert native_result["results"][0]["newDuplicateTrashed"] == new["key"], native_result
            assert api("/users/0/items/" + new["key"])["data"]["deleted"] == 1
    write_json(TEST / "inspect-request.json", {})
    inspection = wait_file("inspect-result.json", 20)
    assert inspection["toolbar"] and inspection["toolsMenu"], inspection
    assert inspection.get("dialogStatus") and "Upload" in inspection.get("dialogTitle", ""), inspection
    final = api("/users/0/items/" + canonical_key)["data"]
    assert final == after, "Native duplicate handling changed original"
    for path, digest in hashes.items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
    result.update({"nativeImportPrompted": True, "differentDOIReuseRejected": True, "newDuplicateRecoverablyTrashed": True, "toolbarAndDialogVerified": True, "finalCount": count()})
    write_json(TEST / "verification.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def resume_native():
    client = Client(TEST / "profile")
    ready = wait_file("seed-ready.json")
    fixture = json.loads((TEST / "fixture.json").read_text(encoding="utf-8"))
    progress = TEST / "main-verified.json"
    if progress.exists():
        saved = json.loads(progress.read_text(encoding="utf-8"))
    else:
        # A prior run stopped in the native-notifier assertions after all 20
        # preview/commit/preservation/new-file checks had passed.
        committed = json.loads((TEST / "committed.json").read_text(encoding="utf-8"))
        assert len(committed["results"]) == 20 and not any(r.get("error") for r in committed["results"])
        saved = {"result": {"health": client.request("health", authenticated=False), "unsafeRequestsRejected": True,
                 "beforeCount": 447, "previewCreatedZeroItems": True, "reused": sum(r["action"] == "reuse" for r in committed["results"]),
                 "created": 11, "newPDFHashesVerified": True, "canonicalMetadataPreserved": True, "canonicalPDFHashesPreserved": True},
                 "after": api("/users/0/items/" + fixture["existingKey"])["data"],
                 "hashes": {a["path"]: hashlib.sha256(Path(a["path"]).read_bytes()).hexdigest() for a in ready["canonical"]["attachments"] if a["path"] and Path(a["path"]).exists()}}
    verify_native(client, ready, fixture, saved["result"], saved["after"], saved["hashes"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["prepare", "run", "resume-native"])
    args = parser.parse_args()
    {"prepare": prepare, "run": run, "resume-native": resume_native}[args.mode]()
