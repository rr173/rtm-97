const { run, get, all } = require('../config/database');

class SupplierScore {
  static async getStatus(supplierName) {
    const row = await get('SELECT status FROM supplier_scores WHERE supplier_name = ?', [supplierName]);
    return row ? row.status : '正常';
  }

  static async getScore(supplierName) {
    const row = await get('SELECT * FROM supplier_scores WHERE supplier_name = ?', [supplierName]);
    return row || null;
  }

  static async updateAfterInspection(supplierName, isQualified) {
    let existing = await get('SELECT * FROM supplier_scores WHERE supplier_name = ?', [supplierName]);

    if (!existing) {
      await run(`
        INSERT INTO supplier_scores (supplier_name, score, status, total_batches, qualified_batches, last_20_qualified, last_20_total)
        VALUES (?, 100, '正常', 0, 0, 0, 0)
      `, [supplierName]);
      existing = await get('SELECT * FROM supplier_scores WHERE supplier_name = ?', [supplierName]);
    }

    const newTotal = existing.total_batches + 1;
    const newQualified = existing.qualified_batches + (isQualified ? 1 : 0);

    const recentBatches = await all(`
      SELECT ir.overall_result
      FROM incoming_reports ir
      JOIN material_batches mb ON ir.material_batch_id = mb.id
      WHERE mb.supplier = ?
      ORDER BY ir.inspection_time DESC
      LIMIT 20
    `, [supplierName]);

    const last20Total = recentBatches.length;
    const last20Qualified = recentBatches.filter(r => r.overall_result === 'qualified').length;

    const score = last20Total > 0
      ? Math.round((last20Qualified / last20Total) * 10000) / 100
      : 100;

    let status = '正常';
    if (score < 40) {
      status = '黑名单';
    } else if (score < 60) {
      status = '观察';
    }

    await run(`
      UPDATE supplier_scores
      SET score = ?, status = ?, total_batches = ?, qualified_batches = ?,
          last_20_qualified = ?, last_20_total = ?, updated_at = CURRENT_TIMESTAMP
      WHERE supplier_name = ?
    `, [score, status, newTotal, newQualified, last20Qualified, last20Total, supplierName]);
  }

  static async findAll() {
    return await all('SELECT * FROM supplier_scores ORDER BY score ASC');
  }

  static async findByName(supplierName) {
    return await get('SELECT * FROM supplier_scores WHERE supplier_name = ?', [supplierName]);
  }

  static async isBlacklisted(supplierName) {
    if (!supplierName) return false;
    const status = await this.getStatus(supplierName);
    return status === '黑名单';
  }
}

module.exports = SupplierScore;
