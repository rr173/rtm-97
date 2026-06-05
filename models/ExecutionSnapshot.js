const { run, get, all } = require('../config/database');

class ExecutionSnapshot {
  static async create(productBatchId, snapshotData) {
    const result = await run(`
      INSERT INTO execution_snapshots (product_batch_id, snapshot_data)
      VALUES (?, ?)
    `, [productBatchId, JSON.stringify(snapshotData)]);
    return result.lastID;
  }

  static async findByProductBatchId(productBatchId) {
    const row = await get(`
      SELECT * FROM execution_snapshots 
      WHERE product_batch_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [productBatchId]);

    if (!row) return null;
    row.snapshot_data = JSON.parse(row.snapshot_data);
    return row;
  }

  static async findById(id) {
    const row = await get('SELECT * FROM execution_snapshots WHERE id = ?', [id]);
    if (!row) return null;
    row.snapshot_data = JSON.parse(row.snapshot_data);
    return row;
  }
}

module.exports = ExecutionSnapshot;
