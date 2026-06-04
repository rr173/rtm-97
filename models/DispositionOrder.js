const { run, get, all } = require('../config/database');
const DispositionRule = require('./DispositionRule');

class DispositionOrder {
  static async createFromQCReport(qcReportId, productBatchId, productBatchNumber, unqualifiedItems) {
    const matchingRules = [];
    for (const item of unqualifiedItems) {
      const rule = await DispositionRule.matchDisposition(item.param_name, item.deviation_percent);
      matchingRules.push({
        ...rule,
        param_name: item.param_name,
        deviation_percent: item.deviation_percent,
        measured_value: item.measured_value
      });
    }

    const highestRule = DispositionRule.getHighestDisposition(matchingRules);

    const orderNumber = 'DO-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

    const suggestedAction = this._generateSuggestedAction(highestRule, unqualifiedItems);

    const result = await run(`
      INSERT INTO disposition_orders 
      (order_number, qc_report_id, product_batch_id, product_batch_number, 
       disposition_level, unqualified_items, suggested_action, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [
      orderNumber,
      qcReportId,
      productBatchId,
      productBatchNumber,
      highestRule.disposition_level,
      JSON.stringify(unqualifiedItems),
      suggestedAction
    ]);

    return await this.findById(result.lastID);
  }

  static _generateSuggestedAction(rule, unqualifiedItems) {
    const levelName = DispositionRule.getLevelName(rule.disposition_level);
    const itemsDesc = unqualifiedItems.map(item => 
      `${item.param_name}=${item.measured_value}(偏离${item.deviation_percent.toFixed(2)}%)`
    ).join(', ');

    return `建议处置方案：${levelName}。不合格项：${itemsDesc}。${rule.description || ''}`;
  }

  static async findById(id) {
    const order = await get('SELECT * FROM disposition_orders WHERE id = ?', [id]);
    if (!order) return null;

    order.unqualified_items = JSON.parse(order.unqualified_items);
    return order;
  }

  static async findByOrderNumber(orderNumber) {
    const order = await get('SELECT * FROM disposition_orders WHERE order_number = ?', [orderNumber]);
    if (!order) return null;

    order.unqualified_items = JSON.parse(order.unqualified_items);
    return order;
  }

  static async findByProductBatch(productBatchIdOrNumber) {
    const ProductBatch = require('./ProductBatch');
    const productBatch = await ProductBatch.findByBatchNumber(productBatchIdOrNumber) ||
                         await ProductBatch.findById(productBatchIdOrNumber);
    
    if (!productBatch) return [];

    const orders = await all(`
      SELECT * FROM disposition_orders 
      WHERE product_batch_id = ? 
      ORDER BY created_at DESC
    `, [productBatch.id]);

    for (const order of orders) {
      order.unqualified_items = JSON.parse(order.unqualified_items);
    }

    return orders;
  }

  static async findByStatus(status) {
    const orders = await all(`
      SELECT * FROM disposition_orders 
      WHERE status = ? 
      ORDER BY created_at DESC
    `, [status]);

    for (const order of orders) {
      order.unqualified_items = JSON.parse(order.unqualified_items);
    }

    return orders;
  }

  static async findAll() {
    const orders = await all('SELECT * FROM disposition_orders ORDER BY created_at DESC');
    
    for (const order of orders) {
      order.unqualified_items = JSON.parse(order.unqualified_items);
    }

    return orders;
  }

  static async approve(id, approver) {
    const order = await this.findById(id);
    if (!order) {
      throw new Error('处置工单不存在');
    }

    if (order.status !== 'pending') {
      throw new Error(`当前状态为${order.status}，无法审批`);
    }

    await run(`
      UPDATE disposition_orders 
      SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [approver, id]);

    return await this.findById(id);
  }

  static async reject(id, rejector, rejectReason) {
    const order = await this.findById(id);
    if (!order) {
      throw new Error('处置工单不存在');
    }

    if (order.status !== 'pending') {
      throw new Error(`当前状态为${order.status}，无法驳回`);
    }

    if (!rejectReason) {
      throw new Error('驳回原因是必需的');
    }

    await run(`
      UPDATE disposition_orders 
      SET status = 'rejected', reject_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, [rejectReason, rejector, id]);

    return await this.findById(id);
  }

  static async resubmit(id, newDispositionLevel, operator) {
    const order = await this.findById(id);
    if (!order) {
      throw new Error('处置工单不存在');
    }

    if (order.status !== 'rejected') {
      throw new Error(`当前状态为${order.status}，无法重新提交`);
    }

    if (!newDispositionLevel) {
      throw new Error('新的处置等级是必需的');
    }

    if (DispositionRule.compareLevels(newDispositionLevel, order.disposition_level) >= 0) {
      throw new Error('重新提交的处置等级不能高于或等于原等级');
    }

    const unqualifiedItems = order.unqualified_items;
    const suggestedAction = this._generateSuggestedAction(
      { disposition_level: newDispositionLevel, description: '重新提交调整' },
      unqualifiedItems
    );

    await run(`
      UPDATE disposition_orders 
      SET disposition_level = ?, suggested_action = ?, status = 'pending', 
          reject_reason = NULL, approved_by = NULL, approved_at = NULL
      WHERE id = ?
    `, [newDispositionLevel, suggestedAction, id]);

    return await this.findById(id);
  }

  static async execute(id, executor) {
    const order = await this.findById(id);
    if (!order) {
      throw new Error('处置工单不存在');
    }

    if (order.status !== 'approved') {
      throw new Error(`当前状态为${order.status}，无法执行`);
    }

    await run(`
      UPDATE disposition_orders 
      SET status = 'executed', approved_by = COALESCE(approved_by, ?), approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)
      WHERE id = ?
    `, [executor, id]);

    return await this.findById(id);
  }
}

module.exports = DispositionOrder;
