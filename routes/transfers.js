const express = require('express');
const router = express.Router();
const Transfer = require('../models/Transfer');
const MaterialBatch = require('../models/MaterialBatch');

router.post('/', async (req, res) => {
  try {
    const { source_batch_id, quantity, destination_line, operator, reason } = req.body;

    if (!source_batch_id || !quantity || !destination_line || !operator) {
      return res.status(400).json({ 
        error: '缺少必要参数: source_batch_id, quantity, destination_line, operator' 
      });
    }

    if (quantity <= 0) {
      return res.status(400).json({ error: '调拨数量必须大于0' });
    }

    const transfer = await Transfer.create({
      source_batch_id,
      quantity,
      destination_line,
      operator,
      reason
    });

    res.json({
      success: true,
      transfer
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const transfers = await Transfer.findAll(status);
    
    res.json({
      success: true,
      transfers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const stats = await Transfer.getStats();
    
    res.json({
      success: true,
      ...stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const transfer = await Transfer.findById(req.params.id);
    
    if (!transfer) {
      return res.status(404).json({ error: '调拨记录不存在' });
    }

    res.json({
      success: true,
      transfer
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const { approver } = req.body;
    
    if (!approver) {
      return res.status(400).json({ error: '缺少审批人: approver' });
    }

    const transfer = await Transfer.approve(req.params.id, approver);
    
    res.json({
      success: true,
      transfer
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const { approver } = req.body;
    
    if (!approver) {
      return res.status(400).json({ error: '缺少审批人: approver' });
    }

    const transfer = await Transfer.reject(req.params.id, approver);
    
    res.json({
      success: true,
      transfer
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:batchId/history', async (req, res) => {
  try {
    const history = await Transfer.getBatchHistory(req.params.batchId);
    
    res.json({
      success: true,
      ...history
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/batch/:batchId/available', async (req, res) => {
  try {
    const available = await Transfer.getAvailableQuantity(req.params.batchId);
    const batch = await MaterialBatch.findById(req.params.batchId);
    
    if (!batch) {
      return res.status(404).json({ error: '批次不存在' });
    }

    const pendingQuantity = await Transfer.getPendingTransferQuantity(req.params.batchId);

    res.json({
      success: true,
      batch_id: batch.id,
      batch_number: batch.batch_number,
      remaining_quantity: batch.remaining_quantity,
      pending_transfer_quantity: pendingQuantity,
      available_quantity: available
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
