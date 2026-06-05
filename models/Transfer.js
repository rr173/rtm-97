const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const MaterialBatch = require('./MaterialBatch');
const Reservation = require('./Reservation');

class Transfer {
  static async generateTransferNumber() {
    const timestamp = Math.floor(Date.now() / 1000);
    const row = await get(`
      SELECT COUNT(*) as count FROM transfers 
      WHERE transfer_number LIKE ?
    `, [`TF-${timestamp}-%`]);
    const seq = (row?.count || 0) + 1;
    return `TF-${timestamp}-${seq}`;
  }

  static async generateNewBatchNumber(sourceBatchNumber) {
    const baseNumber = sourceBatchNumber.replace(/-T\d+$/, '');
    const row = await get(`
      SELECT COUNT(*) as count FROM material_batches 
      WHERE batch_number LIKE ?
    `, [`${baseNumber}-T%`]);
    const seq = (row?.count || 0) + 1;
    return `${baseNumber}-T${seq}`;
  }

  static async getPendingTransferQuantity(batchId) {
    const row = await get(`
      SELECT SUM(quantity) as total_pending
      FROM transfers
      WHERE source_batch_id = ? AND status = 'pending'
    `, [batchId]);
    return row?.total_pending || 0;
  }

  static async getAvailableQuantity(batchId) {
    const batch = await get('SELECT remaining_quantity FROM material_batches WHERE id = ?', [batchId]);
    if (!batch) return 0;

    const reservedMap = await Reservation.getReservedQuantityMap([batchId]);
    const reservedQuantity = reservedMap[batchId] || 0;
    const pendingTransferQuantity = await this.getPendingTransferQuantity(batchId);

    return Math.max(0, batch.remaining_quantity - reservedQuantity - pendingTransferQuantity);
  }

  static async create(data) {
    const { source_batch_id, quantity, destination_line, operator, reason } = data;

    const sourceBatch = await MaterialBatch.findById(source_batch_id);
    if (!sourceBatch) {
      throw new Error('源批次不存在');
    }

    if (sourceBatch.expiry_date < new Date().toISOString().split('T')[0]) {
      throw new Error('不能从过期批次发起调拨');
    }

    if (sourceBatch.lock_status?.is_locked) {
      throw new Error('不能从锁定批次发起调拨');
    }

    const availableQuantity = await this.getAvailableQuantity(source_batch_id);
    if (availableQuantity < quantity) {
      throw new Error(`可用量不足，当前可用: ${availableQuantity}kg`);
    }

    await beginTransaction();
    try {
      const transferNumber = await this.generateTransferNumber();
      const newBatchNumber = await this.generateNewBatchNumber(sourceBatch.batch_number);

      const newBatchData = {
        material_type: sourceBatch.material_type,
        batch_number: newBatchNumber,
        total_quantity: quantity,
        remaining_quantity: quantity,
        supplier: sourceBatch.supplier,
        receive_date: sourceBatch.receive_date,
        expiry_date: sourceBatch.expiry_date,
        params: sourceBatch.params,
        status: '待检',
        unit_price: sourceBatch.unit_price,
        parent_batch_id: source_batch_id
      };

      const newBatchId = await MaterialBatch.createWithParent(newBatchData);

      await run(`
        INSERT INTO transfers (
          transfer_number, source_batch_id, new_batch_id, quantity,
          destination_line, operator, reason, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [
        transferNumber,
        source_batch_id,
        newBatchId,
        quantity,
        destination_line,
        operator,
        reason
      ]);

      await run(`
        UPDATE material_batches 
        SET remaining_quantity = remaining_quantity - ?
        WHERE id = ?
      `, [quantity, source_batch_id]);

      const transfer = await this.findByTransferNumber(transferNumber);
      await commit();
      return transfer;
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async findById(id) {
    return await get(`
      SELECT t.*,
             sb.batch_number as source_batch_number,
             nb.batch_number as new_batch_number
      FROM transfers t
      LEFT JOIN material_batches sb ON t.source_batch_id = sb.id
      LEFT JOIN material_batches nb ON t.new_batch_id = nb.id
      WHERE t.id = ?
    `, [id]);
  }

  static async findByTransferNumber(transferNumber) {
    return await get(`
      SELECT t.*,
             sb.batch_number as source_batch_number,
             nb.batch_number as new_batch_number
      FROM transfers t
      LEFT JOIN material_batches sb ON t.source_batch_id = sb.id
      LEFT JOIN material_batches nb ON t.new_batch_id = nb.id
      WHERE t.transfer_number = ?
    `, [transferNumber]);
  }

  static async findAll(status = null) {
    let sql = `
      SELECT t.*,
             sb.batch_number as source_batch_number,
             nb.batch_number as new_batch_number
      FROM transfers t
      LEFT JOIN material_batches sb ON t.source_batch_id = sb.id
      LEFT JOIN material_batches nb ON t.new_batch_id = nb.id
    `;
    const params = [];

    if (status) {
      sql += ' WHERE t.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY t.created_at DESC';
    return await all(sql, params);
  }

  static async approve(id, approver) {
    const transfer = await this.findById(id);
    if (!transfer) {
      throw new Error('调拨记录不存在');
    }

    if (transfer.status !== 'pending') {
      throw new Error('只能审批待审批的调拨记录');
    }

    await beginTransaction();
    try {
      await run(`
        UPDATE transfers 
        SET status = 'approved', approver = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [approver, id]);

      await run(`
        UPDATE material_batches 
        SET status = '合格'
        WHERE id = ?
      `, [transfer.new_batch_id]);

      await commit();
      return await this.findById(id);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async reject(id, approver) {
    const transfer = await this.findById(id);
    if (!transfer) {
      throw new Error('调拨记录不存在');
    }

    if (transfer.status !== 'pending') {
      throw new Error('只能驳回待审批的调拨记录');
    }

    const sourceBatch = await MaterialBatch.findById(transfer.source_batch_id);
    const canReturn = sourceBatch && 
                      sourceBatch.expiry_date >= new Date().toISOString().split('T')[0] &&
                      !sourceBatch.lock_status?.is_locked;

    await beginTransaction();
    try {
      if (canReturn) {
        await run(`
          UPDATE transfers 
          SET status = 'rejected', approver = ?, approved_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [approver, id]);

        await run(`
          UPDATE material_batches 
          SET remaining_quantity = remaining_quantity + ?
          WHERE id = ?
        `, [transfer.quantity, transfer.source_batch_id]);

        await run(`
          DELETE FROM material_params WHERE material_batch_id = ?
        `, [transfer.new_batch_id]);

        await run(`
          DELETE FROM material_batches WHERE id = ?
        `, [transfer.new_batch_id]);
      } else {
        await run(`
          UPDATE transfers 
          SET status = 'return_error', approver = ?, approved_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [approver, id]);
      }

      await commit();
      return await this.findById(id);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async getStats() {
    const totalRow = await get('SELECT COUNT(*) as total FROM transfers');
    const totalQuantityRow = await get('SELECT SUM(quantity) as total_quantity FROM transfers WHERE status = "approved"');
    const pendingRow = await get('SELECT COUNT(*) as pending_count FROM transfers WHERE status = "pending"');
    
    const byDestination = await all(`
      SELECT destination_line, SUM(quantity) as total_quantity
      FROM transfers
      WHERE status = 'approved'
      GROUP BY destination_line
      ORDER BY total_quantity DESC
    `);

    return {
      total_transfers: totalRow?.total || 0,
      total_transferred_kg: totalQuantityRow?.total_quantity || 0,
      pending_count: pendingRow?.pending_count || 0,
      by_destination: byDestination
    };
  }

  static async getBatchHistory(batchId) {
    const batch = await MaterialBatch.findById(batchId);
    if (!batch) {
      throw new Error('批次不存在');
    }

    const incomingTransfers = await all(`
      SELECT t.*,
             sb.batch_number as source_batch_number,
             'incoming' as direction
      FROM transfers t
      JOIN material_batches sb ON t.source_batch_id = sb.id
      WHERE t.new_batch_id = ? AND t.status = 'approved'
      ORDER BY t.created_at ASC
    `, [batchId]);

    const outgoingTransfers = await all(`
      SELECT t.*,
             nb.batch_number as new_batch_number,
             'outgoing' as direction
      FROM transfers t
      JOIN material_batches nb ON t.new_batch_id = nb.id
      WHERE t.source_batch_id = ? AND t.status = 'approved'
      ORDER BY t.created_at ASC
    `, [batchId]);

    return {
      batch_id: batch.id,
      batch_number: batch.batch_number,
      material_type: batch.material_type,
      history: [
        ...incomingTransfers,
        ...outgoingTransfers
      ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    };
  }

  static async getTransferInfoForBatch(batchId) {
    const row = await get(`
      SELECT t.id as transfer_id,
             t.transfer_number,
             sb.batch_number as source_batch_number,
             t.created_at as transferred_at,
             t.operator,
             t.approver,
             t.quantity,
             t.destination_line
      FROM transfers t
      JOIN material_batches sb ON t.source_batch_id = sb.id
      WHERE t.new_batch_id = ? AND t.status = 'approved'
    `, [batchId]);

    if (!row) return null;

    return {
      transfer_id: row.transfer_id,
      transfer_number: row.transfer_number,
      source_batch_number: row.source_batch_number,
      transferred_at: row.transferred_at,
      operator: row.operator,
      approver: row.approver,
      quantity: row.quantity,
      destination_line: row.destination_line
    };
  }
}

module.exports = Transfer;
