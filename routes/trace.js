const express = require('express');
const router = express.Router();
const MaterialBatch = require('../models/MaterialBatch');
const ProductBatch = require('../models/ProductBatch');
const Transfer = require('../models/Transfer');

router.get('/forward/:materialBatchId', async (req, res) => {
  try {
    const materialBatchId = req.params.materialBatchId;
    
    const materialBatch = await MaterialBatch.findById(materialBatchId);
    if (!materialBatch) {
      return res.status(404).json({ error: '原料批次不存在' });
    }

    const productBatches = await ProductBatch.findByMaterialBatch(materialBatchId);
    
    const totalUsed = productBatches.reduce((sum, pb) => sum + pb.quantity_used, 0);

    res.json({
      success: true,
      material_batch: {
        id: materialBatch.id,
        batch_number: materialBatch.batch_number,
        material_type: materialBatch.material_type,
        supplier: materialBatch.supplier,
        total_quantity: materialBatch.total_quantity,
        remaining_quantity: materialBatch.remaining_quantity,
        params: materialBatch.params
      },
      total_used_in_products: totalUsed,
      product_batches: productBatches.map(pb => ({
        product_batch_id: pb.id,
        product_batch_number: pb.batch_number,
        formula_id: pb.formula_id,
        production_time: pb.production_time,
        operator: pb.operator,
        quantity_used: pb.quantity_used,
        material_type: pb.material_type,
        is_substitute: pb.is_substitute === 1
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backward/:productBatchId', async (req, res) => {
  try {
    const productBatchId = req.params.productBatchId;
    
    let productBatch = await ProductBatch.findByBatchNumber(productBatchId) || 
                        await ProductBatch.findById(productBatchId);
    
    if (!productBatch) {
      return res.status(404).json({ error: '成品批次不存在' });
    }

    const materials = await ProductBatch.getMaterials(productBatch.id);

    const materialsWithTransferInfo = [];
    for (const m of materials) {
      const transferInfo = await Transfer.getTransferInfoForBatch(m.material_batch_id);
      materialsWithTransferInfo.push({
        material_batch_id: m.material_batch_id,
        batch_number: m.batch_number,
        material_type: m.material_type,
        formula_row_id: m.formula_row_id,
        quantity_used: m.quantity_used,
        is_substitute: m.is_substitute === 1,
        supplier: m.supplier,
        receive_date: m.receive_date,
        expiry_date: m.expiry_date,
        param_snapshot: m.param_snapshot,
        transfer_info: transferInfo
      });
    }

    res.json({
      success: true,
      product_batch: {
        id: productBatch.id,
        batch_number: productBatch.batch_number,
        formula_id: productBatch.formula_id,
        plan_id: productBatch.plan_id,
        production_time: productBatch.production_time,
        operator: productBatch.operator,
        total_yield: productBatch.total_yield
      },
      materials_used: materialsWithTransferInfo
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
