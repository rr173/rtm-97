const express = require('express');
const router = express.Router();
const QCReport = require('../models/QCReport');
const DispositionRule = require('../models/DispositionRule');
const DispositionOrder = require('../models/DispositionOrder');
const MaterialLock = require('../models/MaterialLock');

router.post('/inspect', async (req, res) => {
  try {
    const { product_batch, inspector, test_data } = req.body;

    if (!product_batch) {
      return res.status(400).json({ error: '成品批次号或ID是必需的' });
    }
    if (!inspector) {
      return res.status(400).json({ error: '检验员是必需的' });
    }
    if (!test_data || typeof test_data !== 'object' || Object.keys(test_data).length === 0) {
      return res.status(400).json({ error: '检验数据是必需的' });
    }

    const report = await QCReport.createInspection(product_batch, inspector, test_data);
    
    const response = {
      success: true,
      report: {
        id: report.id,
        report_number: report.report_number,
        product_batch_id: report.product_batch_id,
        product_batch_number: report.product_batch_number,
        inspector: report.inspector,
        inspection_time: report.inspection_time,
        overall_result: report.overall_result,
        overall_result_text: report.overall_result === 'qualified' ? '合格' : '不合格',
        items: report.items.map(item => ({
          param_name: item.param_name,
          measured_value: item.measured_value,
          spec_min: item.spec_min,
          spec_max: item.spec_max,
          result: item.result,
          result_text: item.result === 'qualified' ? '合格' : '不合格',
          deviation_percent: item.deviation_percent,
          deviation_direction: item.deviation_direction
        })),
        env_deviations: report.env_deviations || []
      }
    };

    if (report.overall_result === 'unqualified') {
      const dispositions = await DispositionOrder.findByProductBatch(report.product_batch_id);
      if (dispositions.length > 0) {
        response.disposition_order = {
          id: dispositions[0].id,
          order_number: dispositions[0].order_number,
          disposition_level: dispositions[0].disposition_level,
          disposition_level_text: DispositionRule.getLevelName(dispositions[0].disposition_level),
          suggested_action: dispositions[0].suggested_action,
          status: dispositions[0].status,
          status_text: _getStatusText(dispositions[0].status)
        };
      }

      const lockedMaterials = await MaterialLock.findAllLocked();
      response.locked_material_count = lockedMaterials.filter(
        m => m.source_disposition_order_id === response.disposition_order?.id
      ).length;
    }

    res.status(201).json(response);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const { product_batch } = req.query;
    
    let reports;
    if (product_batch) {
      reports = await QCReport.findByProductBatch(product_batch);
    } else {
      reports = await QCReport.findAll();
    }

    res.json({
      success: true,
      count: reports.length,
      reports: reports.map(report => ({
        id: report.id,
        report_number: report.report_number,
        product_batch_id: report.product_batch_id,
        product_batch_number: report.product_batch_number,
        inspector: report.inspector,
        inspection_time: report.inspection_time,
        overall_result: report.overall_result,
        overall_result_text: report.overall_result === 'qualified' ? '合格' : '不合格',
        items: report.items.map(item => ({
          param_name: item.param_name,
          measured_value: item.measured_value,
          spec_min: item.spec_min,
          spec_max: item.spec_max,
          result: item.result,
          result_text: item.result === 'qualified' ? '合格' : '不合格',
          deviation_percent: item.deviation_percent,
          deviation_direction: item.deviation_direction
        })),
        env_deviations: report.env_deviations || []
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/:id', async (req, res) => {
  try {
    const report = await QCReport.findById(req.params.id) || 
                   await QCReport.findByReportNumber(req.params.id);
    
    if (!report) {
      return res.status(404).json({ error: '质检报告不存在' });
    }

    res.json({
      success: true,
      report: {
        id: report.id,
        report_number: report.report_number,
        product_batch_id: report.product_batch_id,
        product_batch_number: report.product_batch_number,
        inspector: report.inspector,
        inspection_time: report.inspection_time,
        overall_result: report.overall_result,
        overall_result_text: report.overall_result === 'qualified' ? '合格' : '不合格',
        items: report.items.map(item => ({
          param_name: item.param_name,
          measured_value: item.measured_value,
          spec_min: item.spec_min,
          spec_max: item.spec_max,
          result: item.result,
          result_text: item.result === 'qualified' ? '合格' : '不合格',
          deviation_percent: item.deviation_percent,
          deviation_direction: item.deviation_direction
        })),
        env_deviations: report.env_deviations || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dispositions', async (req, res) => {
  try {
    const { status, product_batch } = req.query;
    
    let dispositions;
    if (status) {
      dispositions = await DispositionOrder.findByStatus(status);
    } else if (product_batch) {
      dispositions = await DispositionOrder.findByProductBatch(product_batch);
    } else {
      dispositions = await DispositionOrder.findAll();
    }

    res.json({
      success: true,
      count: dispositions.length,
      dispositions: dispositions.map(order => ({
        id: order.id,
        order_number: order.order_number,
        qc_report_id: order.qc_report_id,
        product_batch_id: order.product_batch_id,
        product_batch_number: order.product_batch_number,
        disposition_level: order.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(order.disposition_level),
        unqualified_items: order.unqualified_items,
        suggested_action: order.suggested_action,
        status: order.status,
        status_text: _getStatusText(order.status),
        reject_reason: order.reject_reason,
        approved_by: order.approved_by,
        approved_at: order.approved_at,
        created_at: order.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/dispositions/:id', async (req, res) => {
  try {
    const order = await DispositionOrder.findById(req.params.id) ||
                  await DispositionOrder.findByOrderNumber(req.params.id);
    
    if (!order) {
      return res.status(404).json({ error: '处置工单不存在' });
    }

    res.json({
      success: true,
      disposition: {
        id: order.id,
        order_number: order.order_number,
        qc_report_id: order.qc_report_id,
        product_batch_id: order.product_batch_id,
        product_batch_number: order.product_batch_number,
        disposition_level: order.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(order.disposition_level),
        unqualified_items: order.unqualified_items,
        suggested_action: order.suggested_action,
        status: order.status,
        status_text: _getStatusText(order.status),
        reject_reason: order.reject_reason,
        approved_by: order.approved_by,
        approved_at: order.approved_at,
        created_at: order.created_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/dispositions/:id/approve', async (req, res) => {
  try {
    const { approver } = req.body;
    
    if (!approver) {
      return res.status(400).json({ error: '审批人是必需的' });
    }

    const order = await DispositionOrder.approve(req.params.id, approver);
    
    res.json({
      success: true,
      message: '审批通过',
      disposition: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        status_text: _getStatusText(order.status),
        approved_by: order.approved_by,
        approved_at: order.approved_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dispositions/:id/reject', async (req, res) => {
  try {
    const { rejector, reject_reason } = req.body;
    
    if (!rejector) {
      return res.status(400).json({ error: '驳回人是必需的' });
    }
    if (!reject_reason) {
      return res.status(400).json({ error: '驳回原因是必需的' });
    }

    const order = await DispositionOrder.reject(req.params.id, rejector, reject_reason);
    
    res.json({
      success: true,
      message: '已驳回',
      disposition: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        status_text: _getStatusText(order.status),
        reject_reason: order.reject_reason,
        approved_by: order.approved_by,
        approved_at: order.approved_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dispositions/:id/resubmit', async (req, res) => {
  try {
    const { disposition_level, operator } = req.body;
    
    if (!disposition_level) {
      return res.status(400).json({ error: '新的处置等级是必需的' });
    }
    if (!operator) {
      return res.status(400).json({ error: '操作人是必需的' });
    }

    const order = await DispositionOrder.resubmit(req.params.id, disposition_level, operator);
    
    res.json({
      success: true,
      message: '重新提交成功',
      disposition: {
        id: order.id,
        order_number: order.order_number,
        disposition_level: order.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(order.disposition_level),
        suggested_action: order.suggested_action,
        status: order.status,
        status_text: _getStatusText(order.status)
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/dispositions/:id/execute', async (req, res) => {
  try {
    const { executor } = req.body;
    
    if (!executor) {
      return res.status(400).json({ error: '执行人是必需的' });
    }

    const order = await DispositionOrder.execute(req.params.id, executor);
    
    res.json({
      success: true,
      message: '执行完成',
      disposition: {
        id: order.id,
        order_number: order.order_number,
        status: order.status,
        status_text: _getStatusText(order.status)
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/rules', async (req, res) => {
  try {
    const { param_name } = req.query;
    
    let rules;
    if (param_name) {
      rules = await DispositionRule.findByParamName(param_name);
    } else {
      rules = await DispositionRule.findAll();
    }

    res.json({
      success: true,
      count: rules.length,
      rules: rules.map(rule => ({
        id: rule.id,
        param_name: rule.param_name,
        deviation_min: rule.deviation_min,
        deviation_max: rule.deviation_max,
        disposition_level: rule.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(rule.disposition_level),
        description: rule.description,
        created_at: rule.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rules', async (req, res) => {
  try {
    const { param_name, deviation_min, deviation_max, disposition_level, description } = req.body;

    if (!param_name) {
      return res.status(400).json({ error: '检验参数名是必需的' });
    }
    if (deviation_min === undefined || deviation_min === null) {
      return res.status(400).json({ error: '偏离度最小值是必需的' });
    }
    if (!disposition_level) {
      return res.status(400).json({ error: '处置等级是必需的' });
    }

    const id = await DispositionRule.create(
      param_name,
      deviation_min,
      deviation_max,
      disposition_level,
      description
    );

    const rule = await DispositionRule.findById(id);
    
    res.status(201).json({
      success: true,
      rule: {
        id: rule.id,
        param_name: rule.param_name,
        deviation_min: rule.deviation_min,
        deviation_max: rule.deviation_max,
        disposition_level: rule.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(rule.disposition_level),
        description: rule.description,
        created_at: rule.created_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/rules/:id', async (req, res) => {
  try {
    const existing = await DispositionRule.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '处置规则不存在' });
    }

    await DispositionRule.update(req.params.id, req.body);
    const rule = await DispositionRule.findById(req.params.id);
    
    res.json({
      success: true,
      rule: {
        id: rule.id,
        param_name: rule.param_name,
        deviation_min: rule.deviation_min,
        deviation_max: rule.deviation_max,
        disposition_level: rule.disposition_level,
        disposition_level_text: DispositionRule.getLevelName(rule.disposition_level),
        description: rule.description,
        created_at: rule.created_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/rules/:id', async (req, res) => {
  try {
    const existing = await DispositionRule.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '处置规则不存在' });
    }

    await DispositionRule.delete(req.params.id);
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await QCReport.getStats();
    
    res.json({
      success: true,
      stats: {
        total_inspections: stats.total_inspections,
        qualified_count: stats.qualified_count,
        unqualified_count: stats.unqualified_count,
        pass_rate: stats.pass_rate,
        pass_rate_text: `${stats.pass_rate}%`,
        disposition_distribution: {
          concession: {
            count: stats.disposition_distribution.concession,
            name: DispositionRule.getLevelName('concession')
          },
          rework: {
            count: stats.disposition_distribution.rework,
            name: DispositionRule.getLevelName('rework')
          },
          downgrade: {
            count: stats.disposition_distribution.downgrade,
            name: DispositionRule.getLevelName('downgrade')
          },
          scrap: {
            count: stats.disposition_distribution.scrap,
            name: DispositionRule.getLevelName('scrap')
          }
        },
        recently_locked_material_batches: stats.recently_locked_material_batches
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/locked-materials', async (req, res) => {
  try {
    const locked = await MaterialLock.findAllLocked();
    
    res.json({
      success: true,
      count: locked.length,
      locked_materials: locked.map(lock => ({
        material_batch_id: lock.material_batch_id,
        batch_number: lock.batch_number,
        material_type: lock.material_type,
        supplier: lock.supplier,
        remaining_quantity: lock.remaining_quantity,
        is_locked: lock.is_locked === 1,
        lock_reason: lock.lock_reason,
        locked_by: lock.locked_by,
        locked_at: lock.locked_at,
        source_disposition_order_id: lock.source_disposition_order_id
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function _getStatusText(status) {
  const statusMap = {
    pending: '待审批',
    approved: '已批准',
    executed: '已执行',
    rejected: '已驳回',
    cancelled: '已取消'
  };
  return statusMap[status] || status;
}

module.exports = router;
