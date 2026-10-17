/* Only packaged into a one-time fixture add-on for the isolated test profile. */
var fixtureTimer;
async function startup() {
  await Zotero.initializationPromise;
  if (!PathUtils.profileDir.endsWith("upload_plugin_test_20261014\\profile")) throw new Error("Fixture refused outside isolated profile");
  const root = PathUtils.parent(PathUtils.profileDir);
  const fixture = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, "fixture.json")));
  async function snapshot(item) {
    const attachments = [];
    for (const id of item.getAttachments()) {
      const a = await Zotero.Items.getAsync(id); attachments.push({ json: a.toJSON(), path: await a.getFilePathAsync() });
    }
    return { json: item.toJSON(), attachments };
  }
  const canonical = await Zotero.Items.getByLibraryAndKeyAsync(1, fixture.existingKey);
  let collection = Zotero.Collections.getByLibrary(1).find(c => c.name === "Upload isolation test 20261014");
  if (!collection) { collection = new Zotero.Collection(); collection.libraryID = 1; collection.name = "Upload isolation test 20261014"; await collection.saveTx(); }
  await IOUtils.writeUTF8(PathUtils.join(root, "seed-ready.json"), JSON.stringify({ collectionKey: collection.key, canonical: await snapshot(canonical) }, null, 2));
  async function watch() {
    try {
      const stage = PathUtils.join(root, "native-request.json");
      if (await IOUtils.exists(stage) && !await IOUtils.exists(PathUtils.join(root, "native-ready.json"))) {
        const keys = [];
        for (const conflict of [false, true]) {
          const item = new Zotero.Item(Zotero.ItemTypes.getName(canonical.itemTypeID)); item.libraryID = 1;
          for (const field of ["title", "DOI", "date", "publicationTitle", "proceedingsTitle", "conferenceName", "journalAbbreviation"])
            if (canonical.getField(field)) item.setField(field, canonical.getField(field));
          if (conflict) item.setField("DOI", "10.9999/upload-test-different-version");
          item.setCreators(canonical.getCreators()); item.addToCollection(collection.id); await item.saveTx();
          await Zotero.Attachments.importFromFile({ file: fixture.file.replaceAll("/", "\\"), parentItemID: item.id, title: "PDF", contentType: "application/pdf" });
          keys.push({ key: item.key, conflict });
        }
        await IOUtils.writeUTF8(PathUtils.join(root, "native-ready.json"), JSON.stringify(keys));
      }
      const repair = PathUtils.join(root, "repair-native-request.json");
      if (await IOUtils.exists(repair)) {
        await IOUtils.remove(repair);
        const created = JSON.parse(await IOUtils.readUTF8(PathUtils.join(root, "native-ready.json")));
        for (const record of created) {
          const item = await Zotero.Items.getByLibraryAndKeyAsync(1, record.key);
          if (item.id <= canonical.id || item.deleted) throw new Error("Not a live new fixture item");
          for (const field of ["conferenceName", "journalAbbreviation"])
            if (canonical.getField(field)) item.setField(field, canonical.getField(field));
          await item.saveTx();
        }
      }
      const inspect = PathUtils.join(root, "inspect-request.json");
      if (await IOUtils.exists(inspect)) {
        await IOUtils.remove(inspect);
        const window = Zotero.getMainWindow();
        const report = { canonical: await snapshot(canonical),
          toolbar: !!window?.document.getElementById("zotero-upload-button"),
          toolsMenu: !!window?.document.getElementById("zotero-upload-menu") };
        // Exercise the real XHTML view and controller, without clicking file-picker UI.
        window?.document.getElementById("zotero-upload-button")?.doCommand();
        await new Promise(resolve => setTimeout(resolve, 1000));
        const dialog = Services.wm.getMostRecentWindow("");
        report.dialogTitle = dialog?.document.title;
        report.dialogStatus = dialog?.document.getElementById("status")?.textContent;
        report.dialogRows = dialog?.document.querySelectorAll(".row").length;
        if (dialog?.document.documentURI?.startsWith("chrome://zotero-upload/")) dialog.close();
        await IOUtils.writeUTF8(PathUtils.join(root, "inspect-result.json"), JSON.stringify(report, null, 2));
      }
    } catch (error) { await IOUtils.writeUTF8(PathUtils.join(root, "seed-error.txt"), String(error) + "\n" + error.stack); }
    fixtureTimer = setTimeout(watch, 1000);
  }
  watch();
}
function shutdown() { clearTimeout(fixtureTimer); }
function install() {}
function uninstall() {}
