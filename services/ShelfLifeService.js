const { all, get } = require('../config/database');
const MaterialBatch = require('../models/MaterialBatch');
const ShelfLifeRule = require('../models/ShelfLifeRule');
const Formula = require('../models/Formula');

function calculateDaysToExpiry(expiryDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  const diffTime = expiry - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function getRiskLevel(daysToExpiry) {
  if (daysToExpiry > 30) return 'safe';
  if (daysToExpiry >= 15) return 'warning';
  return 'critical';
}

async function assessBatch(batch) {
  const daysToExpiry = calculateDaysToExpiry(batch.expiry_date);
  const rules = await ShelfLifeRule.findByMaterialType(batch.material_type);
  
  const estimatedParams = {};
  let usable = true;

  for (const [paramName, originalValue] of Object.entries(batch.params)) {
    const rule = rules.find(r => r.param_name === paramName);
    
    if (rule && daysToExpiry <= rule.decay_start_days) {
      const daysDecaying = rule.decay_start_days - daysToExpiry;
      const estimated = originalValue - (daysDecaying * rule.decay_rate);
      estimatedParams[paramName] = Number(estimated.toFixed(4));
      
      if (estimated < rule.min_value) {
        usable = false;
      }
    } else {
      estimatedParams[paramName] = Number(Number(originalValue).toFixed(4));
    }
  }

  if (daysToExpiry < 0) {
    usable = false;
  }

  return {
    batch_id: batch.id,
    batch_number: batch.batch_number,
    material_type: batch.material_type,
    remaining_quantity: batch.remaining_quantity,
    expiry_date: batch.expiry_date,
    days_to_expiry: daysToExpiry,
    estimated_params: estimatedParams,
    usable,
    risk_level: getRiskLevel(daysToExpiry)
  };
}

async function assessAllBatches(includeExpired = false) {
  const batches = await MaterialBatch.findAll(includeExpired, false, '合格');
  const assessments = [];

  for (const batch of batches) {
    const assessment = await assessBatch(batch);
    assessments.push(assessment);
  }

  assessments.sort((a, b) => {
    const levelOrder = { critical: 0, warning: 1, safe: 2 };
    return levelOrder[a.risk_level] - levelOrder[b.risk_level];
  });

  return assessments;
}

async function getDailyConsumptionStats() {
  const stats = await all(`
    SELECT 
      pbm.material_type,
      SUM(pbm.quantity_used) as total_quantity,
      COUNT(DISTINCT DATE(pb.production_time)) as days_count
    FROM product_batch_materials pbm
    JOIN product_batches pb ON pbm.product_batch_id = pb.id
    WHERE pb.production_time >= date('now', '-30 days')
    GROUP BY pbm.material_type
  `);

  const dailyConsumption = {};
  for (const stat of stats) {
    if (stat.days_count > 0) {
      dailyConsumption[stat.material_type] = stat.total_quantity / stat.days_count;
    }
  }

  return dailyConsumption;
}

async function generateAlerts() {
  const dailyConsumption = await getDailyConsumptionStats();
  const assessments = await assessAllBatches(false);
  const alerts = [];

  for (const assessment of assessments) {
    if (assessment.risk_level !== 'critical') continue;
    if (assessment.days_to_expiry < 0) continue;
    
    const dailyAvg = dailyConsumption[assessment.material_type];
    if (!dailyAvg || dailyAvg === 0) continue;

    const maxUsableQuantity = dailyAvg * assessment.days_to_expiry;
    
    if (assessment.remaining_quantity > maxUsableQuantity) {
      const wastedQuantity = assessment.remaining_quantity - maxUsableQuantity;
      alerts.push({
        batch_id: assessment.batch_id,
        batch_number: assessment.batch_number,
        material_type: assessment.material_type,
        remaining_quantity: assessment.remaining_quantity,
        days_to_expiry: assessment.days_to_expiry,
        daily_avg_consumption: Number(dailyAvg.toFixed(2)),
        max_usable_quantity: Number(maxUsableQuantity.toFixed(2)),
        estimated_waste_quantity: Number(wastedQuantity.toFixed(2)),
        estimated_waste_percent: Number(((wastedQuantity / assessment.remaining_quantity) * 100).toFixed(1))
      });
    }
  }

  return alerts;
}

async function generateSchedule(formulaId, dailyProductionQuantity, planningDays) {
  const formula = await Formula.findById(formulaId);
  if (!formula) {
    throw new Error('配方不存在');
  }

  const dailyMaterialRequirements = {};
  for (const row of formula.rows) {
    const rowDailyRequired = (row.standard_quantity / 100) * dailyProductionQuantity;
    
    if (dailyMaterialRequirements[row.material_type]) {
      dailyMaterialRequirements[row.material_type].standard_quantity += row.standard_quantity;
      dailyMaterialRequirements[row.material_type].daily_required += rowDailyRequired;
      dailyMaterialRequirements[row.material_type].rows.push({
        row_index: row.row_index,
        standard_quantity: row.standard_quantity
      });
    } else {
      dailyMaterialRequirements[row.material_type] = {
        standard_quantity: row.standard_quantity,
        daily_required: rowDailyRequired,
        rows: [{
          row_index: row.row_index,
          standard_quantity: row.standard_quantity
        }]
      };
    }
  }

  const materialInventories = {};
  const assessments = await assessAllBatches(false);
  
  for (const materialType of Object.keys(dailyMaterialRequirements)) {
    const materialBatches = assessments
      .filter(a => a.material_type === materialType && a.usable && a.remaining_quantity > 0)
      .sort((a, b) => a.days_to_expiry - b.days_to_expiry);
    
    materialInventories[materialType] = materialBatches.map(b => ({
      ...b,
      current_remaining: b.remaining_quantity
    }));
  }

  const schedule = [];
  const wasteWarnings = [];
  let actualPlanningDays = 0;

  for (let day = 1; day <= planningDays; day++) {
    const daySchedule = {
      day,
      date: getFutureDate(day - 1),
      material_usages: {},
      can_produce: true
    };

    for (const [materialType, req] of Object.entries(dailyMaterialRequirements)) {
      const inventory = materialInventories[materialType] || [];
      let remainingRequired = req.daily_required;
      const usages = [];

      for (const batch of inventory) {
        if (remainingRequired <= 0) break;
        if (batch.current_remaining <= 0) continue;

        const batchDaysToExpiry = batch.days_to_expiry - (day - 1);
        if (batchDaysToExpiry < 0) continue;

        const takeQuantity = Math.min(batch.current_remaining, remainingRequired);
        usages.push({
          batch_id: batch.batch_id,
          batch_number: batch.batch_number,
          quantity: Number(takeQuantity.toFixed(4)),
          days_to_expiry_at_usage: batchDaysToExpiry
        });

        batch.current_remaining -= takeQuantity;
        remainingRequired -= takeQuantity;
      }

      if (remainingRequired > 0.001) {
        daySchedule.can_produce = false;
        daySchedule.material_usages[materialType] = {
          usages,
          shortage: Number(remainingRequired.toFixed(4))
        };
      } else {
        daySchedule.material_usages[materialType] = {
          usages,
          shortage: 0
        };
      }
    }

    if (!daySchedule.can_produce) {
      break;
    }

    schedule.push(daySchedule);
    actualPlanningDays = day;
  }

  for (const [materialType, inventory] of Object.entries(materialInventories)) {
    for (const batch of inventory) {
      if (batch.current_remaining <= 0) continue;
      
      const remainingDays = batch.days_to_expiry;
      let willBeUsed = false;
      
      for (let day = 1; day <= actualPlanningDays; day++) {
        if (remainingDays >= day) {
          willBeUsed = true;
          break;
        }
      }

      if (!willBeUsed && remainingDays < actualPlanningDays) {
        wasteWarnings.push({
          batch_id: batch.batch_id,
          batch_number: batch.batch_number,
          material_type: materialType,
          remaining_quantity: Number(batch.current_remaining.toFixed(2)),
          days_to_expiry: remainingDays,
          will_expire_before_use: true
        });
      }
    }
  }

  return {
    formula_id: formulaId,
    formula_name: formula.name,
    daily_production_quantity: dailyProductionQuantity,
    planned_days: planningDays,
    actual_scheduled_days: actualPlanningDays,
    schedule,
    waste_warnings: wasteWarnings.sort((a, b) => a.days_to_expiry - b.days_to_expiry)
  };
}

function getFutureDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split('T')[0];
}

module.exports = {
  assessBatch,
  assessAllBatches,
  generateAlerts,
  generateSchedule,
  calculateDaysToExpiry,
  getRiskLevel
};
