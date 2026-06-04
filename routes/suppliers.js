const express = require('express');
const router = express.Router();
const SupplierScore = require('../models/SupplierScore');
const StrictInspectionParam = require('../models/StrictInspectionParam');

router.get('/scores', async (req, res) => {
  try {
    const scores = await SupplierScore.findAll();

    res.json({
      success: true,
      count: scores.length,
      suppliers: scores.map(s => ({
        name: s.supplier_name,
        score: s.score,
        status: s.status,
        total_batches: s.total_batches,
        qualified_batches: s.qualified_batches,
        last_20_qualified: s.last_20_qualified,
        last_20_total: s.last_20_total,
        updated_at: s.updated_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scores/:name', async (req, res) => {
  try {
    const score = await SupplierScore.findByName(req.params.name);
    if (!score) {
      return res.status(404).json({ error: '供应商评分记录不存在' });
    }

    res.json({
      success: true,
      supplier: {
        name: score.supplier_name,
        score: score.score,
        status: score.status,
        total_batches: score.total_batches,
        qualified_batches: score.qualified_batches,
        last_20_qualified: score.last_20_qualified,
        last_20_total: score.last_20_total,
        updated_at: score.updated_at
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/strict-params', async (req, res) => {
  try {
    const { material_type } = req.query;

    let params;
    if (material_type) {
      params = await StrictInspectionParam.findByMaterialType(material_type);
    } else {
      params = await StrictInspectionParam.findAll();
    }

    res.json({
      success: true,
      count: params.length,
      params: params.map(p => ({
        id: p.id,
        material_type: p.material_type,
        param_name: p.param_name,
        is_strict: p.is_strict === 1,
        spec_min: p.spec_min,
        spec_max: p.spec_max,
        created_at: p.created_at
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/strict-params', async (req, res) => {
  try {
    const { material_type, param_name, is_strict, spec_min, spec_max } = req.body;

    if (!material_type) {
      return res.status(400).json({ error: '原料类型是必需的' });
    }
    if (!param_name) {
      return res.status(400).json({ error: '参数名是必需的' });
    }
    if (is_strict === undefined) {
      return res.status(400).json({ error: '是否加严参数是必需的' });
    }

    const id = await StrictInspectionParam.create(material_type, param_name, is_strict, spec_min, spec_max);
    const params = await StrictInspectionParam.findByMaterialType(material_type);

    res.status(201).json({
      success: true,
      id,
      params: params.map(p => ({
        id: p.id,
        material_type: p.material_type,
        param_name: p.param_name,
        is_strict: p.is_strict === 1,
        spec_min: p.spec_min,
        spec_max: p.spec_max
      }))
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: '该原料类型和参数的组合已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/strict-params/:id', async (req, res) => {
  try {
    await StrictInspectionParam.delete(req.params.id);
    res.json({ success: true, message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
