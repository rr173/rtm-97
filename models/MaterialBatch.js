const { run, get, all } = require('../config/database');

class MaterialBatch {
  static async create(data) {
    const {
      material_type,
      batch_number,
      total_quantity,
      remaining_quantity,
      supplier,
      receive_date,
      expiry_date,
      params,
      status = '合格',
      unit_price,
      parent_batch_id = null
    } = data;

    const result = await run(`
      INSERT INTO material_batches 
      (material_type, batch_number, total_quantity, remaining_quantity, 
       supplier, receive_date, expiry_date, status, unit_price, parent_batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      material_type,
      batch_number,
      total_quantity,
      remaining_quantity,
      supplier,
      receive_date,
      expiry_date,
      status,
      unit_price,
      parent_batch_id
    ]);

    const batchId = result.lastID;

    for (const [name, value] of Object.entries(params)) {
      await run(`
        INSERT INTO material_params (material_batch_id, param_name, param_value)
        VALUES (?, ?, ?)
      `, [batchId, name, value]);
    }

    return batchId;
  }

  static async createWithParent(data) {
    return this.create(data);
  }

  static async findById(id) {
    const batch = await get('SELECT * FROM material_batches WHERE id = ?', [id]);
    if (!batch) return null;

    batch.params = await this.getParams(id);
    const MaterialLock = require('./MaterialLock');
    batch.lock_status = await MaterialLock.getLockStatusForBatch(id);
    
    if (batch.parent_batch_id) {
      const parentBatch = await get(
        'SELECT id, batch_number, material_type FROM material_batches WHERE id = ?',
        [batch.parent_batch_id]
      );
      batch.parent_batch = parentBatch || null;
    }
    
    return batch;
  }

  static async getParams(batchId) {
    const params = await all(`
      SELECT param_name, param_value FROM material_params WHERE material_batch_id = ?
    `, [batchId]);
    
    const result = {};
    params.forEach(p => {
      result[p.param_name] = p.param_value;
    });
    return result;
  }

  static async findByType(materialType, includeExpired = false, includeLocked = false, status = null) {
    let sql = 'SELECT mb.* FROM material_batches mb';
    const params = [materialType];
    
    if (!includeLocked) {
      sql += ' LEFT JOIN material_locks ml ON mb.id = ml.material_batch_id AND ml.is_locked = 1';
    }
    
    sql += ' WHERE mb.material_type = ?';
    
    if (!includeExpired) {
      sql += ' AND mb.expiry_date >= date(\'now\') AND mb.remaining_quantity > 0';
    }
    
    if (!includeLocked) {
      sql += ' AND ml.id IS NULL';
    }

    if (status) {
      sql += ' AND mb.status = ?';
      params.push(status);
    }
    
    sql += ' ORDER BY mb.remaining_quantity DESC';
    
    const batches = await all(sql, params);
    
    const MaterialLock = require('./MaterialLock');
    for (const b of batches) {
      b.params = await this.getParams(b.id);
      if (includeLocked) {
        b.lock_status = await MaterialLock.getLockStatusForBatch(b.id);
      }
    }
    
    return batches;
  }

  static async findAll(includeExpired = false, includeLocked = false, status = null) {
    let sql = 'SELECT mb.* FROM material_batches mb';
    const params = [];
    
    if (!includeLocked) {
      sql += ' LEFT JOIN material_locks ml ON mb.id = ml.material_batch_id AND ml.is_locked = 1';
    }
    
    const whereClauses = [];
    
    if (!includeExpired) {
      whereClauses.push('mb.expiry_date >= date(\'now\') AND mb.remaining_quantity > 0');
    }
    
    if (!includeLocked) {
      whereClauses.push('ml.id IS NULL');
    }

    if (status) {
      whereClauses.push('mb.status = ?');
      params.push(status);
    }
    
    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }
    
    sql += ' ORDER BY mb.material_type, mb.batch_number';
    
    const batches = await all(sql, params);
    
    const MaterialLock = require('./MaterialLock');
    for (const b of batches) {
      b.params = await this.getParams(b.id);
      if (includeLocked) {
        b.lock_status = await MaterialLock.getLockStatusForBatch(b.id);
      }
    }
    
    return batches;
  }

  static async updateRemaining(id, newRemaining) {
    return await run(`
      UPDATE material_batches SET remaining_quantity = ? WHERE id = ?
    `, [newRemaining, id]);
  }

  static async decreaseRemaining(id, amount) {
    return await run(`
      UPDATE material_batches SET remaining_quantity = remaining_quantity - ? 
      WHERE id = ? AND remaining_quantity >= ?
    `, [amount, id, amount]);
  }

  static async delete(id) {
    return await run('DELETE FROM material_batches WHERE id = ?', [id]);
  }
}

module.exports = MaterialBatch;
