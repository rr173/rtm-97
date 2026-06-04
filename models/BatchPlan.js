const { run, get, all } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class BatchPlan {
  static async create(formulaId, plannedQuantity, planData) {
    const planUuid = uuidv4();
    const result = await run(`
      INSERT INTO batch_plans (plan_uuid, formula_id, planned_quantity, plan_data, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [planUuid, formulaId, plannedQuantity, JSON.stringify(planData)]);
    
    return {
      id: result.lastID,
      plan_uuid: planUuid
    };
  }

  static async findByUuid(planUuid) {
    const plan = await get('SELECT * FROM batch_plans WHERE plan_uuid = ?', [planUuid]);
    if (plan) {
      plan.plan_data = JSON.parse(plan.plan_data);
    }
    return plan;
  }

  static async findById(id) {
    const plan = await get('SELECT * FROM batch_plans WHERE id = ?', [id]);
    if (plan) {
      plan.plan_data = JSON.parse(plan.plan_data);
    }
    return plan;
  }

  static async updateStatus(id, status) {
    return await run(`
      UPDATE batch_plans SET status = ? WHERE id = ?
    `, [status, id]);
  }

  static async findAll() {
    const plans = await all('SELECT * FROM batch_plans ORDER BY id DESC');
    return plans.map(p => {
      p.plan_data = JSON.parse(p.plan_data);
      return p;
    });
  }
}

module.exports = BatchPlan;
