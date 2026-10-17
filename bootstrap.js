var controller;
var chromeHandle;
async function startup({ rootURI }) {
  try {
    await Zotero.initializationPromise;
    const registrar = Cc["@mozilla.org/addons/addon-manager-startup;1"]
      .getService(Ci.amIAddonManagerStartup);
    chromeHandle = registrar.registerChrome(Services.io.newURI(rootURI + "manifest.json"),
      [["content", "zotero-upload", "content/"]]);
    const scope = { Zotero, Services, IOUtils, PathUtils, ChromeUtils, Cc, Ci, crypto,
      TextEncoder, TextDecoder, setTimeout, clearTimeout };
    Services.scriptloader.loadSubScript(rootURI + "core.js", scope);
    Services.scriptloader.loadSubScript(rootURI + "upload.js", scope);
    controller = scope.Upload;
    await controller.start();
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("upload@local.codex");
    if (addon) addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DISABLE;
    for (const window of Zotero.getMainWindows()) controller.attachWindow(window);
  }
  catch (error) {
    Zotero.logError(error);
    await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "upload-startup-error.txt"),
      String(error) + "\n" + error.stack);
    throw error;
  }
}
function onMainWindowLoad({ window }) { controller?.attachWindow(window); }
function onMainWindowUnload({ window }) { controller?.detachWindow(window); }
function shutdown() { controller?.stop(); chromeHandle?.destruct(); controller = null; }
function install() {}
function uninstall() {}
