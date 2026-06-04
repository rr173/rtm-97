const express = require('express');
const router = express.Router();
const IncomingReport = require('../models/IncomingReport');

router.post('/inspect', async (req, res) => {
  try {
    const { batch_id, inspector, test_data } = req.body;

    if (!batch_id) {
      return res.status(400).json({ error: '原料批次ID是必需的' });
    }
    if (!inspector) {
      return res.status(400).json({ error: '检验员是必需的' });
    }
    if (!test_data || typeof test_data !== 'object' || Object.keys(test_data).length === 0) {
      return res.status(400).json({ error: '检验数据是必需的' });
    }

    const report = await IncomingReport.createInspection(batch_id, inspector, test_data);

    res.status(201).json({
      success: true,
      report: {
        id: report.id,
        report_number: report.report_number,
        material_batch_id: report.material_batch_id,
        batch_number: report.batch_number,
        material_type: report.material_type,
        supplier: report.supplier,
        inspector: report.inspector,
        inspection_time: report.inspection_time,
        overall_result: report.overall_result,
        overall_result_text: report.overall_result === 'qualified' ? '合格' : '拒收',
        items: report.items.map(item => ({
          param_name: item.param_name,
          measured_value: item.measured_value,
          spec_min: item.spec_min,
          spec_max: item.spec_max,
          result: item.result,
          result_text: item.result === 'qualified' ? '合格' : '不合格',
          deviation_percent: item.deviation_percent,
          deviation_direction: item.deviation_direction
        }))
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/reports', async (req, res) => {
  try {
    const { batch_id } = req.query;

    let reports;
    if (batch_id) {
      reports = await IncomingReport.findByBatchId(batch_id);
    } else {
      reports = await IncomingReport.findAll();
    }

    res.json({
      success: true,
      count: reports.length,
      reports: reports.map(report => ({
        id: report.id,
        report_number: report.report_number,
        material_batch_id: report.material_batch_id,
        batch_number: report.batch_number,
        material_type: report.material_type,
        supplier: report.supplier,
        inspector: report.inspector,
        inspection_time: report.inspection_time,
        overall_result: report.overall_result,
        overall_result_text: report.overall_result === 'qualified' ? '合格' : '拒收',
        items: report.items.map(item => ({
          param_name: item.param_name,
          measured_value: item.measured_value,
          spec_min: item.spec_min,
          spec_max: item.spec_max,
          result: item.result,
          result_text: item.result === 'qualified' ? '合格' : '不合格',
          deviation_percent: item.deviation_percent,
          deviation_direction: item.deviation_direction
        }))
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await IncomingReport.getStats();

    res.json({
      success: true,
      stats: {
        total_inspections: stats.total_inspections,
        qualified_count: stats.qualified_count,
        unqualified_count: stats.unqualified_count,
        pass_rate: stats.pass_rate,
        pass_rate_text: `${stats.pass_rate}%`,
        supplier_rejection_rates: stats.supplier_rejection_rates
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
