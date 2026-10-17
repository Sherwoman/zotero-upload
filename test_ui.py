"""Exercise the real view in installed Edge, with read-only fixture data and no dependencies."""
import html
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = Path.home() / "AppData/Local/Temp/upload_ui_110_preview_20261015"
EDGE = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")

FIXTURE = r'''
const candidate = { key: "ABCDEFGH", title: "CDM protection of a 3D TSV memory IC", DOI: "10.1109/example.2024", date: "2024", reusable: true, reasons: ["DOI 一致，题名相符"] };
const rows = [
  { id: "duplicate", metadata: { title: "CDM protection of a 3D TSV memory IC with a wide I/O data bus", DOI: candidate.DOI, date: "2024", creators: [{ firstName: "Makoto", lastName: "Nagata" }], provenance: "PDF 首页 DOI 与题名已核对" }, candidates: [candidate] },
  { id: "new", metadata: { title: "Stress-aware device simulation for advanced three-dimensional integration", DOI: "10.1109/example.2025", date: "2025", creators: [{ firstName: "Wei", lastName: "Zhang" }], provenance: "PDF 首页 DOI + 公开题录" }, candidates: [] },
  { id: "conflict", metadata: { title: "ESD protection devices inside the TSV keep-out zone", DOI: "10.1109/example.other", date: "2023" }, candidates: [{ ...candidate, reusable: false, reasons: ["DOI 不同：保留各自版本，禁止复用原条目"] }] },
  { id: "ambiguous", metadata: { title: "Two matching records require a manual choice" }, candidates: [candidate, { ...candidate, key: "IJKLMNOP" }] },
  { id: "error", metadata: { title: "A PDF that could not be read" }, candidates: [], error: "PDF 无法读取，请检查文件。" },
  { id: "pdf", metadata: { title: "An independent PDF awaiting bibliographic metadata", conflict: true }, candidates: [] }
];
window.fixturePlan = { planId: "UI-FIXTURE-NEVER-A-REAL-PLAN", libraryID: 1, collectionKeys: ["PGXSYWTD"], rows: rows.map(r => ({
  ...r, rowId: r.id, path: "C:\\Literature\\" + r.id + ".pdf", sourceKey: null,
  recommended: UploadCore.defaultDecision(r).action, recommendedTargetKey: UploadCore.defaultDecision(r).targetKey || null
})) };
window.commitCalls = [];
window.arguments = [{
  context: () => ({ libraryID: 1, collectionKeys: ["PGXSYWTD"], collections: [
    { key: "ROOTROOT", name: "求实创新" }, { key: "ESDESDES", name: "ESD", parentKey: "ROOTROOT" }, { key: "PGXSYWTD", name: "KOZ", parentKey: "ESDESDES" }
  ], pending: [structuredClone(window.fixturePlan)] }),
  refreshExpiredPending: async () => {},
  commit: async data => { window.commitCalls.push(data); return { results: data.decisions.map(d => ({ rowId: d.rowId, action: d.action, key: d.targetKey || "NEWITEM1" })), remaining: 0 }; }
}];
window.addEventListener("DOMContentLoaded", () => setTimeout(async () => {
  try {
    const check = (condition, message) => { if (!condition) throw Error(message); };
    const ui = window.UploadUI;
    const expected = ["reuse:ABCDEFGH", "new", "skip", "skip", "skip", "new"];
    check(JSON.stringify(ui.choices.map(c => c.action.value)) === JSON.stringify(expected), "Wrong default selections");
    check(commitCalls.length === 0, "Preview committed automatically");
    check(!document.querySelector("details[open]"), "Details should be collapsed");
    check(document.getElementById("collection").disabled, "Preview destination must be locked");
    ui.choices[0].action.value = "skip"; ui.updateSummary();
    check(document.getElementById("commit").textContent.includes("2"), "Summary not updated after manual choice");
    ui.choices[0].action.value = expected[0]; ui.updateSummary();
    await ui.commit();
    check(commitCalls.length === 1, "Commit should occur only on explicit call");
    check(commitCalls[0].decisions[0].targetKey === "ABCDEFGH" && commitCalls[0].decisions[1].action === "new", "Wrong commit decisions");
    ui.plans = [structuredClone(fixturePlan)]; ui.render();
    const title = ui.plans[0].rows[4].metadata.title;
    ui.plans[0].rows[4].metadata.title = "<img src=x onerror=alert(1)>"; ui.render();
    check(!document.querySelector(".rows img"), "Untrusted metadata rendered as HTML");
    ui.plans[0].rows[4].metadata.title = title; ui.render();
    ui.status("预览完成。重复文献默认仅加分类，新文献默认新增；核对后确认执行。");
    check(document.documentElement.scrollWidth <= innerWidth + 1, "Horizontal overflow");
    check(document.querySelector(".footer").getBoundingClientRect().bottom <= innerHeight + 1, "Footer overflow");
    document.body.dataset.testResult = JSON.stringify({ pass: true, defaults: expected, noAutomaticWrites: true, explicitCommitVerified: true,
      detailsCollapsed: true, safeMetadataRendering: true, width: innerWidth, dark: matchMedia("(prefers-color-scheme: dark)").matches });
  } catch (error) { document.body.dataset.testResult = JSON.stringify({ pass: false, error: String(error.stack || error) }); }
}, 100));
'''


def main():
    OUT.mkdir(exist_ok=True)
    source = (ROOT / "content/review.xhtml").read_text(encoding="utf-8")
    source = re.sub(r"<\?xml[^>]*\?>", "<!doctype html>", source)
    source = re.sub(r'<link[^>]*href="chrome:[^"]*"[^>]*/>', "", source)
    source = source.replace('<link rel="stylesheet" href="review.css"/>', "<style>" + (ROOT / "content/review.css").read_text(encoding="utf-8") + "</style>")
    scripts = "<script>" + (ROOT / "core.js").read_text(encoding="utf-8") + "</script><script>" + FIXTURE + "</script><script>" + (ROOT / "content/review.js").read_text(encoding="utf-8") + "</script>"
    source = source.replace('<script src="review.js" defer="defer"></script>', scripts)
    page = OUT / "preview.html"
    page.write_text(source, encoding="utf-8")
    results = []
    for name, size, flags in [("light", "960,760", []), ("dark", "960,760", ["--force-dark-mode"]), ("compact", "620,760", [])]:
        args = [str(EDGE), "--headless", "--disable-gpu", "--disable-background-networking", "--disable-sync", "--no-first-run", "--no-default-browser-check",
                "--user-data-dir=" + str(OUT / (name + "-profile")), "--window-size=" + size, "--force-device-scale-factor=1", "--virtual-time-budget=1800",
                "--screenshot=" + str(OUT / (name + ".png")), "--dump-dom", *flags, page.as_uri()]
        process = subprocess.run(args, capture_output=True, timeout=45, creationflags=subprocess.CREATE_NO_WINDOW)
        dom = process.stdout.decode("utf-8", errors="replace")
        match = re.search(r'data-test-result="([^"]+)"', dom)
        if not match:
            raise AssertionError(name + ": no DOM test result; " + process.stderr.decode(errors="replace")[-1200:])
        result = json.loads(html.unescape(match.group(1)))
        assert result["pass"], result
        if name == "dark":
            assert result["dark"], "Dark theme was not exercised"
        result["view"] = name
        results.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    (OUT / "verification.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(OUT)


if __name__ == "__main__":
    main()
