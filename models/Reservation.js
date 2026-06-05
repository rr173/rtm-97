const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const ReservationEvent = require('./ReservationEvent');

class Reservation {
  static async create(planId, materialBatchId, quantity, expiresAt) {
    const result = await run(`
      INSERT INTO reservations (plan_id, material_batch_id, quantity, status, expires_at, renew_count)
      VALUES (?, ?, ?, 'active', ?, 0)
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
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity,
             CAST(MAX(0, strftime('%s', r.expires_at) - strftime('%s', 'now')) AS INTEGER) AS remaining_seconds
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      WHERE r.plan_id = ? AND r.status = 'active'
    `, [planId]);
  }

  static async findByPlanId(planId) {
    return await all(`
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity,
             CAST(MAX(0, strftime('%s', r.expires_at) - strftime('%s', 'now')) AS INTEGER) AS remaining_seconds
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      WHERE r.plan_id = ?
      ORDER BY r.id
    `, [planId]);
  }

  static async findActiveAll() {
    return await all(`
      SELECT r.*, mb.batch_number, mb.material_type, mb.remaining_quantity,
             bp.plan_uuid, bp.status AS plan_status,
             CAST(MAX(0, strftime('%s', r.expires_at) - strftime('%s', 'now')) AS INTEGER) AS remaining_seconds
      FROM reservations r
      JOIN material_batches mb ON r.material_batch_id = mb.id
      JOIN batch_plans bp ON r.plan_id = bp.id
      WHERE r.status = 'active'
      ORDER BY r.expires_at ASC
    `);
  }

  static async getPlanRemainingSeconds(planId) {
    const row = await get(`
      SELECT CAST(MAX(0, MIN(strftime('%s', r.expires_at)) - strftime('%s', 'now')) AS INTEGER) AS remaining_seconds
      FROM reservations r
      WHERE r.plan_id = ? AND r.status = 'active'
    `, [planId]);
    return row ? row.remaining_seconds || 0 : 0;
  }

  static async getPlanRenewCount(planId) {
    const row = await get(`
      SELECT MAX(renew_count) AS renew_count
      FROM reservations
      WHERE plan_id = ?
    `, [planId]);
    return row ? row.renew_count || 0 : 0;
  }

  static async renew(planId, operator = 'system') {
    const currentRenewCount = await this.getPlanRenewCount(planId);
    if (currentRenewCount >= 2) {
      return { success: false, error: '已达最大续期次数' };
    }

    const remainingSeconds = await this.getPlanRemainingSeconds(planId);
    if (remainingSeconds <= 0) {
      return { success: false, error: '预占已过期,无法续期' };
    }

    try {
      await beginTransaction();

      await run(`
        UPDATE reservations
        SET expires_at = datetime(expires_at, '+15 minutes'),
            renew_count = renew_count + 1
        WHERE plan_id = ? AND status = 'active'
      `, [planId]);

      await ReservationEvent.create(planId, 'renewed', operator);

      await commit();

      const newRemainingSeconds = await this.getPlanRemainingSeconds(planId);
      const newRenewCount = await this.getPlanRenewCount(planId);

      const expiresRow = await get(`
        SELECT MAX(expires_at) AS new_expires_at
        FROM reservations
        WHERE plan_id = ? AND status = 'active'
      `, [planId]);

      return {
        success: true,
        remaining_seconds: newRemainingSeconds,
        renew_count: newRenewCount,
        expires_at: expiresRow.new_expires_at
      };
    } catch (err) {
      await rollback();
      throw err;
    }
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
    await run(`
      UPDATE reservations SET status = 'executed'
      WHERE plan_id = ? AND status = 'active'
    `, [planId]);
  }

  static async cancelByPlanId(planId, operator = 'system') {
    await beginTransaction();
    try {
      const result = await run(`
        UPDATE reservations SET status = 'cancelled'
        WHERE plan_id = ? AND status = 'active'
      `, [planId]);
      if (result.changes > 0) {
        await ReservationEvent.create(planId, 'cancelled', operator);
      }
      await commit();
      return result;
    } catch (err) {
      await rollback();
      throw err;
    }
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

    await beginTransaction();
    try {
      const result = await run(`
        UPDATE reservations SET status = 'expired'
        WHERE status = 'active' AND expires_at < datetime('now')
      `);

      for (const planId of planIds) {
        await ReservationEvent.create(planId, 'expired', 'system');
      }

      await commit();

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
    } catch (err) {
      await rollback();
      throw err;
    }
  }
}

module.exports = Reservation;
