const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const C = require('./core.js');
assert.deepEqual(C.defaultDecision({ candidates: [{ key: 'ABCDEFGH', reusable: true }] }), { action: 'reuse', targetKey: 'ABCDEFGH' });
assert.deepEqual(C.defaultDecision({ candidates: [] }), { action: 'new' });
assert.deepEqual(C.defaultDecision({ metadata: { conflict: true }, candidates: [] }), { action: 'new' });
assert.deepEqual(C.defaultDecision({ candidates: [{ key: 'ABCDEFGH', reusable: false }] }), { action: 'skip' });
assert.deepEqual(C.defaultDecision({ candidates: [{ key: 'ABCDEFGH', reusable: true }, { key: 'IJKLMNOP', reusable: true }] }), { action: 'skip' });
assert.deepEqual(C.defaultDecision({ error: 'Invalid PDF', candidates: [{ key: 'ABCDEFGH', reusable: true }] }), { action: 'skip' });
const base = { key: 'ABCDEFGH', title: 'Stress and keep out zone in through silicon vias', DOI: '10.1109/TED.2014.2330838',
  date: '2014', itemType: 'journalArticle', publicationTitle: 'IEEE Transactions on Electron Devices',
  creators: [{ lastName: 'Wang', creatorType: 'author' }] };
assert.equal(C.compare({ ...base, DOI: 'https://doi.org/10.1109/TED.2014.2330838.' }, base).reusable, true);
for (const override of [{ DOI: '10.9999/different' }, { title: 'Completely different work about biology' },
  { creators: [{ lastName: 'Smith' }] }, { date: '2020' }, { itemType: 'conferencePaper' },
  { publicationTitle: 'A separate conference on packaging' }, { conflict: true }])
  assert.equal(C.compare({ ...base, ...override }, base)?.reusable || false, false, JSON.stringify(override));
assert.equal(C.compare({ ...base, DOI: '' }, { ...base, DOI: '' }).reusable, true);
assert.equal(C.compare({ ...base, DOI: '', creators: [] }, { ...base, DOI: '' }).reusable, false);
assert.equal(C.compare({ ...base, DOI: '', date: '' }, { ...base, DOI: '' }).reusable, false);
assert.equal(C.compare({ ...base, title: base.title + ' revised', DOI: '' }, { ...base, DOI: '' }).reusable, false);
assert.equal(C.compare({ ...base, DOI: '' }, base).reusable, false);
assert.equal(C.compare({ ...base, registryVerified: true }, { ...base, DOI: '' }).reusable, true);
assert.equal(C.compare({ ...base, DOI: '10.9999/unknown' }, { ...base, DOI: '' }).reusable, false);
assert.equal(C.compare({ ...base, DOI: '', creators: [] }, base).reusable, false);
assert.equal(C.compare({ ...base, title: '[2014 IEDM] ' + base.title }, base).reusable, true);
assert.equal(C.compare({ ...base, creators: [{ lastName: 'Fengjuan Wang' }] },
  { ...base, creators: [{ firstName: 'Fengjuan', lastName: 'Wang' }] }).reusable, true);
assert.equal(C.compare({ ...base, DOI: '', creators: [{ lastName: 'Fengjuan Wang' }] },
  { ...base, DOI: '', creators: [{ firstName: 'Fengjuan', lastName: 'Wang' }] }).reusable, true);
assert.equal(C.compare({ ...base, creators: [{ lastName: 'Fengjuan Wang' }] },
  { ...base, creators: [{ firstName: 'John', lastName: 'Smith' }] }).reusable, false);
for (const data of [{ planId: 'p', decisions: [], overwrite: true },
  { planId: 'p', decisions: [{ rowId: 'r', action: 'replace' }] },
  { planId: 'p', decisions: [{ rowId: 'r', action: 'reuse', targetKey: 'ABCDEFGH', metadata: {} }] },
  { planId: 'p', decisions: [{ rowId: 'r', action: 'new', targetKey: 'ABCDEFGH' }] },
  { planId: 'p', decisions: [{ rowId: 'r', action: 'skip' }, { rowId: 'r', action: 'skip' }] }])
  assert.throws(() => C.validateCommit(data));
const adapterScope = { UploadCore: C, crypto: require('node:crypto').webcrypto };
vm.runInNewContext(fs.readFileSync(__dirname + '/upload.js', 'utf8'), adapterScope);
(async () => {
  const collections = [1], calls = [];
  const item = { getCollections: () => [...collections], addToCollection: id => collections.push(id),
    saveTx: async options => calls.push(options), setField: () => { throw Error('Existing metadata write'); },
    setCreators: () => { throw Error('Existing creator write'); } };
  assert.deepEqual(await C.addCollectionsOnly(item, [1, 2]), [2]);
  assert.deepEqual(collections, [1, 2]); assert.equal(calls.length, 1);
  assert.equal(calls[0].skipDateModifiedUpdate, true);
  await C.addCollectionsOnly(item, [1, 2]); assert.equal(calls.length, 1);
  item.save = async options => calls.push({ ...options, inside: true });
  await C.addCollectionsOnly(item, [1, 2, 3], true);
  assert.equal(calls.length, 2); assert.equal(calls[1].inside, true);
  const U = adapterScope.Upload;
  const recommendedPlan = U.publicPlan({ id: 'defaults', libraryID: 1, collectionKeys: [], expires: Date.now() + 10000,
    rows: [{ id: 'duplicate', metadata: {}, candidates: [{ key: 'ABCDEFGH', reusable: true }] },
      { id: 'new', metadata: {}, candidates: [] }] });
  assert.equal(recommendedPlan.rows[0].recommended, 'reuse');
  assert.equal(recommendedPlan.rows[0].recommendedTargetKey, 'ABCDEFGH');
  assert.equal(recommendedPlan.rows[1].recommended, 'new');
  assert.equal(U.authorized('Bearer nonsense'), false);
  U.token = 'a'.repeat(64); assert.equal(U.authorized('Bearer ' + 'a'.repeat(64)), true);
  // Whole native commit refuses a target that changed DOI after preview, before any write.
  U.plans.set('p', { id: 'p', libraryID: 1, collectionKeys: [], expires: Date.now() + 10000,
    rows: [{ id: 'r', path: 'C:\\file.pdf', hash: 'h', metadata: base, candidates: [{ key: base.key, reusable: true }] }] });
  U.destinations = async () => []; U.file = async () => ({ hash: 'h' }); U.record = () => ({ ...base, DOI: '10.9999/changed' });
  adapterScope.Zotero = { Items: { getByLibraryAndKeyAsync: async () => ({ isRegularItem: () => true, id: 1 }) } };
  await assert.rejects(() => U.commit({ planId: 'p', decisions: [{ rowId: 'r', action: 'reuse', targetKey: base.key }] }), /变化|冲突/);
  U.file = async () => ({ hash: 'CHANGED' });
  await assert.rejects(() => U.commit({ planId: 'p', decisions: [{ rowId: 'r', action: 'new' }] }), /PDF 已变化/);
  // Postponing a native-import review must neither trash nor forget the new item.
  const native = { id: 99 };
  adapterScope.Zotero.Items.getByLibraryAndKeyAsync = async () => native;
  adapterScope.IOUtils = { writeUTF8: async () => {} };
  adapterScope.PathUtils = { profileDir: 'C:\\test', join: (...args) => args.join('\\') };
  const postponed = { id: 'postponed', libraryID: 1, collectionKeys: [], expires: Date.now() + 10000,
    rows: [{ id: 'native', sourceKey: 'ABCDEFGH', metadata: base, candidates: [] }] };
  U.plans.set(postponed.id, postponed); U.pending.set(99, postponed);
  await U.commit({ planId: postponed.id, decisions: [{ rowId: 'native', action: 'skip' }] });
  assert.equal(U.pending.has(99), true); assert.equal(postponed.rows.length, 1); assert.equal(U.ignored.has(99), false);
  U.pending.set(99, { ...postponed, expires: 0 });
  adapterScope.Zotero.Items.getAsync = async () => native;
  let refreshed = false; U.reviewNative = async (id, notify) => { assert.equal(notify, false); refreshed = true; };
  await U.refreshExpiredPending(); assert.equal(refreshed, true);
  console.log('PASS: identity/version conflicts, strict action schema, immutable existing writes, file and target revalidation');
})().catch(error => { console.error(error); process.exitCode = 1; });
