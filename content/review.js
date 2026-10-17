/* Metadata is untrusted: render textContent, never HTML. */
var UploadUI = {
  api: window.arguments[0], plans: [], choices: [], working: false,
  node(tag, text, cls) {
    const e = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  },
  status(text, error = false) {
    const status = document.getElementById("status");
    status.textContent = text; status.dataset.error = String(error);
  },
  theme() {
    if (typeof ChromeUtils === "undefined") return;
    const { Zotero } = ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");
    Zotero.UIProperties.registerRoot(document.documentElement);
    const main = Zotero.getMainWindow();
    const style = main.getComputedStyle(main.document.documentElement);
    for (const key of ["--material-sidepane", "--material-background", "--material-button",
      "--fill-primary", "--fill-secondary", "--color-border50", "--accent-blue", "--accent-blue10", "--accent-green"]) {
      const value = style.getPropertyValue(key);
      if (value.trim()) document.documentElement.style.setProperty(key, value);
    }
  },
  async init() {
    this.theme();
    const context = this.api.context();
    const select = this.node("select"); select.id = "collection";
    select.appendChild(this.option("", "仅放入当前文库"));
    const byKey = new Map(context.collections.map(c => [c.key, c]));
    for (const c of context.collections) {
      const names = [c.name]; let p = c.parentKey, seen = new Set();
      while (p && byKey.has(p) && !seen.has(p)) {
        seen.add(p); const parent = byKey.get(p); names.unshift(parent.name); p = parent.parentKey;
      }
      select.appendChild(this.option(c.key, names.join(" / ")));
    }
    select.value = context.collectionKeys[0] || "";
    const destination = document.getElementById("destination");
    const label = this.node("label", "目标分类"); label.htmlFor = "collection";
    destination.appendChild(label); destination.appendChild(select);
    this.libraryID = context.libraryID;
    document.getElementById("choose").onclick = () => this.choose();
    document.getElementById("reset").onclick = () => {
      if (this.working) return;
      this.plans = []; this.render(); this.status("请选择分类，再选择 PDF 重新预览。");
    };
    document.getElementById("pending").onclick = () => this.refreshPending().catch(e => this.status(String(e.message || e), true));
    document.getElementById("commit").onclick = () => this.commit();
    document.getElementById("close").onclick = () => window.close();
    this.render();
    await this.refreshPending();
  },
  option(value, text) { const option = this.node("option", text); option.value = value; return option; },
  segmented(options, value, ariaLabel) {
    const group = this.node("div", "", "segmented");
    group.setAttribute("role", "radiogroup"); group.setAttribute("aria-label", ariaLabel);
    const buttons = [];
    const control = {
      get value() { return value; },
      set value(next) { value = next; for (const button of buttons) button.setAttribute("aria-checked", String(button.dataset.value === next)); },
      set disabled(state) { group.dataset.disabled = String(state); for (const button of buttons) button.disabled = state; }
    };
    for (const [option, label] of options) {
      const button = this.node("button", label, "seg");
      button.type = "button"; button.setAttribute("role", "radio"); button.dataset.value = option;
      button.onclick = () => { if (group.dataset.disabled === "true") return; control.value = option; this.updateSummary(); };
      buttons.push(button); group.appendChild(button);
    }
    control.value = value;
    return group;
  },
  setWorking(working) {
    this.working = working;
    for (const id of ["choose", "reset", "pending"]) document.getElementById(id).disabled = working;
    for (const choice of this.choices) choice.action.disabled = working;
    document.getElementById("collection").disabled = working || this.plans.some(p => p.rows.some(r => !r.sourceKey));
    this.updateSummary();
  },
  async refreshPending() {
    if (this.working) return;
    await this.api.refreshExpiredPending();
    const pending = this.api.context().pending;
    if (pending.length) {
      this.plans = pending; this.render();
      this.status("已核对新导入题录，请确认下方处理方式。普通导入沿用条目已有分类。");
    }
    else if (!this.plans.length) this.status("预览不会新增或修改文库条目。");
  },
  async choose() {
    if (this.working) return;
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(window, "选择 PDF", picker.modeOpenMultiple); picker.appendFilter("PDF 文献", "*.pdf");
    if (await picker.show() !== picker.returnOK) return;
    this.setWorking(true); this.status("正在检索元信息并核对已有题录…");
    try {
      const collection = document.getElementById("collection").value;
      this.plans = [await this.api.preview({ paths: picker.files, libraryID: this.libraryID, collectionKeys: collection ? [collection] : [] })];
      this.render(); this.status("预览完成。重复文献默认仅加分类，新文献默认新增；核对后确认执行。");
    } catch (error) { this.status(String(error.message || error), true); }
    finally { this.setWorking(false); }
  },
  render() {
    const rows = document.getElementById("rows"); rows.replaceChildren(); this.choices = [];
    for (const plan of this.plans) for (const row of plan.rows) {
      const matches = row.candidates.filter(c => c.reusable);
      const kind = row.error || matches.length > 1 || !matches.length && row.candidates.length ? "skip" : matches.length ? "reuse" : "new";
      const card = this.node("article", "", "row"), top = this.node("div", "", "row-top"), paper = this.node("div", "", "paper");
      const label = this.node("div", "", "paper-label");
      label.appendChild(this.node("span", String(this.choices.length + 1).padStart(2, "0"), "paper-index"));
      label.appendChild(this.node("span", { reuse: "重复题录", new: "新文献", skip: "待确认" }[kind], "badge " + kind));
      paper.appendChild(label);
      paper.appendChild(this.node("div", row.metadata.title || row.path || "PDF", "title"));
      const names = (row.metadata.creators || []).slice(0, 2).map(c => [c.firstName, c.lastName || c.name].filter(Boolean).join(" "));
      if ((row.metadata.creators || []).length > 2) names.push("等");
      const meta = [names.join(", "), row.metadata.date, row.metadata.DOI ? "DOI: " + row.metadata.DOI : ""].filter(Boolean);
      if (meta.length) paper.appendChild(this.node("div", meta.join(" · "), "meta"));
      const options = [["skip", "暂不处理"]];
      if (!row.error) {
        options.push(["new", row.sourceKey ? "保留独立条目" : row.metadata.conflict ? "新增独立 PDF" : "新增文献"]);
        for (const candidate of matches) options.push(["reuse:" + candidate.key,
          matches.length === 1 ? "仅增加分类" : "仅加分类 → " + candidate.key]);
      }
      const recommended = row.recommended === "reuse" ? "reuse:" + row.recommendedTargetKey : row.recommended || "skip";
      const action = this.segmented(options, options.some(([value]) => value === recommended) ? recommended : "skip",
        "处理方式：" + (row.metadata.title || "PDF"));
      top.appendChild(paper); top.appendChild(action); card.appendChild(top);
      let note = row.error || (kind === "reuse" ? matches[0].reasons.join("；") : kind === "skip" ? "存在相似题录，请核对匹配详情。" : row.metadata.conflict ? "元信息待完善，将保留为独立 PDF。" : "");
      if (row.sourceKey && kind === "reuse") note += "。复用时，新重复项移至回收站。";
      if (note) card.appendChild(this.node("div", note, "match-note" + (kind === "skip" ? " warning" : "")));
      const details = this.node("details", "", "details");
      details.appendChild(this.node("summary", "匹配详情与文件信息"));
      const info = this.node("div", "", "detail-body");
      const description = [
        row.path ? "文件：" + row.path : "",
        row.sourceKey ? "新导入条目：" + row.sourceKey : "",
        row.metadata.publicationTitle || "",
        row.metadata.provenance || "",
        ...(row.metadata.warnings || [])
      ].filter(Boolean);
      info.appendChild(this.node("div", description.join("\n")));
      for (const candidate of row.candidates) {
        const block = this.node("div", candidate.title, "candidate" + (candidate.reusable ? " safe" : ""));
        block.appendChild(this.node("div", [candidate.DOI, candidate.date, candidate.key, ...candidate.reasons].filter(Boolean).join(" · ")));
        info.appendChild(block);
      }
      details.appendChild(info); card.appendChild(details); rows.appendChild(card);
      this.choices.push({ plan, row, action });
    }
    document.body.dataset.empty = String(!this.choices.length);
    document.getElementById("empty").hidden = !!this.choices.length;
    document.getElementById("count").textContent = this.choices.length ? this.choices.length + " 篇文献" : "";
    document.getElementById("collection").disabled = this.working || this.plans.some(p => p.rows.some(r => !r.sourceKey));
    this.updateSummary();
  },
  updateSummary() {
    const counts = { reuse: 0, new: 0, skip: 0 };
    for (const c of this.choices) counts[c.action.value.split(":")[0]]++;
    const text = [["reuse", "仅加分类"], ["new", "新增 / 独立保留"], ["skip", "暂不处理"]]
      .filter(([key]) => counts[key]).map(([key, label]) => label + " " + counts[key] + " 篇");
    document.getElementById("selection-summary").textContent = text.join(" · ") || "重复仅加分类 · 新文献新增";
    const button = document.getElementById("commit"), count = counts.reuse + counts.new;
    button.textContent = this.working ? "处理中…" : count ? "确认处理 " + count + " 篇" : this.choices.length ? "完成核对" : "确认处理";
    button.disabled = this.working || !this.choices.length;
  },
  async commit() {
    if (this.working || !this.choices.length) return;
    this.setWorking(true);
    const outcomes = [];
    try {
      for (const plan of [...this.plans]) {
        const decisions = this.choices.filter(c => c.plan === plan).map(({ row, action }) => {
          const [kind, key] = action.value.split(":");
          return { rowId: row.rowId, action: kind, ...(key ? { targetKey: key } : {}) };
        });
        const result = await this.api.commit({ planId: plan.planId, decisions });
        outcomes.push(...result.results);
        const completed = new Set(result.results.filter(r => !r.error).map(r => r.rowId));
        plan.rows = plan.rows.filter(r => !completed.has(r.rowId));
        if (result.results.some(r => r.error)) break;
      }
      this.plans = this.plans.filter(p => p.rows.length); this.render();
      const errors = outcomes.filter(r => r.error).map(r => r.error);
      const labels = { reuse: "仅加分类", new: "新增", keep: "独立保留", skip: "暂不处理" };
      const summary = Object.entries(labels).map(([key, label]) => {
        const count = outcomes.filter(r => r.action === key && !r.error).length;
        return count ? label + " " + count + " 篇" : "";
      }).filter(Boolean).join("，");
      this.status([summary ? "已完成：" + summary + "。" : "", ...errors].filter(Boolean).join("\n"), !!errors.length);
    } catch (error) { this.status(String(error.message || error), true); }
    finally { this.setWorking(false); }
  }
};
window.addEventListener("DOMContentLoaded", () => UploadUI.init().catch(error => UploadUI.status(String(error), true)));
