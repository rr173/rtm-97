const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const ProductBatch = require('./ProductBatch');

class MaterialLock {
  static async lockRelatedMaterials(productBatchId, productBatchNumber, dispositionOrderId, lockedBy) {
    await beginTransaction();
    try {
      const materials = await ProductBatch.getMaterials(productBatchId);
      const materialBatchIds = materials.map(m => m.material_batch_id);

      const lockReason = `质量嫌疑：成品批次${productBatchNumber}质检不合格，关联处置工单`;

      for (const materialBatchId of materialBatchIds) {
        await this._lockMaterialBatch(
          materialBatchId,
          lockReason,
          dispositionOrderId,
          lockedBy
        );

        await this._lockLinkedProductBatches(
          materialBatchId,
          dispositionOrderId,
          lockedBy,
          productBatchId
        );
      }

      await commit();
      return { locked_material_batches: materialBatchIds.length };
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async _lockMaterialBatch(materialBatchId, lockReason, dispositionOrderId, lockedBy) {
    const existing = await get(`
      SELECT * FROM material_locks WHERE material_batch_id = ? AND is_locked = 1
    `, [materialBatchId]);

    if (existing) {
      return existing;
    }

    await run(`
      INSERT OR REPLACE INTO material_locks 
      (material_batch_id, lock_reason, source_disposition_order_id, locked_by, is_locked)
      VALUES (?, ?, ?, ?, 1)
    `, [materialBatchId, lockReason, dispositionOrderId, lockedBy]);
  }

  static async _lockLinkedProductBatches(materialBatchId, dispositionOrderId, lockedBy, excludeProductBatchId) {
    const linkedProductBatches = await ProductBatch.findByMaterialBatch(materialBatchId);

    for (const pb of linkedProductBatches) {
      if (pb.id === excludeProductBatchId) continue;

      const hasQCReport = await get(`
        SELECT 1 FROM qc_reports WHERE product_batch_id = ? LIMIT 1
      `, [pb.id]);

      if (!hasQCReport) {
        const materials = await ProductBatch.getMaterials(pb.id);
        for (const m of materials) {
          const lockReason = `质量嫌疑连坐：同原料批次用于成品批次${pb.batch_number}（尚未质检）`;
          await this._lockMaterialBatch(
            m.material_batch_id,
            lockReason,
            dispositionOrderId,
            lockedBy
          );
        }
      }
    }
  }

  static async unlock(materialBatchId, unlockReason, unlockedBy) {
    const existing = await get(`
      SELECT * FROM material_locks WHERE material_batch_id = ? AND is_locked = 1
    `, [materialBatchId]);

    if (!existing) {
      throw new Error('该原料批次未被锁定');
    }

    if (!unlockReason) {
      throw new Error('解锁原因是必需的');
    }

    await run(`
      UPDATE material_locks 
      SET is_locked = 0, unlock_reason = ?, unlocked_by = ?, unlocked_at = CURRENT_TIMESTAMP
      WHERE material_batch_id = ? AND is_locked = 1
    `, [unlockReason, unlockedBy, materialBatchId]);

    return await this.findByMaterialBatchId(materialBatchId);
  }

  static async findByMaterialBatchId(materialBatchId) {
    return await get(`
      SELECT * FROM material_locks WHERE material_batch_id = ? ORDER BY id DESC LIMIT 1
    `, [materialBatchId]);
  }

  static async isLocked(materialBatchId) {
    const lock = await get(`
      SELECT 1 FROM material_locks WHERE material_batch_id = ? AND is_locked = 1 LIMIT 1
    `, [materialBatchId]);
    return !!lock;
  }

  static async findAllLocked() {
    return await all(`
      SELECT ml.*, mb.batch_number, mb.material_type, mb.supplier, mb.remaining_quantity
      FROM material_locks ml
      JOIN material_batches mb ON ml.material_batch_id = mb.id
      WHERE ml.is_locked = 1
      ORDER BY ml.locked_at DESC
    `);
  }

  static async getLockStatusForBatch(materialBatchId) {
    const lock = await this.findByMaterialBatchId(materialBatchId);
    if (!lock) {
      return { is_locked: false };
    }
    return {
      is_locked: lock.is_locked === 1,
      lock_reason: lock.lock_reason,
      locked_by: lock.locked_by,
      locked_at: lock.locked_at,
      unlock_reason: lock.unlock_reason,
      unlocked_by: lock.unlocked_by,
      unlocked_at: lock.unlocked_at,
      source_disposition_order_id: lock.source_disposition_order_id
    };
  }

  static async filterUnlockedBatchIds(batchIds) {
    if (batchIds.length === 0) return [];

    const placeholders = batchIds.map(() => '?').join(', ');
    const locked = await all(`
      SELECT material_batch_id FROM material_locks 
      WHERE material_batch_id IN (${placeholders}) AND is_locked = 1
    `, batchIds);

    const lockedIds = new Set(locked.map(l => l.material_batch_id));
    return batchIds.filter(id => !lockedIds.has(id));
  }
}

module.exports = MaterialLock;
