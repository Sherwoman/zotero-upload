/* Native adapter. Writes to pre-existing items use addCollectionsOnly(). */
var Upload = {
  version: "1.1.2", plans: new Map(), pending: new Map(), tracked: new Set(), ignored: new Set(),
  windows: new Set(), baseline: new Set(), timers: new Map(), routes: [], busy: false, importing: false,
  async start() {
    const accessPath = PathUtils.join(PathUtils.profileDir, "upload-local.json");
    let access;
    try { access = JSON.parse(await IOUtils.readUTF8(accessPath)); } catch (_) {}
    this.token = access?.token?.length >= 32 ? access.token : crypto.randomUUID() + crypto.randomUUID();
    this.baseURL = "http://127.0.0.1:" + Zotero.Prefs.get("httpServer.port") + "/upload/v1";
    await IOUtils.writeUTF8(accessPath, JSON.stringify({ baseURL: this.baseURL, token: this.token, version: this.version }, null, 2));
    for (const library of Zotero.Libraries.getAll()) {
      if (!library.libraryID) continue;
      for (const item of await Zotero.Items.getAll(library.libraryID, false, false)) this.baseline.add(item.id);
    }
    this.route("health", ["GET"], async () => ({ plugin: "Upload", version: this.version,
      authenticatedWrites: true, existingRecordsImmutable: true,
      uiWindows: this.windows.size, pending: this.pending.size }), false);
    this.route("context", ["POST"], async data => {
      UploadCore.exactKeys(data, []); await this.refreshExpiredPending(); return this.context();
    });
    this.route("preview", ["POST"], data => this.preview(data));
    this.route("commit", ["POST"], data => this.commit(data));
    this.observerID = Zotero.Notifier.registerObserver({ notify: (...args) => this.observe(...args) }, ["item"], "upload", 100);
  },
  route(name, methods, handler, auth = true) {
    const path = "/upload/v1/" + name, self = this;
    const Endpoint = function () {};
    Endpoint.prototype = {
      supportedMethods: methods, supportedDataTypes: ["application/json"], permitBookmarklet: false,
      async init(request) {
        const send = (status, data) => [status, "application/json", JSON.stringify(data)];
        if (request.headers?.origin) return send(403, { error: "不接受网页跨域请求" });
        if (auth && !self.authorized(request.headers?.authorization)) return send(401, { error: "需要本机 Upload 鉴权" });
        try { return send(200, await handler(request.data || {})); }
        catch (error) { Zotero.logError(error); return send(400, { error: String(error.message || error) }); }
      }
    };
    if (Zotero.Server.Endpoints[path]) throw new Error("Upload 路由已被占用");
    Zotero.Server.Endpoints[path] = Endpoint; this.routes.push([path, Endpoint]);
  },
  authorized(header) {
    const expected = "Bearer " + this.token, supplied = String(header || "");
    if (expected.length !== supplied.length) return false;
    let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
    return diff === 0;
  },
  context() {
    const pane = Zotero.getMainWindow()?.ZoteroPane;
    const libraryID = pane?.getSelectedLibraryID() || Zotero.Libraries.userLibraryID;
    const collection = pane?.getSelectedCollection();
    return { libraryID, collectionKeys: collection ? [collection.key] : [],
      libraries: Zotero.Libraries.getAll().filter(l => l.libraryID && l.editable).map(l => ({ libraryID: l.libraryID, name: l.name })),
      collections: Zotero.Collections.getByLibrary(libraryID, true).map(c => ({ key: c.key, name: c.name, parentKey: c.parentKey || null })),
      pending: [...this.pending.values()].map(p => this.publicPlan(p)) };
  },
  async destinations(libraryID, keys) {
    const library = Zotero.Libraries.get(libraryID);
    if (!library?.editable) throw new Error("文库不存在或不可编辑");
    if (!Array.isArray(keys) || keys.length > 30 || new Set(keys).size !== keys.length) throw new Error("无效的分类列表");
    const result = [];
    for (const key of keys) {
      if (!/^[A-Z0-9]{8}$/.test(key)) throw new Error("无效的分类 key");
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
      if (!collection || collection.deleted) throw new Error("分类已不存在，请重新预览");
      result.push(collection.id);
    }
    return result;
  },
  record(item) {
    return { key: item.key, id: item.id, libraryID: item.libraryID, title: item.getField("title"), DOI: item.getField("DOI"),
      date: item.getField("date") || (item.getField("title").match(/^\[(\d{4})\s/) || [])[1] || "",
      itemType: Zotero.ItemTypes.getName(item.itemTypeID),
      publicationTitle: item.getField("publicationTitle") || item.getField("proceedingsTitle")
        || item.getField("conferenceName") || item.getField("journalAbbreviation"), creators: item.getCreators() };
  },
  async records(libraryID) {
    return (await Zotero.Items.getAll(libraryID, true, false)).filter(i => i.isRegularItem() && !i.deleted).map(i => this.record(i));
  },
  async file(path) {
    if (typeof path !== "string" || !/^[A-Za-z]:[\\/]/.test(path) || !/\.pdf$/i.test(path))
      throw new Error("只接受本机绝对路径的 PDF 文件");
    path = path.replaceAll("/", "\\");
    const stat = await IOUtils.stat(path);
    if (stat.type !== "regular" || stat.size > 200 * 1024 * 1024 || stat.size < 5) throw new Error("文件非普通 PDF 或超过 200 MB");
    const bytes = await IOUtils.read(path);
    if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-")) throw new Error("文件头不是 PDF");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
    return { path, bytes, hash };
  },
  async crossref(url) {
    if (this.cache?.has(url)) return this.cache.get(url);
    this.cache ||= new Map();
    const response = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 15000 });
    const result = response.response?.message;
    if (!result) throw new Error("Crossref 未返回元信息");
    this.cache.set(url, result); return result;
  },
  registryRecord(m) {
    const dateParts = (m["published-print"] || m["published-online"] || m.published || m.issued)?.["date-parts"]?.[0] || [];
    const conference = m.type === "proceedings-article";
    return { title: String(m.title?.[0] || "").replace(/<[^>]*>/g, ""), DOI: UploadCore.doi(m.DOI), registryVerified: true,
      date: dateParts.join("-"), itemType: conference ? "conferencePaper" : "journalArticle",
      publicationTitle: m["container-title"]?.[0] || "", volume: m.volume || "", issue: m.issue || "", pages: m.page || "",
      creators: (m.author || []).map(a => ({ firstName: a.given || "", lastName: a.family || a.name || "", creatorType: "author" })) };
  },
  bufferFor(file) {
    return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
  },
  async pdfText(file, pdf, warnings) {
    // The recognizer tree nests word tuples deeply; collect every "…, text" tuple from all pages.
    const words = [];
    const walk = value => {
      if (!Array.isArray(value)) return;
      if (value.length === 14 && typeof value[13] === "string" && typeof value[0] === "number") words.push(value[13] + " ");
      else for (const child of value) walk(child);
    };
    walk(pdf.pages || []);
    let text = words.join("");
    // The same PDF worker also returns plain text; its extractor is more tolerant than the tree walk.
    try {
      const buffer = this.bufferFor(file);
      const full = await Zotero.PDFWorker._enqueue(() => Zotero.PDFWorker._query("pdf.getFulltext", { buf: buffer, maxPages: 5 }, [buffer]), false);
      const plain = typeof full?.text === "string" ? full.text.trim() : "";
      if (plain) text = text ? text + "\n" + plain : plain;
    } catch (error) { warnings.push("纯文本提取失败：" + String(error.message || error)); }
    if (!text.trim()) warnings.push("PDF 未提供可提取的文本层（可能是扫描件），只能人工核对");
    return text;
  },
  async titleSearch(title, text, warnings) {
    if (!title || UploadCore.titleKey(title).length < 12) return null;
    let message;
    try {
      message = await this.crossref("https://api.crossref.org/works?rows=5&query.bibliographic=" + encodeURIComponent(title));
    } catch (error) { warnings.push("Crossref 题名检索失败：" + String(error.message || error)); return null; }
    const wanted = UploadCore.titleKey(title), header = UploadCore.titleKey(text.split(/abstract|introduction/i)[0]);
    for (const item of message?.items || []) {
      const candidate = String(item.title?.[0] || "").replace(/<[^>]*>/g, "");
      if (!candidate) continue;
      const exact = UploadCore.titleKey(candidate) === wanted;
      if (!exact && UploadCore.similarity(candidate, title) < 0.92) continue;
      const record = this.registryRecord(item);
      const author = UploadCore.titleKey(record.creators?.[0]?.lastName || "");
      const authorOk = author.length >= 4 && header.includes(author);
      const year = UploadCore.year(record.date), yearOk = !!year && year === UploadCore.year(header);
      if (!authorOk && !yearOk) { warnings.push("题名候选缺少作者或年份佐证：" + candidate); continue; }
      return { ...record, provenance: "PDF 题名 + Crossref 题名检索（题名与" + (authorOk ? "作者" : "年份") + "佐证一致）", warnings };
    }
    return null;
  },
  async metadata(file, records) {
    if (!Zotero.PDFWorker?._enqueue || !Zotero.PDFWorker?._query) throw new Error("当前 Zotero PDF 接口不兼容，停止导入");
    const warnings = [];
    const buffer = this.bufferFor(file);
    const pdf = await Zotero.PDFWorker._enqueue(() => Zotero.PDFWorker._query("pdf.getRecognizerData", { buf: buffer }, [buffer]), false);
    const text = await this.pdfText(file, pdf, warnings);
    const cleanText = UploadCore.titleKey(text);
    const filename = PathUtils.filename(file.path).replace(/\.pdf$/i, "").replace(/_/g, " ");
    let title = pdf.metadata?.Title || "";
    if (title.length < 18 || /^(untitled|microsoft|doi:|layout|full.?text|document)/i.test(title)) title = filename;
    const visible = records.filter(r => UploadCore.titleKey(r.title).length >= 25 && cleanText.includes(UploadCore.titleKey(r.title)))
      .sort((a, b) => b.title.length - a.title.length);
    if (visible.length) title = visible[0].title;
    const rawDOIs = [...new Set(((JSON.stringify(pdf.metadata || {}) + " " + text).match(/10\.\d{4,9}\/[A-Za-z0-9._;()/:+\-]+/g) || [])
      .map(UploadCore.doi))].slice(0, 6);
    for (const value of rawDOIs) {
      try {
        const m = this.registryRecord(await this.crossref("https://api.crossref.org/works/" + encodeURIComponent(value)));
        const visibleTitle = UploadCore.titleKey(m.title);
        if (UploadCore.similarity(m.title, title) >= 0.8 || (visibleTitle.length > 25 && cleanText.includes(visibleTitle)))
          return { ...m, provenance: "PDF 首页 DOI + Crossref，已核对题名", warnings };
      } catch (_) { warnings.push("DOI 检索失败：" + value); }
    }
    // No DOI anywhere in the PDF: fall back to a strictly verified Crossref title search.
    if (!rawDOIs.length) {
      const found = await this.titleSearch(title, text, warnings);
      if (found) return found;
    }
    // Registry downtime must not force unsafe fuzzy merging. The PDF itself must show the DOI and title.
    for (const r of visible) {
      if (r.DOI && rawDOIs.includes(UploadCore.doi(r.DOI))) return { title: r.title, DOI: UploadCore.doi(r.DOI),
        creators: [], date: "", provenance: "PDF 首页 DOI 与完整题名同时吻合；未补写作者/年份", warnings };
    }
    // Never upload local titles or PDF contents. No-DOI identity is checked locally.
    for (const r of records.filter(r => UploadCore.titleKey(r.title) === UploadCore.titleKey(title))) {
      const target = await Zotero.Items.getByLibraryAndKeyAsync(r.libraryID, r.key);
      if (target) for (const id of target.getAttachments()) {
        const attachment = await Zotero.Items.getAsync(id);
        if (attachment.attachmentContentType !== "application/pdf") continue;
        const path = await attachment.getFilePathAsync();
        try {
          if (path && (await this.file(path)).hash === file.hash) return { title, DOI: rawDOIs.length === 1 ? rawDOIs[0] : "",
            creators: [], date: "", localIdentityEvidence: { key: r.key, mode: "identical-pdf", attachmentKey: attachment.key, hash: file.hash, recordSnapshot: JSON.stringify(r) },
            provenance: "本地题名与原 PDF 文件 SHA-256 一致", warnings };
        } catch (_) {}
      }
      const header = UploadCore.titleKey(text.split(/abstract|introduction/i)[0]);
      const authors = (r.creators || []).filter(c => !c.creatorType || c.creatorType === "author");
      const matched = authors.filter(c => UploadCore.titleKey(c.lastName).length >= 4 && header.includes(UploadCore.titleKey(c.lastName)));
      const yr = UploadCore.year(r.date), subject = pdf.metadata?.Subject || "";
      if (visible.some(v => v.key === r.key) && matched.length >= 2 && yr && UploadCore.year(subject) === yr
        && r.publicationTitle && UploadCore.similarity(subject.split(";")[0], r.publicationTitle) >= 0.8) {
        return { title, DOI: rawDOIs.length === 1 ? rawDOIs[0] : "", creators: [], date: yr,
          localIdentityEvidence: { key: r.key, mode: "title-authors-year-venue", recordSnapshot: JSON.stringify(r) },
          provenance: "PDF 首页完整题名、作者与内嵌发表年份/出处本地交叉核对", warnings };
      }
    }
    return { title, DOI: rawDOIs.length === 1 ? rawDOIs[0] : "", creators: [], date: "", itemType: "journalArticle",
      conflict: true, provenance: "未确认元信息：只允许保留独立 PDF 或跳过", warnings };
  },
  publicPlan(plan) {
    return { planId: plan.id, libraryID: plan.libraryID, collectionKeys: plan.collectionKeys,
      expires: new Date(plan.expires).toISOString(), rows: plan.rows.map(r => ({ rowId: r.id, path: r.path,
        sourceKey: r.sourceKey || null, metadata: r.metadata, candidates: r.candidates,
        recommended: UploadCore.defaultDecision(r).action,
        recommendedTargetKey: UploadCore.defaultDecision(r).targetKey || null, error: r.error || null })) };
  },
  async preview(data) {
    UploadCore.exactKeys(data, ["paths", "libraryID", "collectionKeys"]);
    if (!Array.isArray(data.paths) || !data.paths.length || data.paths.length > 100) throw new Error("一次选择 1–100 个 PDF");
    const context = this.context(), libraryID = data.libraryID ?? context.libraryID;
    if (!Number.isInteger(libraryID)) throw new Error("无效的 libraryID");
    const keys = data.collectionKeys ?? context.collectionKeys;
    await this.destinations(libraryID, keys);
    const records = await this.records(libraryID), paths = new Set();
    const plan = { id: crypto.randomUUID(), libraryID, collectionKeys: keys, expires: Date.now() + 30 * 60 * 1000, rows: [] };
    for (const path of data.paths) {
      if (typeof path !== "string") throw new Error("文件路径必须为字符串");
      const key = path.replaceAll("/", "\\").toLowerCase();
      if (paths.has(key)) throw new Error("同一个文件重复选择"); paths.add(key);
      const row = { id: crypto.randomUUID(), path, candidates: [], metadata: {} };
      try {
        const file = await this.file(path); row.path = file.path; row.hash = file.hash;
        row.metadata = await this.metadata(file, records);
        row.candidates = UploadCore.candidates(row.metadata, records);
      } catch (error) { row.error = String(error.message || error); }
      plan.rows.push(row);
    }
    for (const [id, p] of this.plans) if (p.expires < Date.now()) this.plans.delete(id);
    this.plans.set(plan.id, plan); return this.publicPlan(plan);
  },
  fingerprint(item) { return JSON.stringify(item.toJSON()); },
  async commit(data) {
    if (this.busy) throw new Error("另一批 Upload 正在提交，请稍后重试");
    this.busy = true;
    try { return await this.commitPlan(data); }
    finally { this.busy = false; }
  },
  async commitPlan(data) {
    UploadCore.validateCommit(data);
    const plan = this.plans.get(data.planId);
    if (!plan || plan.expires < Date.now()) throw new Error("预览已过期，请重新核对");
    const ids = await this.destinations(plan.libraryID, plan.collectionKeys);
    const operations = [];
    // Validate all decisions before writing. Caller-supplied metadata is never accepted.
    for (const decision of data.decisions) {
      const row = plan.rows.find(r => r.id === decision.rowId);
      if (!row) throw new Error("rowId 不属于当前计划");
      if (decision.action === "skip") {
        const source = row.sourceKey ? await Zotero.Items.getByLibraryAndKeyAsync(plan.libraryID, row.sourceKey) : null;
        operations.push({ row, decision, source }); continue;
      }
      if (row.error) throw new Error("该 PDF 预览失败，只能跳过");
      let source;
      if (row.sourceKey) {
        source = await Zotero.Items.getByLibraryAndKeyAsync(plan.libraryID, row.sourceKey);
        if (!source || source.deleted || this.baseline.has(source.id) || !this.tracked.has(source.id)
          || this.fingerprint(source) !== row.fingerprint) throw new Error("新导入条目已变化或不属于本次导入，拒绝处理");
      }
      else if ((await this.file(row.path)).hash !== row.hash) throw new Error("PDF 已变化，请重新预览");
      let target;
      if (decision.action === "reuse") {
        if (!row.candidates.some(c => c.key === decision.targetKey && c.reusable)) throw new Error("所选条目未达到复用条件");
        target = await Zotero.Items.getByLibraryAndKeyAsync(plan.libraryID, decision.targetKey);
        if (!target?.isRegularItem() || target.deleted || target.id === source?.id
          || !UploadCore.compare(row.metadata, this.record(target))?.reusable) throw new Error("原条目信息已变化或存在版本冲突");
        const evidence = row.metadata.localIdentityEvidence;
        if (evidence && evidence.recordSnapshot !== JSON.stringify(this.record(target))) throw new Error("原条目的核对信息已变化，请重新预览");
        if (evidence?.mode === "identical-pdf") {
          const attachment = await Zotero.Items.getByLibraryAndKeyAsync(plan.libraryID, evidence.attachmentKey);
          const path = attachment?.parentID === target.id && await attachment.getFilePathAsync();
          if (!path || (await this.file(path)).hash !== evidence.hash) throw new Error("原附件已变化，请重新核对");
        }
        if (source) {
          if (source.getNotes().length || source.getTags().length || source.getRelations && Object.keys(source.getRelations()).length)
            throw new Error("新导入条目已有笔记、标签或关联，保留双方，不自动收起");
          for (const id of source.getAttachments()) {
            const attachment = await Zotero.Items.getAsync(id);
            if (attachment.getAnnotations().length || attachment.getField("note")) throw new Error("新附件已有批注，保留双方");
          }
        }
      }
      operations.push({ row, decision, source, target });
    }
    this.importing = true;
    const results = [];
    try {
      for (const { row, decision, source, target } of operations) {
        try {
          if (decision.action === "reuse") {
            const collectionIDs = [...new Set([...ids, ...(source ? source.getCollections() : [])])];
            await Zotero.DB.executeTransaction(async () => {
              if (target.deleted || !UploadCore.compare(row.metadata, this.record(target))?.reusable
                || (source && (source.deleted || this.fingerprint(source) !== row.fingerprint)))
                throw new Error("提交前条目已变化，请重新核对");
              await UploadCore.addCollectionsOnly(target, collectionIDs, true);
              if (source) await Zotero.Items.trash([source.id]);
            });
            results.push({ rowId: row.id, action: "reuse", key: target.key, existingMetadataUnchanged: true,
              newDuplicateTrashed: source?.key || null });
          }
          else if (decision.action === "new" && !source) {
            let item;
            try {
              if (row.metadata.conflict) {
                item = await Zotero.Attachments.importFromFile({ file: row.path, libraryID: plan.libraryID, collections: ids,
                  title: row.metadata.title || PathUtils.filename(row.path), contentType: "application/pdf" });
              }
              else {
                const m = row.metadata; item = new Zotero.Item(m.itemType || "journalArticle"); item.libraryID = plan.libraryID;
                for (const field of ["title", "DOI", "date", "volume", "issue", "pages"]) if (m[field]) item.setField(field, m[field]);
                if (m.publicationTitle) item.setField(m.itemType === "conferencePaper" ? "proceedingsTitle" : "publicationTitle", m.publicationTitle);
                item.setCreators(m.creators || []); for (const id of ids) item.addToCollection(id); await item.saveTx();
                await Zotero.Attachments.importFromFile({ file: row.path, parentItemID: item.id, title: "PDF", contentType: "application/pdf" });
              }
              this.ignored.add(item.id); results.push({ rowId: row.id, action: "new", key: item.key });
            } catch (error) { if (item?.id) await Zotero.Items.trashTx([item.id]); throw error; }
          }
          else results.push({ rowId: row.id, action: source && decision.action === "new" ? "keep" : "skip", key: source?.key || null });
          if (source && decision.action === "skip") continue;
          if (source) { this.ignored.add(source.id); this.pending.delete(source.id); }
          plan.rows = plan.rows.filter(r => r.id !== row.id);
        } catch (error) {
          results.push({ rowId: row.id, error: String(error.message || error) }); break;
        }
      }
      if (!plan.rows.length) this.plans.delete(plan.id);
      await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "upload-last-result.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
      this.updateBadge(); return { results, remaining: plan.rows.length };
    } finally { this.importing = false; }
  },
  observe(event, type, ids) {
    if (this.importing || !["add", "modify"].includes(event)) return;
    for (const id of ids) {
      if (event === "add" && !this.baseline.has(id)) this.tracked.add(id);
      const item = Zotero.Items.get(id), parentID = item?.parentID, candidate = parentID || id;
      if (!this.tracked.has(candidate) || this.baseline.has(candidate) || this.ignored.has(candidate)) continue;
      clearTimeout(this.timers.get(candidate));
      this.timers.set(candidate, setTimeout(() => this.reviewNative(candidate).catch(e => Zotero.logError(e)), 5000));
    }
  },
  async reviewNative(id, notify = true) {
    const source = await Zotero.Items.getAsync(id);
    if (!source?.isRegularItem() || source.deleted || !source.getAttachments().length || !source.getField("title")) return;
    const metadata = this.record(source);
    const records = (await this.records(source.libraryID)).filter(r => r.id < id);
    const candidates = UploadCore.candidates(metadata, records);
    if (!candidates.length) return;
    const previous = this.pending.get(id); if (previous) this.plans.delete(previous.id);
    const plan = { id: crypto.randomUUID(), libraryID: source.libraryID,
      collectionKeys: source.getCollections().map(id => Zotero.Collections.get(id).key), expires: Date.now() + 30 * 60 * 1000,
      rows: [{ id: crypto.randomUUID(), sourceKey: source.key, fingerprint: this.fingerprint(source), metadata, candidates }] };
    this.pending.set(id, plan); this.plans.set(plan.id, plan); this.updateBadge();
    if (notify && !Zotero.Prefs.get("upload.suppressPrompts", true)) this.openWindow();
  },
  async refreshExpiredPending() {
    for (const [id, plan] of this.pending) {
      const source = await Zotero.Items.getAsync(id);
      if (!source || source.deleted) { this.pending.delete(id); this.plans.delete(plan.id); }
      else if (plan.expires < Date.now()) await this.reviewNative(id, false);
    }
    this.updateBadge();
  },
  attachWindow(window) {
    if (this.windows.has(window)) return;
    this.windows.add(window); const doc = window.document;
    const toolbar = doc.getElementById("zotero-toolbar-item-tree");
    if (toolbar) {
      const button = doc.createXULElement("toolbarbutton"); button.id = "zotero-upload-button";
      button.setAttribute("label", "Upload"); button.setAttribute("tooltiptext", "文献导入与分类整理");
      button.setAttribute("image", "chrome://zotero-upload/content/upload.svg");
      button.style.setProperty("-moz-context-properties", "fill"); button.style.fill = "currentColor";
      button.setAttribute("class", "zotero-tb-button"); button.style.padding = "0 8px";
      button.addEventListener("command", () => this.openWindow()); toolbar.appendChild(button);
    }
    const tools = doc.getElementById("menu_ToolsPopup");
    if (tools) {
      const menu = doc.createXULElement("menuitem"); menu.id = "zotero-upload-menu";
      menu.setAttribute("label", "Upload · 文献导入…");
      menu.setAttribute("class", "menuitem-iconic");
      menu.setAttribute("image", "chrome://zotero-upload/content/upload.svg");
      menu.setAttribute("tooltiptext", "文献导入与分类整理");
      menu.style.setProperty("-moz-context-properties", "fill"); menu.style.fill = "currentColor";
      menu.addEventListener("command", () => this.openWindow()); tools.appendChild(menu);
    }
    this.updateBadge();
  },
  detachWindow(window) {
    for (const id of ["zotero-upload-button", "zotero-upload-menu"]) window.document.getElementById(id)?.remove();
    this.windows.delete(window);
  },
  updateBadge() {
    for (const window of this.windows) window.document.getElementById("zotero-upload-button")
      ?.setAttribute("label", "Upload" + (this.pending.size ? " (" + this.pending.size + ")" : ""));
  },
  async openWindow() {
    await this.refreshExpiredPending();
    if (this.dialog && !this.dialog.closed) { this.dialog.focus(); this.dialog.UploadUI?.refreshPending(); return; }
    this.dialog = Zotero.getMainWindow().openDialog("chrome://zotero-upload/content/review.xhtml", "zotero-upload",
      "chrome,centerscreen,resizable,dialog=no,width=960,height=760", this);
  },
  stop() {
    if (this.observerID) Zotero.Notifier.unregisterObserver(this.observerID);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const [path, Endpoint] of this.routes) if (Zotero.Server.Endpoints[path] === Endpoint) delete Zotero.Server.Endpoints[path];
    for (const window of [...this.windows]) this.detachWindow(window);
    if (this.dialog && !this.dialog.closed) this.dialog.close();
    this.plans.clear(); this.pending.clear();
  }
};
