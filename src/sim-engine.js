// Pure-JS, in-memory simulation of an Apache Iceberg table's metadata model.
// No real files are written anywhere — everything (schema, snapshots, manifest
// files, manifest lists, data files, even row bytes) lives in the `db` object.
// This lets the whole teaching tool run 100% client-side with zero backend.
//
// Node-testable: no DOM references in this file.

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function randId() {
  // looks like a real Iceberg snapshot id: a big pseudo-random integer, as a string
  return String(Math.floor(Math.random() * 1e18) + 1e15);
}

const FIRST_NAMES = ['ada', 'grace', 'linus', 'margaret', 'alan', 'barbara', 'dennis', 'radia'];
const WORDS = ['ice', 'berg', 'shelf', 'floe', 'glacier', 'frost', 'crevasse', 'arctic'];

function randomValueFor(field, nextId) {
  if (field.name === 'id') return nextId;
  switch (field.type) {
    case 'int':
    case 'long':
      return Math.floor(Math.random() * 99) + 1;
    case 'double':
      return Math.round(Math.random() * 10000) / 100;
    case 'boolean':
      return Math.random() < 0.5;
    case 'date': {
      const d = new Date(Date.now() - Math.floor(Math.random() * 1e10));
      return d.toISOString().slice(0, 10);
    }
    case 'string':
    default:
      if (field.name === 'name') return FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
      return WORDS[Math.floor(Math.random() * WORDS.length)];
  }
}

function freshDb() {
  return {
    tableName: 'ns.mytable',
    schema: [
      { id: 1, name: 'id', type: 'long', required: false },
      { id: 2, name: 'name', type: 'string', required: false },
    ],
    nextFieldId: 3,
    schemaId: 0,
    nextSchemaId: 1,
    snapshots: [], // { id, seq, timestampMs, operation, summary, schemaId, parentId, manifestIds, isCurrent }
    manifests: {}, // id -> { id, path, addedSnapshotId, partitionSpecId, entries:[{dataFileId,status}], addedFilesCount, existingFilesCount, deletedFilesCount, addedRowsCount, existingRowsCount, deletedRowsCount, manifestLength, content }
    dataFiles: {}, // id -> { id, path, rows, recordCount, fileSizeBytes, stats, format }
    currentSnapshotId: null,
  };
}

function makeDataFile(db, rows) {
  const id = `00000-0-${uid()}.parquet`;
  const stats = {};
  db.schema.forEach(f => {
    const vals = rows.map(r => r[f.name]).filter(v => v !== null && v !== undefined && typeof v !== 'boolean');
    if (vals.length) {
      stats[f.name] = { min: vals.reduce((a, b) => (a < b ? a : b)), max: vals.reduce((a, b) => (a > b ? a : b)) };
    }
  });
  const fileSizeBytes = 300 + rows.length * 60 + db.schema.length * 18;
  db.dataFiles[id] = {
    id,
    path: id,
    rows: rows.map(r => ({ ...r })),
    recordCount: rows.length,
    fileSizeBytes,
    stats,
    format: 'PARQUET',
  };
  return id;
}

function makeManifest(db, { addedSnapshotId, entries }) {
  const id = `${uid()}-m0.avro`;
  const countRows = (status) =>
    entries.filter(e => e.status === status).reduce((s, e) => s + db.dataFiles[e.dataFileId].recordCount, 0);
  db.manifests[id] = {
    id,
    path: id,
    addedSnapshotId,
    partitionSpecId: 0,
    entries: entries.slice(),
    addedFilesCount: entries.filter(e => e.status === 1).length,
    existingFilesCount: entries.filter(e => e.status === 0).length,
    deletedFilesCount: entries.filter(e => e.status === 2).length,
    addedRowsCount: countRows(1),
    existingRowsCount: countRows(0),
    deletedRowsCount: countRows(2),
    manifestLength: 300 + entries.length * 180,
    content: 0,
  };
  return id;
}

function currentManifestIds(db) {
  if (!db.currentSnapshotId) return [];
  const snap = db.snapshots.find(s => s.id === db.currentSnapshotId);
  return snap ? snap.manifestIds : [];
}

function commitSnapshot(db, { id, operation, manifestIds, summary }) {
  const seq = db.snapshots.length + 1;
  db.snapshots.forEach(s => (s.isCurrent = false));
  const snap = {
    id,
    seq,
    timestampMs: Date.now(),
    operation,
    summary: summary || { operation },
    schemaId: db.schemaId,
    parentId: db.currentSnapshotId,
    manifestIds: manifestIds.slice(),
    isCurrent: true,
  };
  db.snapshots.push(snap);
  db.currentSnapshotId = id;
  return snap;
}

// ---- reachability: what's actually "live" from the current snapshot ----
function reachable(db) {
  const manifestIds = new Set(currentManifestIds(db));
  const added = new Set();
  const deleted = new Set();
  manifestIds.forEach(mfId => {
    const mf = db.manifests[mfId];
    if (!mf) return;
    mf.entries.forEach(e => {
      if (e.status === 2) deleted.add(e.dataFileId);
      else added.add(e.dataFileId);
    });
  });
  const dataFileIds = new Set([...added].filter(id => !deleted.has(id)));
  return { manifestIds, dataFileIds };
}

function liveRows(db) {
  const { dataFileIds } = reachable(db);
  const rows = [];
  dataFileIds.forEach(id => rows.push(...db.dataFiles[id].rows));
  return rows;
}

function nextIdValue(db) {
  const rows = liveRows(db);
  const ids = rows.map(r => r.id).filter(v => typeof v === 'number');
  return ids.length ? Math.max(...ids) + 1 : Math.floor(Math.random() * 900) + 100;
}

// ---- operations ----

function createFreshTable(db) {
  const rows = [1, 2, 3].map((n, i) => ({ id: n, name: ['a', 'b', 'c'][i] }));
  const dfId = makeDataFile(db, rows);
  const snapId = randId();
  const mfId = makeManifest(db, { addedSnapshotId: snapId, entries: [{ dataFileId: dfId, status: 1 }] });
  commitSnapshot(db, {
    id: snapId,
    operation: 'append',
    manifestIds: [mfId],
    summary: { operation: 'append', 'added-data-files': '1', 'added-records': '3', 'total-data-files': '1', 'total-records': '3' },
  });
}

function addRow(db) {
  const hasId = db.schema.some(f => f.name === 'id');
  const nextId = hasId ? nextIdValue(db) : null;
  const row = {};
  db.schema.forEach(f => {
    row[f.name] = f.name === 'id' ? nextId : randomValueFor(f, nextId);
  });
  const dfId = makeDataFile(db, [row]);
  const snapId = randId();
  const mfId = makeManifest(db, { addedSnapshotId: snapId, entries: [{ dataFileId: dfId, status: 1 }] });
  const manifestIds = [...currentManifestIds(db), mfId];
  commitSnapshot(db, {
    id: snapId,
    operation: 'append',
    manifestIds,
    summary: { operation: 'append', 'added-data-files': '1', 'added-records': '1' },
  });
  return row;
}

function deleteRow(db, targetId) {
  if (!db.schema.some(f => f.name === 'id')) throw new Error("table has no 'id' column to delete by");
  const { dataFileIds } = reachable(db);
  let found = false;
  const entries = [];
  dataFileIds.forEach(dfId => {
    const df = db.dataFiles[dfId];
    const hasMatch = df.rows.some(r => r.id === targetId);
    if (!hasMatch) return;
    found = true;
    const remaining = df.rows.filter(r => r.id !== targetId);
    entries.push({ dataFileId: dfId, status: 2 });
    if (remaining.length > 0) {
      const newDfId = makeDataFile(db, remaining);
      entries.push({ dataFileId: newDfId, status: 1 });
    }
  });
  if (!found) throw new Error(`no row with id ${targetId}`);
  const snapId = randId();
  const mfId = makeManifest(db, { addedSnapshotId: snapId, entries });
  const manifestIds = [...currentManifestIds(db), mfId];
  commitSnapshot(db, {
    id: snapId,
    operation: 'delete',
    manifestIds,
    summary: { operation: 'delete', 'deleted-records': '1' },
  });
}

function addColumn(db, name, type) {
  name = (name || '').trim();
  if (!name) throw new Error('column name is required');
  if (db.schema.some(f => f.name === name)) throw new Error(`column already exists: ${name}`);
  db.schema.push({ id: db.nextFieldId++, name, type, required: false });
  db.schemaId = db.nextSchemaId++;
}

function deleteColumn(db, name) {
  if (!db.schema.some(f => f.name === name)) throw new Error(`no such column: ${name}`);
  if (db.schema.length <= 1) throw new Error('cannot delete the last remaining column');
  db.schema = db.schema.filter(f => f.name !== name);
  db.schemaId = db.nextSchemaId++;
}

function compact(db) {
  const { dataFileIds } = reachable(db);
  if (dataFileIds.size <= 1) throw new Error('nothing to compact — already a single live data file');
  const oldIds = [...dataFileIds];
  const mergedRows = [];
  oldIds.forEach(id => mergedRows.push(...db.dataFiles[id].rows));

  // snapshot 1: delete the old small files (mirrors pyiceberg's overwrite() semantics)
  const delSnapId = randId();
  const delEntries = oldIds.map(id => ({ dataFileId: id, status: 2 }));
  const delMfId = makeManifest(db, { addedSnapshotId: delSnapId, entries: delEntries });
  commitSnapshot(db, {
    id: delSnapId,
    operation: 'delete',
    manifestIds: [...currentManifestIds(db), delMfId],
    summary: { operation: 'delete', 'deleted-data-files': String(oldIds.length) },
  });

  // snapshot 2: append the one consolidated file
  const newDfId = makeDataFile(db, mergedRows);
  const appSnapId = randId();
  const appMfId = makeManifest(db, { addedSnapshotId: appSnapId, entries: [{ dataFileId: newDfId, status: 1 }] });
  commitSnapshot(db, {
    id: appSnapId,
    operation: 'append',
    manifestIds: [...currentManifestIds(db), appMfId],
    summary: { operation: 'append', 'added-data-files': '1', 'added-records': String(mergedRows.length) },
  });

  return { removed: oldIds.length, merged: newDfId };
}

function expireSnapshots(db) {
  const currentId = db.currentSnapshotId;
  const others = db.snapshots.filter(s => s.id !== currentId);
  if (!others.length) throw new Error('nothing to expire — only the current snapshot exists');
  db.snapshots = db.snapshots.filter(s => s.id === currentId);

  // garbage-collect manifests/data files no longer reachable from the retained snapshot
  const { manifestIds, dataFileIds } = reachable(db);
  Object.keys(db.manifests).forEach(id => { if (!manifestIds.has(id)) delete db.manifests[id]; });
  Object.keys(db.dataFiles).forEach(id => { if (!dataFileIds.has(id)) delete db.dataFiles[id]; });

  return { expired: others.length };
}

function resetTable(db0) {
  const db = freshDb();
  createFreshTable(db);
  return db;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    uid,
    randId,
    freshDb,
    makeDataFile,
    makeManifest,
    currentManifestIds,
    commitSnapshot,
    reachable,
    liveRows,
    nextIdValue,
    createFreshTable,
    addRow,
    deleteRow,
    addColumn,
    deleteColumn,
    compact,
    expireSnapshots,
    resetTable,
  };
}
