const { run, all } = require('../config/database');

class ReservationEvent {
  static async create(planId, eventType, operator = 'system') {
    await run(`
      INSERT INTO reservation_events (plan_id, event_type, operator)
      VALUES (?, ?, ?)
    `, [planId, eventType, operator]);
  }

  static async findByPlanId(planId) {
    return await all(`
      SELECT * FROM reservation_events
      WHERE plan_id = ?
      ORDER BY occurred_at ASC
    `, [planId]);
  }
}

module.exports = ReservationEvent;
