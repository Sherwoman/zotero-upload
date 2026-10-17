/* One-time read-only view check, only packaged for the isolated test profile. */
async function startup() {
  if (!PathUtils.profileDir.endsWith("upload_plugin_test_20261014\\profile")) throw new Error("UI check refused outside isolated profile");
  const resultPath = Services.dirsvc.get("TmpD", Ci.nsIFile).path + "\\upload_ui_110_preview_20261015\\native-ui.json";
  let dialog;
  try {
    await Zotero.initializationPromise;
    const main = Zotero.getMainWindow();
    main.document.getElementById("zotero-upload-button").doCommand();
    for (let i = 0; i < 50; i++) {
      const windows = Services.wm.getEnumerator(null);
      while (windows.hasMoreElements()) {
        const window = windows.getNext();
        if (window.document.documentURI.startsWith("chrome://zotero-upload/") && window.document.getElementById("collection")) dialog = window;
      }
      if (dialog) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!dialog) throw new Error("Native Upload view did not initialize");
    const ui = dialog.UploadUI;
    const original = await Zotero.Items.getAll(1, true, false);
    const match = { key: "ABCDEFGH", title: "Duplicate fixture", DOI: "10.9999/example", reusable: true, reasons: ["DOI 一致，题名相符"] };
    const plan = ui.api.publicPlan({ id: "UI-ONLY-NOT-A-COMMIT-PLAN", libraryID: 1, collectionKeys: [], expires: Date.now() + 10000, rows: [
      { id: "reuse", path: "C:\\fixture.pdf", metadata: { title: "Existing-paper fixture" }, candidates: [match] },
      { id: "new", path: "C:\\fixture2.pdf", metadata: { title: "New-paper fixture" }, candidates: [] },
      { id: "conflict", path: "C:\\fixture3.pdf", metadata: { title: "Different DOI fixture" }, candidates: [{ ...match, reusable: false }] }
    ] });
    ui.plans = [plan]; ui.render();
    const defaults = ui.choices.map(c => c.action.value);
    if (JSON.stringify(defaults) !== JSON.stringify(["reuse:ABCDEFGH", "new", "skip"])) throw new Error("Incorrect native defaults: " + JSON.stringify(defaults));
    const doc = dialog.document, rowStyle = dialog.getComputedStyle(doc.querySelector(".row"));
    if (rowStyle.borderRadius !== "8px") throw new Error("Native stylesheet was not applied");
    if (doc.querySelector(".footer").getBoundingClientRect().bottom > dialog.innerHeight + 1) throw new Error("Native footer overflow");
    if (doc.querySelector(".content").scrollWidth > doc.querySelector(".content").clientWidth + 1) throw new Error("Native horizontal overflow");
    const current = await Zotero.Items.getAll(1, true, false);
    if (original.length !== current.length) throw new Error("UI preview changed item count");
    await IOUtils.writeUTF8(resultPath, JSON.stringify({ pass: true, defaults, nativeCSS: true, nativeTheme: rowStyle.backgroundColor,
      detailsCollapsed: !doc.querySelector("details[open]"), noLibraryWrites: true, title: doc.title }, null, 2));
  } catch (error) { await IOUtils.writeUTF8(resultPath, JSON.stringify({ pass: false, error: String(error), stack: error.stack })); }
  finally { if (dialog && !dialog.closed) dialog.close(); }
}
function shutdown() {}
function install() {}
function uninstall() {}
