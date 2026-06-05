const { run, get, all } = require('../config/database');
const MaterialBatch = require('./MaterialBatch');

class ProductBatch {
  static async create(data, materialUsages) {
    const {
      batch_number,
      formula_id,
      plan_id,
      operator,
      total_yield
    } = data;

    const result = await run(`
      INSERT INTO product_batches 
      (batch_number, formula_id, plan_id, operator, total_yield)
      VALUES (?, ?, ?, ?, ?)
    `, [
      batch_number,
      formula_id,
      plan_id,
      operator,
      total_yield
    ]);

    const productBatchId = result.lastID;

    for (const usage of materialUsages) {
      const paramSnapshot = await MaterialBatch.getParams(usage.material_batch_id);
      await run(`
        INSERT INTO product_batch_materials 
        (product_batch_id, material_batch_id, formula_row_id, material_type, 
         quantity_used, is_substitute, param_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        productBatchId,
        usage.material_batch_id,
        usage.formula_row_id,
        usage.material_type,
        usage.quantity_used,
        usage.is_substitute ? 1 : 0,
        JSON.stringify(paramSnapshot)
      ]);
    }

    return productBatchId;
  }

  static async findByBatchNumber(batchNumber) {
    return await get('SELECT * FROM product_batches WHERE batch_number = ?', [batchNumber]);
  }

  static async findById(id) {
    return await get('SELECT * FROM product_batches WHERE id = ?', [id]);
  }

  static async getMaterials(productBatchId) {
    const materials = await all(`
      SELECT pbm.*, mb.batch_number, mb.supplier, mb.receive_date, mb.expiry_date, mb.unit_price
      FROM product_batch_materials pbm
      JOIN material_batches mb ON pbm.material_batch_id = mb.id
      WHERE pbm.product_batch_id = ?
      ORDER BY pbm.id
    `, [productBatchId]);

    return materials.map(m => {
      m.param_snapshot = JSON.parse(m.param_snapshot);
      return m;
    });
  }

  static async findByMaterialBatch(materialBatchId) {
    return await all(`
      SELECT pb.*, pbm.quantity_used, pbm.material_type, pbm.is_substitute
      FROM product_batch_materials pbm
      JOIN product_batches pb ON pbm.product_batch_id = pb.id
      WHERE pbm.material_batch_id = ?
      ORDER BY pb.production_time DESC
    `, [materialBatchId]);
  }

  static async findAll() {
    return await all('SELECT * FROM product_batches ORDER BY production_time DESC');
  }
}

module.exports = ProductBatch;
