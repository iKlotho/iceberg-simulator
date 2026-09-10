// Converts the in-memory sim `db` into the same {nodes, edges, schema, ...}
// shape the (now-retired) Python backend used to produce, so the rendering
// code barely has to change.
function buildGraph(db) {
  const nodes = [];
  const edgeMap = new Map();
  const addEdge = (from, to, kind, extra) => {
    const key = `${from}|${to}|${kind}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, kind, ...extra });
  };

  nodes.push({ id: 'table', type: 'table', label: db.tableName });

  const currentId = db.currentSnapshotId;

  db.snapshots.forEach(snap => {
    const snapId = `snap-${snap.id}`;
    nodes.push({
      id: snapId,
      type: 'snapshot',
      label: `snapshot ${snap.id}`,
      snapshot_id: snap.id,
      sequence_number: snap.seq,
      timestamp_ms: snap.timestampMs,
      operation: snap.operation,
      summary: snap.summary,
      schema_id: snap.schemaId,
      parent_snapshot_id: snap.parentId,
      is_current: snap.id === currentId,
    });
    addEdge('table', snapId, 'snapshot');
    if (snap.parentId) addEdge(`snap-${snap.parentId}`, snapId, 'parent');

    snap.manifestIds.forEach(mfId => {
      const mf = db.manifests[mfId];
      if (!mf) return;
      const mfNodeId = `mf-${mf.id}`;
      if (!nodes.some(n => n.id === mfNodeId)) {
        nodes.push({
          id: mfNodeId,
          type: 'manifest_file',
          label: mf.path,
          path: mf.path,
          content: mf.content,
          added_snapshot_id: mf.addedSnapshotId,
          partition_spec_id: mf.partitionSpecId,
          added_files_count: mf.addedFilesCount,
          existing_files_count: mf.existingFilesCount,
          deleted_files_count: mf.deletedFilesCount,
          added_rows_count: mf.addedRowsCount,
          existing_rows_count: mf.existingRowsCount,
          deleted_rows_count: mf.deletedRowsCount,
          manifest_length: mf.manifestLength,
        });
      }
      addEdge(snapId, mfNodeId, 'manifest_list');

      mf.entries.forEach(e => {
        const df = db.dataFiles[e.dataFileId];
        if (!df) return;
        const dfNodeId = `df-${df.id}`;
        if (!nodes.some(n => n.id === dfNodeId)) {
          nodes.push({
            id: dfNodeId,
            type: 'data_file',
            label: df.path,
            path: df.path,
            file_format: df.format,
            record_count: df.recordCount,
            file_size_in_bytes: df.fileSizeBytes,
            status: e.status,
            snapshot_id: mf.addedSnapshotId,
            partition: null,
          });
        }
        addEdge(mfNodeId, dfNodeId, 'data_file', { status: e.status });
      });
    });
  });

  const hasId = db.schema.some(f => f.name === 'id');
  let rows = [];
  if (hasId) {
    // duplicated (not imported) so this file has no cross-module dependency
    // once both scripts are concatenated into one inline <script> in the page
    const added = new Set();
    const deleted = new Set();
    (currentId ? db.snapshots.find(s => s.id === currentId).manifestIds : []).forEach(mfId => {
      const mf = db.manifests[mfId];
      if (!mf) return;
      mf.entries.forEach(e => (e.status === 2 ? deleted : added).add(e.dataFileId));
    });
    const dataFileIds = [...added].filter(id => !deleted.has(id));
    dataFileIds.forEach(id => rows.push(...db.dataFiles[id].rows));
    rows = rows
      .map(r => {
        const out = {};
        db.schema.forEach(f => (out[f.name] = f.name in r ? r[f.name] : null));
        return out;
      })
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  return {
    nodes,
    edges: [...edgeMap.values()],
    schema: db.schema.map(f => ({ id: f.id, name: f.name, type: f.type, required: f.required })),
    schema_id: db.schemaId,
    table_name: db.tableName,
    rows,
    has_id: hasId,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildGraph };
}
