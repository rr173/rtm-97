const { run, get, all } = require('../config/database');

class Reservation {
  static async create(planId, materialBatchId, quantity, expiresAt) {
    const result = await run(`
      INSERT INTO reservations (plan_id, material_batch_id, quantity, status, expires_at)
      VALUES (?, ?, ?, 'active', ?)
    `, [planId, materialBatchId, quantity, expiresAt]);
    return result.lastID;
  }

  static async createBatch(planId, items) {
    const ids = [];
    for (const item of items) {
      const id = await this.create(planId, item.material_batch_id, item.quantity, item.expires_at);
      ids.push(id);
    }
    return ids;
  }

  static async findActiveByPlanId(planId) {
    return await all(`
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      WHERE r.plan_id = ? AND r.status = 'active'
    `, [planId]);
  }

  static async findByPlanId(planId) {
    return await all(`
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      WHERE r.plan_id = ?
      ORDER BY r.id
    `, [planId]);
  }

  static async findActiveAll() {
    return await all(`
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity,
             bp.plan_uuid, bp.status AS plan_status
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      JOIN batch_plans bp ON r.plan_id = bp.id
      WHERE r.status = 'active'
      ORDER BY r.expires_at ASC
    `);
  }

  static async getReservedQuantityMap(batchIds) {
    if (batchIds.length === 0) return {};

    const placeholders = batchIds.map(() => '?').join(', ');
    const rows = await all(`
      SELECT material_batch_id, SUM(quantity) AS total_reserved
      FROM reservations
      WHERE material_batch_id IN (${placeholders}) AND status = 'active'
      GROUP BY material_batch_id
    `, batchIds);

    const map = {};
    rows.forEach(r => {
      map[r.material_batch_id] = r.total_reserved;
    });
    return map;
  }

  static async markExecuted(planId) {
    return await run(`
      UPDATE reservations SET status = 'executed'
      WHERE plan_id = ? AND status = 'active'
    `, [planId]);
  }

  static async cancelByPlanId(planId) {
    return await run(`
      UPDATE reservations SET status = 'cancelled'
      WHERE plan_id = ? AND status = 'active'
    `, [planId]);
  }

  static async isPlanReservationActive(planId) {
    const row = await get(`
      SELECT COUNT(*) AS cnt FROM reservations
      WHERE plan_id = ? AND status = 'active'
    `, [planId]);
    return row.cnt > 0;
  }

  static async expireReservations() {
    const expired = await all(`
      SELECT DISTINCT plan_id FROM reservations
      WHERE status = 'active' AND expires_at < datetime('now')
    `);

    if (expired.length === 0) return { expired_count: 0, plans_expired: [] };

    const planIds = expired.map(r => r.plan_id);
    const placeholders = planIds.map(() => '?').join(', ');

    const result = await run(`
      UPDATE reservations SET status = 'expired'
      WHERE status = 'active' AND expires_at < datetime('now')
    `);

    const plansExpired = [];
    for (const planId of planIds) {
      const planRow = await get(`
        SELECT id, plan_uuid, status FROM batch_plans WHERE id = ?
      `, [planId]);

      if (planRow && planRow.status === 'pending') {
        await run(`
          UPDATE batch_plans SET status = 'expired' WHERE id = ? AND status = 'pending'
        `, [planId]);
        plansExpired.push(planRow.plan_uuid);
      }
    }

    return {
      expired_count: result.changes,
      plans_expired: plansExpired
    };
  }
}

module.exports = Reservation;
