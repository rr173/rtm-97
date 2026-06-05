const express = require('express');
const router = express.Router();
const MaterialBatch = require('../models/MaterialBatch');
const MaterialLock = require('../models/MaterialLock');
const SubstitutionRule = require('../models/SubstitutionRule');

const STATUS_MAP = {
  'pending': '待检',
  'accepted': '合格',
  'rejected': '拒收'
};

router.get('/batches', async (req, res) => {
  try {
    const includeExpired = req.query.include_expired === 'true';
    const statusQuery = req.query.status;
    const status = statusQuery ? STATUS_MAP[statusQuery] || null : null;
    const batches = await MaterialBatch.findAll(includeExpired, false, status);
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const batch = await MaterialBatch.findById(req.params.id);
    if (!batch) {
      return res.status(404).json({ error: '原料批次不存在' });
    }
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batches/type/:materialType', async (req, res) => {
  try {
    const includeExpired = req.query.include_expired === 'true';
    const batches = await MaterialBatch.findByType(req.params.materialType, includeExpired);
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batches', async (req, res) => {
  try {
    const {
      material_type,
      batch_number,
      total_quantity,
      remaining_quantity,
      supplier,
      receive_date,
      expiry_date,
      params,
      unit_price
    } = req.body;

    if (!material_type || !batch_number || total_quantity === undefined ||
        remaining_quantity === undefined || !receive_date || !expiry_date ||
        !params || typeof params !== 'object') {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (remaining_quantity > total_quantity) {
      return res.status(400).json({ error: '剩余量不能大于入库量' });
    }

    if (remaining_quantity < 0 || total_quantity < 0) {
      return res.status(400).json({ error: '数量不能为负数' });
    }

    if (unit_price !== undefined && unit_price < 0) {
      return res.status(400).json({ error: '单价不能为负数' });
    }

    const id = await MaterialBatch.create({
      material_type,
      batch_number,
      total_quantity,
      remaining_quantity,
      supplier,
      receive_date,
      expiry_date,
      params,
      unit_price
    });

    const batch = await MaterialBatch.findById(id);
    res.status(201).json(batch);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: '批次号已存在' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/batches/:id/remaining', async (req, res) => {
  try {
    const { remaining_quantity } = req.body;
    
    if (remaining_quantity === undefined || remaining_quantity < 0) {
      return res.status(400).json({ error: '有效的剩余量是必需的' });
    }

    const existing = await MaterialBatch.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '原料批次不存在' });
    }

    if (remaining_quantity > existing.total_quantity) {
      return res.status(400).json({ error: '剩余量不能大于入库量' });
    }

    await MaterialBatch.updateRemaining(req.params.id, remaining_quantity);
    const batch = await MaterialBatch.findById(req.params.id);
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/batches/:id', async (req, res) => {
  try {
    const existing = await MaterialBatch.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '原料批次不存在' });
    }

    await MaterialBatch.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/batches/:id/unlock', async (req, res) => {
  try {
    const { unlock_reason, unlocked_by } = req.body;
    
    if (!unlock_reason) {
      return res.status(400).json({ error: '解锁原因是必需的' });
    }
    if (!unlocked_by) {
      return res.status(400).json({ error: '解锁人是必需的' });
    }

    const existing = await MaterialBatch.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: '原料批次不存在' });
    }

    const result = await MaterialLock.unlock(req.params.id, unlock_reason, unlocked_by);
    
    res.json({
      success: true,
      message: '解锁成功',
      lock_status: {
        is_locked: result.is_locked === 1,
        unlock_reason: result.unlock_reason,
        unlocked_by: result.unlocked_by,
        unlocked_at: result.unlocked_at
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/substitutions', async (req, res) => {
  try {
    const rules = await SubstitutionRule.findAll();
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/substitutions/for/:originalType', async (req, res) => {
  try {
    const rules = await SubstitutionRule.findByOriginal(req.params.originalType);
    res.json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/substitutions', async (req, res) => {
  try {
    const { original_type, substitute_type, correction_factor } = req.body;
    
    if (!original_type || !substitute_type || correction_factor === undefined) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (correction_factor <= 0) {
      return res.status(400).json({ error: '修正系数必须大于0' });
    }

    if (original_type === substitute_type) {
      return res.status(400).json({ error: '原原料和替代原料不能相同' });
    }

    const result = await SubstitutionRule.create(original_type, substitute_type, correction_factor);
    res.status(201).json({
      id: result.lastID,
      original_type,
      substitute_type,
      correction_factor
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/substitutions/:id', async (req, res) => {
  try {
    await SubstitutionRule.delete(req.params.id);
    res.json({ message: '删除成功' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
