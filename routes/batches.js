const express = require('express');
const router = express.Router();
const { db, beginTransaction, commit, rollback, run } = require('../config/database');
const Formula = require('../models/Formula');
const BatchPlan = require('../models/BatchPlan');
const ProductBatch = require('../models/ProductBatch');
const MaterialBatch = require('../models/MaterialBatch');
const BatchCalculator = require('../services/BatchCalculator');
const Reservation = require('../models/Reservation');
const ReservationEvent = require('../models/ReservationEvent');

router.get('/plans', async (req, res) => {
  try {
    const plans = await BatchPlan.findAll();
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/plans/:uuid', async (req, res) => {
  try {
    const plan = await BatchPlan.findByUuid(req.params.uuid) || 
                 await BatchPlan.findById(req.params.uuid);
    if (!plan) {
      return res.status(404).json({ error: '方案不存在' });
    }

    const reservations = await Reservation.findByPlanId(plan.id);
    plan.reservations = reservations;

    const remainingSeconds = await Reservation.getPlanRemainingSeconds(plan.id);
    plan.remaining_seconds = remainingSeconds;

    const renewCount = await Reservation.getPlanRenewCount(plan.id);
    plan.renew_count = renewCount;

    res.json(plan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/plan', async (req, res) => {
  try {
    const { formula_id, planned_quantity } = req.body;

    if (!formula_id || !planned_quantity || planned_quantity <= 0) {
      return res.status(400).json({ error: '缺少有效的配方ID或计划生产量' });
    }

    const formula = await Formula.findById(formula_id);
    if (!formula) {
      return res.status(404).json({ error: '配方不存在' });
    }

    const calculationResult = await BatchCalculator.calculatePlan(formula, planned_quantity);

    if (!calculationResult.success) {
      if (calculationResult.contraindication_blocked) {
        const criticalErrors = calculationResult.errors.filter(e => e.type === 'contraindication_critical');
        return res.status(422).json({
          success: false,
          error: '配伍禁忌校验失败',
          contraindication_blocked: true,
          details: criticalErrors[0].contraindications.map(c => ({
            type_a: c.type_a,
            type_b: c.type_b,
            level: c.level,
            description: c.description
          })),
          message: criticalErrors[0].contraindications.map(c =>
            `${c.type_a} 与 ${c.type_b} 存在critical等级配伍禁忌: ${c.description}`
          ).join('; ')
        });
      }
      return res.status(400).json({
        success: false,
        errors: calculationResult.errors,
        calculation_time_ms: calculationResult.calculation_time_ms
      });
    }

    let planResult;

    try {
      await beginTransaction();

      planResult = await BatchPlan.create(formula_id, planned_quantity, calculationResult);

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const reservationItems = [];

      for (const row of calculationResult.rows) {
        for (const batch of row.batches) {
          reservationItems.push({
            material_batch_id: batch.material_batch_id,
            quantity: batch.quantity,
            expires_at: expiresAt
          });
        }
      }

      await Reservation.createBatch(planResult.id, reservationItems);

      await ReservationEvent.create(planResult.id, 'created', 'system');

      await commit();
    } catch (err) {
      await rollback();
      throw err;
    }

    const reservations = await Reservation.findActiveByPlanId(planResult.id);

    res.status(201).json({
      success: true,
      plan_id: planResult.plan_uuid,
      plan_id_numeric: planResult.id,
      formula_id: formula_id,
      planned_quantity: planned_quantity,
      rows: calculationResult.rows,
      total_cost: calculationResult.total_cost,
      estimated_product_params: calculationResult.estimated_product_params,
      calculation_time_ms: calculationResult.calculation_time_ms,
      reservations: reservations,
      reservation_expires_at: reservations.length > 0 ? reservations[0].expires_at : null,
      warnings: calculationResult.contraindication_warnings || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/execute', async (req, res) => {
  try {
    const { plan_id, operator, actual_yield } = req.body;

    if (!plan_id) {
      return res.status(400).json({ error: '缺少方案ID' });
    }

    const plan = await BatchPlan.findByUuid(plan_id) || await BatchPlan.findById(plan_id);
    if (!plan) {
      return res.status(404).json({ error: '方案不存在' });
    }

    if (plan.status === 'executed') {
      return res.status(400).json({ error: '该方案已执行，不能重复执行' });
    }

    if (plan.status === 'executing') {
      return res.status(400).json({ error: '该方案正在执行中，请稍候再试' });
    }

    if (plan.status === 'expired') {
      return res.status(400).json({ error: '预占已过期，请重新计算方案' });
    }

    if (plan.status === 'failed') {
      return res.status(400).json({ error: '该方案已失败，不能执行' });
    }

    const reservationActive = await Reservation.isPlanReservationActive(plan.id);
    if (!reservationActive) {
      if (plan.status === 'pending') {
        await BatchPlan.updateStatus(plan.id, 'expired');
      }
      return res.status(400).json({ error: '预占已过期，请重新计算方案' });
    }

    const planData = plan.plan_data;
    if (!planData || !planData.rows || planData.rows.length === 0) {
      return res.status(400).json({ error: '方案数据无效' });
    }

    const totalYield = actual_yield || plan.planned_quantity;
    if (totalYield <= 0) {
      return res.status(400).json({ error: '实际产量必须大于0' });
    }

    const materialUsages = [];
    const validationErrors = [];
    
    for (const row of planData.rows) {
      for (const batch of row.batches) {
        const existingBatch = await MaterialBatch.findById(batch.material_batch_id);
        if (!existingBatch) {
          validationErrors.push(`原料批次 ${batch.batch_number} 不存在`);
          continue;
        }

        if (new Date(existingBatch.expiry_date) < new Date()) {
          validationErrors.push(`原料批次 ${batch.batch_number} 已过期`);
          continue;
        }

        materialUsages.push({
          material_batch_id: batch.material_batch_id,
          formula_row_id: row.row_index,
          material_type: batch.material_type,
          quantity_used: batch.quantity,
          is_substitute: batch.is_substitute || false,
          batch_number: batch.batch_number
        });
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        success: false,
        errors: validationErrors 
      });
    }

    let productBatchId = null;
    
    try {
      await beginTransaction();

      const updateResult = await run(`
        UPDATE batch_plans SET status = 'executing' WHERE id = ? AND status = 'pending'
      `, [plan.id]);

      if (updateResult.changes === 0) {
        await rollback();
        const currentPlan = await BatchPlan.findById(plan.id);
        return res.status(400).json({ 
          error: `方案状态已变更为"${currentPlan.status}"，无法执行` 
        });
      }

      for (const usage of materialUsages) {
        const decreaseResult = await run(`
          UPDATE material_batches 
          SET remaining_quantity = remaining_quantity - ? 
          WHERE id = ? AND remaining_quantity >= ?
        `, [usage.quantity_used, usage.material_batch_id, usage.quantity_used]);

        if (decreaseResult.changes === 0) {
          const batch = await MaterialBatch.findById(usage.material_batch_id);
          throw new Error(`原料批次 ${usage.batch_number} 扣减失败，当前剩余${batch ? batch.remaining_quantity : '未知'}kg`);
        }
      }

      await Reservation.markExecuted(plan.id);

      const productBatchNumber = 'P' + Date.now() + '-' + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      
      const insertResult = await run(`
        INSERT INTO product_batches 
        (batch_number, formula_id, plan_id, operator, total_yield)
        VALUES (?, ?, ?, ?, ?)
      `, [
        productBatchNumber,
        plan.formula_id,
        plan.id,
        operator || 'system',
        totalYield
      ]);

      productBatchId = insertResult.lastID;

      for (const usage of materialUsages) {
        const paramSnapshot = await MaterialBatch.getParams(usage.material_batch_id);
        await run(`
          INSERT INTO product_batch_materials 
          (product_batch_id, material_batch_id, formula_row_id, material_type, 
           quantity_used, is_substitute, param_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          productBatchId,
          usage.material_batch_id,
          usage.formula_row_id,
          usage.material_type,
          usage.quantity_used,
          usage.is_substitute ? 1 : 0,
          JSON.stringify(paramSnapshot)
        ]);
      }

      await run(`
        UPDATE batch_plans SET status = 'executed' WHERE id = ?
      `, [plan.id]);

      await commit();

    } catch (err) {
      await rollback();
      await run(`
        UPDATE batch_plans SET status = 'pending' WHERE id = ? AND status = 'executing'
      `, [plan.id]).catch(() => {});
      throw err;
    }

    const productBatch = await ProductBatch.findById(productBatchId);
    const materials = await ProductBatch.getMaterials(productBatchId);

    res.status(201).json({
      success: true,
      product_batch: productBatch,
      materials_used: materials,
      message: '批次执行成功，原料库存已扣减，预占已转为实际扣减'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.findActiveAll();
    res.json(reservations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/reservations/:planId', async (req, res) => {
  try {
    const planId = req.params.planId;
    const operator = req.body.operator || 'system';

    const plan = await BatchPlan.findByUuid(planId) || await BatchPlan.findById(planId);
    if (!plan) {
      return res.status(404).json({ error: '方案不存在' });
    }

    const result = await Reservation.cancelByPlanId(plan.id, operator);

    res.json({
      success: true,
      plan_id: plan.plan_uuid,
      cancelled_count: result.changes,
      message: result.changes > 0 ? '已取消该方案的全部预占' : '该方案没有活跃的预占'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reservations/:planId/renew', async (req, res) => {
  try {
    const planId = req.params.planId;
    const operator = req.body.operator || 'system';

    const plan = await BatchPlan.findByUuid(planId) || await BatchPlan.findById(planId);
    if (!plan) {
      return res.status(404).json({ error: '方案不存在' });
    }

    const result = await Reservation.renew(plan.id, operator);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.json({
      success: true,
      expires_at: result.expires_at,
      renew_count: result.renew_count,
      remaining_seconds: result.remaining_seconds,
      message: '续期成功'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/reservations/:planId/events', async (req, res) => {
  try {
    const planId = req.params.planId;

    const plan = await BatchPlan.findByUuid(planId) || await BatchPlan.findById(planId);
    if (!plan) {
      return res.status(404).json({ error: '方案不存在' });
    }

    const events = await ReservationEvent.findByPlanId(plan.id);

    res.json({
      plan_id: plan.plan_uuid,
      events: events
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products', async (req, res) => {
  try {
    const batches = await ProductBatch.findAll();
    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:batchNumber', async (req, res) => {
  try {
    const batch = await ProductBatch.findByBatchNumber(req.params.batchNumber);
    if (!batch) {
      return res.status(404).json({ error: '成品批次不存在' });
    }
    
    const materials = await ProductBatch.getMaterials(batch.id);
    batch.materials = materials;
    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/cost-compare', async (req, res) => {
  try {
    const { formula_id, quantity } = req.query;

    if (!formula_id || !quantity || quantity <= 0) {
      return res.status(400).json({ error: '缺少有效的配方ID或数量' });
    }

    const formula = await Formula.findById(formula_id);
    if (!formula) {
      return res.status(404).json({ error: '配方不存在' });
    }

    const plannedQuantity = parseFloat(quantity);

    const optimalResult = await BatchCalculator.calculatePlan(formula, plannedQuantity);
    const cheapestResult = await BatchCalculator.calculatePlan(formula, plannedQuantity, { useCheapestBatches: true });

    if (!optimalResult.success && !cheapestResult.success) {
      return res.status(400).json({
        error: '无法计算方案',
        optimal_errors: optimalResult.errors,
        cheapest_errors: cheapestResult.errors
      });
    }

    const optimalCost = optimalResult.success ? optimalResult.total_cost : null;
    const cheapestCost = cheapestResult.success ? cheapestResult.total_cost : null;

    let premiumPercent = null;
    if (optimalCost !== null && cheapestCost !== null && cheapestCost > 0) {
      premiumPercent = ((optimalCost - cheapestCost) / cheapestCost) * 100;
      premiumPercent = Math.round(premiumPercent * 100) / 100;
    }

    res.json({
      optimal_cost: optimalCost,
      cheapest_cost: cheapestCost,
      premium_percent: premiumPercent,
      optimal_success: optimalResult.success,
      cheapest_success: cheapestResult.success
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
