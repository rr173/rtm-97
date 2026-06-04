const express = require('express');
const router = express.Router();
const { EnvReading, EnvProcessWindow, EnvDeviation } = require('../models/EnvMonitor');

router.post('/readings', async (req, res) => {
  try {
    const { readings } = req.body;

    if (!readings || !Array.isArray(readings)) {
      return res.status(400).json({ error: 'readings数组是必需的' });
    }

    if (readings.length === 0) {
      return res.status(400).json({ error: 'readings不能为空' });
    }

    if (readings.length > 100) {
      return res.status(400).json({ error: '一次最多上报100条数据' });
    }

    const result = await EnvReading.createBatch(readings);

    res.status(201).json({
      success: true,
      message: '数据上报成功',
      created_count: result.created_count,
      deviation_count: result.deviation_count
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/readings', async (req, res) => {
  try {
    const { product_batch, param } = req.query;

    if (!product_batch) {
      return res.status(400).json({ error: 'product_batch参数是必需的' });
    }

    let readings;
    if (param) {
      readings = await EnvReading.findByProductBatchAndParam(product_batch, param);
    } else {
      readings = await EnvReading.findByProductBatch(product_batch);
    }

    res.json({
      success: true,
      count: readings.length,
      readings: readings.map(r => ({
        id: r.id,
        product_batch: r.product_batch_number,
        param: r.param_name,
        value: r.param_value,
        timestamp: r.collected_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/process-window', async (req, res) => {
  try {
    const window = await EnvProcessWindow.getAll();

    res.json({
      success: true,
      process_window: window
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/process-window/:param', async (req, res) => {
  try {
    const { param } = req.params;
    const { min, max } = req.body;

    const validParams = ['temperature', 'humidity', 'rpm'];
    if (!validParams.includes(param)) {
      return res.status(400).json({ 
        error: `无效参数名: ${param}，有效值为: ${validParams.join(', ')}` 
      });
    }

    if (min === undefined || min === null) {
      return res.status(400).json({ error: 'min参数是必需的' });
    }

    if (max === undefined || max === null) {
      return res.status(400).json({ error: 'max参数是必需的' });
    }

    if (min >= max) {
      return res.status(400).json({ error: 'min必须小于max' });
    }

    const updated = await EnvProcessWindow.update(param, min, max);

    if (!updated) {
      return res.status(404).json({ error: '工艺窗口配置不存在' });
    }

    const updatedWindow = await EnvProcessWindow.getByParam(param);

    res.json({
      success: true,
      message: '工艺窗口更新成功',
      process_window: {
        [param]: {
          min: updatedWindow.min,
          max: updatedWindow.max
        }
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/deviations', async (req, res) => {
  try {
    const { product_batch, param } = req.query;

    if (!product_batch) {
      return res.status(400).json({ error: 'product_batch参数是必需的' });
    }

    let deviations;
    if (param) {
      deviations = await EnvDeviation.findByProductBatchAndParam(product_batch, param);
    } else {
      deviations = await EnvDeviation.findByProductBatch(product_batch);
    }

    res.json({
      success: true,
      count: deviations.length,
      deviations: deviations.map(d => ({
        id: d.id,
        product_batch: d.product_batch_number,
        param: d.param_name,
        actual_value: d.actual_value,
        window_min: d.window_min,
        window_max: d.window_max,
        deviation_direction: d.deviation_direction,
        deviation_percent: d.deviation_percent,
        collected_at: d.collected_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
