/* Pure matching and request validation. No Zotero writes in this module. */
var UploadCore = (() => {
  const norm = value => String(value || "").replace(/^\s*\[\s*(?:19|20)\d{2}[^\]]{0,60}\]\s*/, "").normalize("NFKC").toLowerCase()
    .replace(/<[^>]*>/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const titleKey = value => norm(value).replace(/\s/g, "");
  const doi = value => String(value || "").trim().toLowerCase()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi\s*:\s*)/i, "")
    .replace(/[\s.,;]+$/g, "");
  const year = value => (String(value || "").match(/\b(?:19|20)\d{2}\b/) || [""])[0];
  function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (titleKey(a) === titleKey(b)) return 1;
    const aa = new Set(a.split(/\s+/)), bb = new Set(b.split(/\s+/));
    return [...aa].filter(x => bb.has(x)).length / new Set([...aa, ...bb]).size;
  }
  function authorNames(record) {
    return (record.creators || []).filter(c => !c.creatorType || c.creatorType === "author")
      .map(c => [...new Set([norm(c.lastName || c.name), norm([c.firstName, c.lastName || c.name].filter(Boolean).join(" "))].filter(Boolean))])
      .filter(names => names.length);
  }
  const sameAuthor = (a, b) => a.some(name => b.includes(name));
  function compare(source, target) {
    const a = doi(source.DOI), b = doi(target.DOI);
    const sim = similarity(source.title, target.title);
    if (!(a && b && a === b) && sim < 0.65) return null;
    const reasons = [];
    let reusable = false;
    if (a && b && a !== b) reasons.push("DOI 不同：按不同发表版本保留，禁止复用原条目");
    else if (source.conflict) reasons.push("PDF 与检索元信息存在冲突，需人工核实");
    else if (sim === 1 && source.localIdentityEvidence?.key === target.key) {
      reusable = true;
      reasons.push(source.localIdentityEvidence.mode === "identical-pdf"
        ? "题名一致，且本地 PDF 与原附件的 SHA-256 完全相同"
        : "PDF 完整题名、至少两位作者、发表年份和出处均与原条目吻合");
    }
    else {
      const authorsA = authorNames(source), authorsB = authorNames(target);
      const authorConflict = authorsA.length && authorsB.length && !authorsA.some(a => authorsB.some(b => sameAuthor(a, b)));
      const ya = year(source.date), yb = year(target.date);
      const yearConflict = ya && yb && Math.abs(Number(ya) - Number(yb)) > (a && b ? 1 : 0);
      const typeConflict = source.itemType && target.itemType && source.itemType !== target.itemType;
      const venueConflict = source.publicationTitle && target.publicationTitle
        && similarity(source.publicationTitle, target.publicationTitle) < 0.5;
      if (authorConflict) reasons.push("作者不一致");
      if (yearConflict) reasons.push("年份不一致");
      if (typeConflict) reasons.push("发表类型不一致");
      if (venueConflict) reasons.push("刊物/会议不一致");
      if (!authorConflict && !yearConflict && !typeConflict && !venueConflict) {
        if (a && b && a === b && sim >= 0.9) {
          reusable = true; reasons.push("DOI 一致，题名相符");
        }
        else if ((!a && !b || a && !b && source.registryVerified) && sim === 1 && ya && ya === yb && authorsA.length && authorsB.length
          && sameAuthor(authorsA[0], authorsB[0]) && source.itemType === target.itemType
          && source.publicationTitle && target.publicationTitle && !venueConflict) {
          reusable = true; reasons.push("无 DOI：题名、第一作者、年份、类型、出处一致");
        }
        else reasons.push("仅有相似信息，证据不足，禁止复用原条目");
      }
    }
    return { key: target.key, title: target.title, DOI: target.DOI || "", date: target.date || "",
      reusable, score: sim + (a && a === b ? 2 : 0), reasons };
  }
  function candidates(source, targets) {
    return targets.map(t => compare(source, t)).filter(Boolean)
      .sort((a, b) => Number(b.reusable) - Number(a.reusable) || b.score - a.score).slice(0, 6);
  }
  function exactKeys(object, allowed) {
    if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error("请求必须为对象");
    const extra = Object.keys(object).filter(k => !allowed.includes(k));
    if (extra.length) throw new Error("拒绝未支持的字段：" + extra.join(", "));
  }
  function defaultDecision(row) {
    if (row.error) return { action: "skip" };
    const matches = (row.candidates || []).filter(c => c.reusable);
    if (matches.length === 1) return { action: "reuse", targetKey: matches[0].key };
    if (matches.length > 1 || row.candidates?.length) return { action: "skip" };
    return { action: "new" };
  }
  function validateCommit(data) {
    exactKeys(data, ["planId", "decisions"]);
    if (typeof data.planId !== "string" || !Array.isArray(data.decisions) || data.decisions.length > 100)
      throw new Error("无效的计划或决定列表");
    const seen = new Set();
    for (const d of data.decisions) {
      exactKeys(d, ["rowId", "action", "targetKey"]);
      if (typeof d.rowId !== "string" || seen.has(d.rowId)) throw new Error("重复或无效的 rowId");
      seen.add(d.rowId);
      if (!["reuse", "new", "skip"].includes(d.action)) throw new Error("不允许覆盖、替换或通用合并操作");
      if (d.action === "reuse" && !/^[A-Z0-9]{8}$/.test(d.targetKey || "")) throw new Error("需明确选择原条目");
      if (d.action !== "reuse" && d.targetKey !== undefined) throw new Error("该操作不接受目标条目");
    }
    return data;
  }
  async function addCollectionsOnly(item, collectionIDs, insideTransaction = false) {
    const before = new Set(item.getCollections());
    const added = collectionIDs.filter(id => !before.has(id));
    if (added.length) {
      for (const id of added) item.addToCollection(id);
      const options = { skipDateModifiedUpdate: true, skipClientDateModifiedUpdate: true };
      if (insideTransaction) await item.save(options);
      else await item.saveTx(options);
    }
    return added;
  }
  return { norm, titleKey, doi, year, similarity, compare, candidates, defaultDecision, exactKeys, validateCommit, addCollectionsOnly };
})();
if (typeof module !== "undefined") module.exports = UploadCore;
