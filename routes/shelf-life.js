const express = require('express');
const router = express.Router();
const ShelfLifeRule = require('../models/ShelfLifeRule');
const MaterialBatch = require('../models/MaterialBatch');
const {
  assessBatch,
  assessAllBatches,
  generateAlerts,
  generateSchedule
} = require('../services/ShelfLifeService');

router.get('/rules', async (req, res) => {
  try {
    const rules = await ShelfLifeRule.findAll();
    const formattedRules = rules.map(r => ({
      id: r.id,
      material_type: r.material_type,
      param_name: r.param_name,
      decay_start_days_before_expiry: r.decay_start_days,
      decay_rate_per_day: r.decay_rate,
      min_acceptable_value: r.min_value,
      created_at: r.created_at
    }));
    res.json(formattedRules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rules', async (req, res) => {
  try {
    const {
      material_type,
      param_name,
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value
    } = req.body;

    if (!material_type || !param_name || 
        decay_start_days_before_expiry === undefined ||
        decay_rate_per_day === undefined ||
        min_acceptable_value === undefined) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (decay_start_days_before_expiry < 0) {
      return res.status(400).json({ error: '衰减开始天数不能为负数' });
    }

    if (decay_rate_per_day < 0) {
      return res.status(400).json({ error: '日衰减率不能为负数' });
    }

    const id = await ShelfLifeRule.upsert({
      material_type,
      param_name,
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value
    });

    const rule = await ShelfLifeRule.findById(id);
    res.status(201).json({
      id: rule.id,
      material_type: rule.material_type,
      param_name: rule.param_name,
      decay_start_days_before_expiry: rule.decay_start_days,
      decay_rate_per_day: rule.decay_rate,
      min_acceptable_value: rule.min_value
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: '该原料类型和参数组合的规则已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/assess', async (req, res) => {
  try {
    const includeExpired = req.query.include_expired === 'true';
    const assessments = await assessAllBatches(includeExpired);
    res.json(assessments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/assess/:batchId', async (req, res) => {
  try {
    const batch = await MaterialBatch.findById(req.params.batchId);
    if (!batch) {
      return res.status(404).json({ error: '原料批次不存在' });
    }

    const assessment = await assessBatch(batch);
    res.json({
      batch_id: assessment.batch_id,
      days_to_expiry: assessment.days_to_expiry,
      estimated_params: assessment.estimated_params,
      usable: assessment.usable,
      risk_level: assessment.risk_level
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/schedule', async (req, res) => {
  try {
    const { formula_id, daily_production_quantity, planning_days } = req.body;

    if (!formula_id || !daily_production_quantity || !planning_days) {
      return res.status(400).json({ error: '缺少必要参数: formula_id, daily_production_quantity, planning_days' });
    }

    if (daily_production_quantity <= 0) {
      return res.status(400).json({ error: '日产量必须大于0' });
    }

    if (planning_days <= 0 || planning_days > 365) {
      return res.status(400).json({ error: '排程天数必须在1-365天之间' });
    }

    const schedule = await generateSchedule(
      formula_id,
      daily_production_quantity,
      planning_days
    );

    res.json(schedule);
  } catch (err) {
    if (err.message === '配方不存在') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/alerts', async (req, res) => {
  try {
    const alerts = await generateAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
