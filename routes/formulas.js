const express = require('express');
const router = express.Router();
const Formula = require('../models/Formula');

router.get('/', async (req, res) => {
  try {
    const formulas = await Formula.findAll();
    res.json(formulas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const formula = await Formula.findById(req.params.id);
    if (!formula) {
      return res.status(404).json({ error: '配方不存在' });
    }
    res.json(formula);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, target_product, rows, specs } = req.body;

    if (!name || !target_product || !Array.isArray(rows) || !Array.isArray(specs)) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (rows.length > 12) {
      return res.status(400).json({ error: '配方最多只能有12行原料' });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: '配方至少需要1行原料' });
    }

    for (const row of rows) {
      if (!row.material_type || row.standard_quantity === undefined || 
          row.tolerance_percent === undefined || !row.param_name) {
        return res.status(400).json({ error: '原料行缺少必要参数' });
      }
      if (row.param_min === undefined && row.param_max === undefined) {
        return res.status(400).json({ error: '原料行参数至少需要指定最小值或最大值' });
      }
    }

    for (const spec of specs) {
      if (!spec.param_name || spec.param_min === undefined || spec.param_max === undefined) {
        return res.status(400).json({ error: '成品指标缺少必要参数' });
      }
    }

    const id = await Formula.create(name, target_product, rows, specs);
    const formula = await Formula.findById(id);
    res.status(201).json(formula);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, target_product, rows, specs } = req.body;
    
    const existing = await Formula.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '配方不存在' });
    }

    if (rows && rows.length > 12) {
      return res.status(400).json({ error: '配方最多只能有12行原料' });
    }

    await Formula.update(req.params.id, {
      name,
      targetProduct: target_product,
      rows,
      specs
    });

    const formula = await Formula.findById(req.params.id);
    res.json(formula);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await Formula.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '配方不存在' });
    }

    await Formula.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
