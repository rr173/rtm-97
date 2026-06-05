const express = require('express');
const router = express.Router();
const BatchCompatibility = require('../models/BatchCompatibility');
const CompatibilityService = require('../services/CompatibilityService');
const MaterialBatch = require('../models/MaterialBatch');

router.post('/records', async (req, res) => {
  try {
    const { batch_a_id, batch_b_id, score, source, notes } = req.body;

    if (!batch_a_id || !batch_b_id) {
      return res.status(400).json({ error: '缺少批次ID' });
    }

    if (score === undefined || score === null) {
      return res.status(400).json({ error: '缺少兼容性评分' });
    }

    const scoreNum = parseFloat(score);
    if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 100) {
      return res.status(400).json({ error: '兼容性评分必须在0-100之间' });
    }

    if (!source || !['manual', 'auto'].includes(source)) {
      return res.status(400).json({ error: 'source必须是manual或auto' });
    }

    const batchA = await MaterialBatch.findById(batch_a_id);
    const batchB = await MaterialBatch.findById(batch_b_id);

    if (!batchA) {
      return res.status(404).json({ error: `批次 ${batch_a_id} 不存在` });
    }
    if (!batchB) {
      return res.status(404).json({ error: `批次 ${batch_b_id} 不存在` });
    }

    const record = await BatchCompatibility.create({
      batch_a_id,
      batch_b_id,
      score: scoreNum,
      source,
      notes
    });

    CompatibilityService.invalidateCache();

    res.status(201).json({
      success: true,
      record: record
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/records', async (req, res) => {
  try {
    const { batch_id } = req.query;

    if (batch_id) {
      const records = await BatchCompatibility.findByBatchId(batch_id);
      res.json({
        success: true,
        batch_id: batch_id,
        records: records
      });
    } else {
      const records = await BatchCompatibility.findAll();
      res.json({
        success: true,
        records: records
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/records/:id', async (req, res) => {
  try {
    const record = await BatchCompatibility.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: '记录不存在' });
    }
    res.json({
      success: true,
      record: record
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/records/:id', async (req, res) => {
  try {
    const result = await BatchCompatibility.delete(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: '记录不存在' });
    }
    CompatibilityService.invalidateCache();
    res.json({
      success: true,
      message: '记录已删除'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/matrix', async (req, res) => {
  try {
    const { type } = req.query;

    if (!type) {
      return res.status(400).json({ error: '缺少原料类型参数type' });
    }

    const matrix = await CompatibilityService.getCompatibilityMatrixWithInference(type);

    res.json({
      success: true,
      ...matrix
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/type-average/:materialType', async (req, res) => {
  try {
    const result = await CompatibilityService.getInferredScoreForType(req.params.materialType);
    res.json({
      success: true,
      material_type: req.params.materialType,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/predict', async (req, res) => {
  try {
    const { batch_ids } = req.body;

    if (!batch_ids || !Array.isArray(batch_ids)) {
      return res.status(400).json({ error: 'batch_ids必须是数组' });
    }

    const result = await CompatibilityService.predictMixCompatibility(batch_ids);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pair/:batchA/:batchB', async (req, res) => {
  try {
    const { batchA, batchB } = req.params;
    const result = await CompatibilityService.getPairCompatibility(
      parseInt(batchA),
      parseInt(batchB)
    );
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
