const express = require('express');
const router = express.Router();
const Contraindication = require('../models/Contraindication');

router.get('/', async (req, res) => {
  try {
    const { level } = req.query;
    const list = await Contraindication.findAll(level || null);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const record = await Contraindication.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: '禁忌记录不存在' });
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { type_a, type_b, level, description, discovered_date } = req.body;

    if (!type_a || !type_b || !level || !description || !discovered_date) {
      return res.status(400).json({ error: '缺少必要字段(type_a, type_b, level, description, discovered_date)' });
    }

    const validLevels = ['low', 'medium', 'high', 'critical'];
    if (!validLevels.includes(level)) {
      return res.status(400).json({ error: 'level必须为low/medium/high/critical之一' });
    }

    if (type_a === type_b) {
      return res.status(400).json({ error: 'type_a和type_b不能相同' });
    }

    const existing = await Contraindication.findByPair(type_a, type_b);
    if (existing) {
      return res.status(409).json({
        error: '该原料对的禁忌记录已存在',
        existing_record: existing
      });
    }

    const result = await Contraindication.create(type_a, type_b, level, description, discovered_date);
    const record = await Contraindication.findById(result.lastID);
    res.status(201).json(record);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: '该原料对的禁忌记录已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const record = await Contraindication.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ error: '禁忌记录不存在' });
    }
    await Contraindication.delete(req.params.id);
    res.json({ success: true, message: '禁忌记录已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/simulate', async (req, res) => {
  try {
    const { material_types } = req.body;

    if (!material_types || !Array.isArray(material_types) || material_types.length < 2) {
      return res.status(400).json({ error: '需要提供至少2个原料类型的列表(material_types)' });
    }

    const uniqueTypes = [...new Set(material_types)];
    if (uniqueTypes.length < 2) {
      return res.status(400).json({ error: '去重后需要至少2个不同的原料类型' });
    }

    const result = await Contraindication.simulate(uniqueTypes);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
