const MaterialBatch = require('../models/MaterialBatch');
const SubstitutionRule = require('../models/SubstitutionRule');
const Reservation = require('../models/Reservation');
const Contraindication = require('../models/Contraindication');
const { calculateDaysToExpiry } = require('./ShelfLifeService');

const MAX_BATCHES_PER_ROW = 3;
const MAX_CANDIDATE_BATCHES = 5;
const TIME_LIMIT_MS = 3000;

const WEIGHT_STRATEGIES = [
  { cost: 1, freshness: 0, quality: 0, name: 'cost_only' },
  { cost: 0, freshness: 1, quality: 0, name: 'freshness_only' },
  { cost: 0, freshness: 0, quality: 1, name: 'quality_only' },
  { cost: 0.6, freshness: 0.2, quality: 0.2, name: 'cost_heavy' },
  { cost: 0.2, freshness: 0.6, quality: 0.2, name: 'freshness_heavy' },
  { cost: 0.2, freshness: 0.2, quality: 0.6, name: 'quality_heavy' }
];

class BatchOptimizer {
  static async optimize(formula, plannedQuantity, userWeights) {
    const startTime = Date.now();
    const scaleFactor = plannedQuantity / 100;

    const allMaterialTypes = this._getAllMaterialTypes(formula);
    const batchMetrics = await this._collectBatchMetrics(allMaterialTypes, formula);

    const candidates = [];

    for (const strategy of WEIGHT_STRATEGIES) {
      if (Date.now() - startTime > TIME_LIMIT_MS) break;

      const plan = await this._calculatePlanWithWeights(
        formula,
        plannedQuantity,
        scaleFactor,
        strategy,
        batchMetrics,
        startTime
      );

      if (plan && plan.success) {
        const scores = this._calculateScores(plan, batchMetrics, userWeights);
        candidates.push({
          strategy: strategy.name,
          plan,
          scores
        });
      }
    }

    const paretoFront = this._computeParetoFront(candidates);
    const dominatedCount = candidates.length - paretoFront.length;

    const solutions = paretoFront
      .map(candidate => ({
        total_score: candidate.scores.weightedTotal,
        scores: {
          cost: Math.round(candidate.scores.cost * 10) / 10,
          freshness: Math.round(candidate.scores.freshness * 10) / 10,
          quality: Math.round(candidate.scores.quality * 10) / 10
        },
        rows: candidate.plan.rows,
        total_cost: candidate.plan.total_cost,
        estimated_product_params: candidate.plan.estimated_product_params
      }))
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 3)
      .map((sol, idx) => ({
        rank: idx + 1,
        ...sol
      }));

    return {
      solutions,
      weights_used: userWeights,
      dominated_count: dominatedCount,
      calculation_time_ms: Date.now() - startTime
    };
  }

  static _getAllMaterialTypes(formula) {
    const types = new Set();
    for (const row of formula.rows) {
      types.add(row.material_type);
    }
    return Array.from(types);
  }

  static async _collectBatchMetrics(materialTypes, formula) {
    const metrics = {};

    for (const materialType of materialTypes) {
      const batches = await MaterialBatch.findByType(materialType, false, false, '合格');
      const batchIds = batches.map(b => b.id);
      const reservedMap = await Reservation.getReservedQuantityMap(batchIds);

      const typeFormulaRow = formula.rows.find(r => r.material_type === materialType);
      const paramName = typeFormulaRow ? typeFormulaRow.param_name : null;

      let targetValue = null;
      if (typeFormulaRow && paramName) {
        const hasMin = typeFormulaRow.param_min !== null && typeFormulaRow.param_min !== undefined;
        const hasMax = typeFormulaRow.param_max !== null && typeFormulaRow.param_max !== undefined;
        if (hasMin && hasMax) {
          targetValue = (typeFormulaRow.param_min + typeFormulaRow.param_max) / 2;
        } else if (hasMin) {
          targetValue = typeFormulaRow.param_min * 1.01;
        } else if (hasMax) {
          targetValue = typeFormulaRow.param_max * 0.99;
        }
      }

      const batchData = batches.map(batch => {
        const reserved = reservedMap[batch.id] || 0;
        const availableQuantity = Math.max(0, batch.remaining_quantity - reserved);
        const daysToExpiry = calculateDaysToExpiry(batch.expiry_date);
        const paramValue = paramName ? batch.params[paramName] : null;
        const paramDistance = targetValue !== null && paramValue !== null && paramValue !== undefined
          ? Math.abs(paramValue - targetValue)
          : Infinity;

        return {
          batch,
          unit_price: batch.unit_price || 0,
          days_to_expiry: daysToExpiry,
          param_distance: paramDistance,
          available_quantity: availableQuantity,
          usable: daysToExpiry >= 0 && availableQuantity > 0
        };
      }).filter(b => b.usable);

      if (batchData.length === 0) {
        metrics[materialType] = { batches: [], ranges: null };
        continue;
      }

      const prices = batchData.map(b => b.unit_price);
      const expiries = batchData.map(b => b.days_to_expiry);
      const distances = batchData.map(b => b.param_distance).filter(d => d !== Infinity);

      const ranges = {
        cost: { min: Math.min(...prices), max: Math.max(...prices) },
        freshness: { min: Math.min(...expiries), max: Math.max(...expiries) },
        quality: distances.length > 0
          ? { min: Math.min(...distances), max: Math.max(...distances) }
          : { min: 0, max: 1 }
      };

      metrics[materialType] = {
        batches: batchData,
        ranges,
        paramName,
        targetValue
      };
    }

    return metrics;
  }

  static async _calculatePlanWithWeights(formula, plannedQuantity, scaleFactor, weights, batchMetrics, startTime) {
    const result = {
      success: false,
      rows: [],
      estimated_product_params: {},
      total_cost: 0
    };

    for (let rowIndex = 0; rowIndex < formula.rows.length; rowIndex++) {
      if (Date.now() - startTime > TIME_LIMIT_MS) return null;

      const row = formula.rows[rowIndex];
      const requiredQuantity = row.standard_quantity * scaleFactor;
      const minQuantity = requiredQuantity * (1 - row.tolerance_percent / 100);
      const maxQuantity = requiredQuantity * (1 + row.tolerance_percent / 100);

      const rowResult = await this._calculateRowWithWeights(
        row,
        requiredQuantity,
        minQuantity,
        maxQuantity,
        weights,
        batchMetrics,
        startTime
      );

      if (!rowResult) {
        const substitutions = await SubstitutionRule.findByOriginal(row.material_type);
        let substituted = false;

        for (const sub of substitutions) {
          if (Date.now() - startTime > TIME_LIMIT_MS) return null;

          const subRequiredQuantity = requiredQuantity * sub.correction_factor;
          const subMinQuantity = subRequiredQuantity * (1 - row.tolerance_percent / 100);
          const subMaxQuantity = subRequiredQuantity * (1 + row.tolerance_percent / 100);

          const subRow = {
            ...row,
            material_type: sub.substitute_type
          };

          const subResult = await this._calculateRowWithWeights(
            subRow,
            subRequiredQuantity,
            subMinQuantity,
            subMaxQuantity,
            weights,
            batchMetrics,
            startTime
          );

          if (subResult) {
            subResult.batches.forEach(b => b.is_substitute = true);
            subResult.batches.forEach(b => b.correction_factor = sub.correction_factor);
            subResult.material_type = sub.substitute_type;
            subResult.original_type = row.material_type;
            subResult.cost = subResult.batches.reduce((sum, b) =>
              sum + b.quantity * (b.unit_price || 0), 0);
            result.total_cost += subResult.cost;
            result.rows.push(subResult);
            substituted = true;
            break;
          }
        }

        if (!substituted) return null;
      } else {
        rowResult.batches.forEach(b => b.is_substitute = false);
        rowResult.cost = rowResult.batches.reduce((sum, b) =>
          sum + b.quantity * (b.unit_price || 0), 0);
        result.total_cost += rowResult.cost;
        result.rows.push(rowResult);
      }
    }

    const contraindicationResult = await this._checkContraindications(result.rows);
    if (contraindicationResult.critical.length > 0) return null;

    result.success = true;
    result.estimated_product_params = this._calculateEstimatedProductParams(
      formula,
      result.rows,
      scaleFactor
    );

    return result;
  }

  static async _calculateRowWithWeights(row, requiredQuantity, minQuantity, maxQuantity, weights, batchMetrics, startTime) {
    const typeMetrics = batchMetrics[row.material_type];
    if (!typeMetrics || typeMetrics.batches.length === 0) return null;

    const sortedBatches = this._sortBatchesByWeightedScore(typeMetrics.batches, typeMetrics.ranges, weights);
    const topCandidates = sortedBatches.slice(0, MAX_CANDIDATE_BATCHES);

    const singleBatchResult = this._trySingleBatch(
      topCandidates,
      requiredQuantity,
      minQuantity,
      maxQuantity,
      row,
      typeMetrics.paramName
    );

    if (singleBatchResult) {
      return {
        success: true,
        row_index: row.row_index,
        material_type: row.material_type,
        required_quantity: requiredQuantity,
        min_quantity: minQuantity,
        max_quantity: maxQuantity,
        batches: singleBatchResult.batches,
        mixed_param_value: singleBatchResult.mixedParam
      };
    }

    const multiBatchResult = this._tryMultipleBatches(
      topCandidates,
      requiredQuantity,
      minQuantity,
      maxQuantity,
      row,
      typeMetrics.paramName,
      startTime
    );

    if (multiBatchResult) {
      return {
        success: true,
        row_index: row.row_index,
        material_type: row.material_type,
        required_quantity: requiredQuantity,
        min_quantity: minQuantity,
        max_quantity: maxQuantity,
        batches: multiBatchResult.batches,
        mixed_param_value: multiBatchResult.mixedParam
      };
    }

    return null;
  }

  static _sortBatchesByWeightedScore(batches, ranges, weights) {
    return [...batches].sort((a, b) => {
      const scoreA = this._calculateBatchScore(a, ranges, weights);
      const scoreB = this._calculateBatchScore(b, ranges, weights);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.available_quantity - a.available_quantity;
    });
  }

  static _calculateBatchScore(batchData, ranges, weights) {
    const costScore = this._normalizeValue(batchData.unit_price, ranges.cost, true);
    const freshnessScore = this._normalizeValue(batchData.days_to_expiry, ranges.freshness, false);
    const qualityScore = this._normalizeValue(batchData.param_distance, ranges.quality, true);

    return costScore * weights.cost +
           freshnessScore * weights.freshness +
           qualityScore * weights.quality;
  }

  static _normalizeValue(value, range, lowerIsBetter) {
    if (range.min === range.max) return 50;
    const normalized = (value - range.min) / (range.max - range.min);
    return lowerIsBetter ? (1 - normalized) * 100 : normalized * 100;
  }

  static _trySingleBatch(candidates, requiredQuantity, minQuantity, maxQuantity, row, paramName) {
    for (const candidate of candidates) {
      if (candidate.available_quantity < minQuantity) continue;

      const paramValue = paramName ? candidate.batch.params[paramName] : null;
      if (paramName) {
        if (paramValue === undefined || paramValue === null) continue;
        if (!this._isParamInRange(paramValue, row)) continue;
      }

      const takeQuantity = Math.min(candidate.available_quantity, maxQuantity);
      if (takeQuantity < minQuantity) continue;

      return {
        batches: [{
          material_batch_id: candidate.batch.id,
          batch_number: candidate.batch.batch_number,
          material_type: candidate.batch.material_type,
          quantity: takeQuantity,
          param_value: paramValue,
          unit_price: candidate.batch.unit_price
        }],
        mixedParam: paramValue
      };
    }
    return null;
  }

  static _tryMultipleBatches(candidates, requiredQuantity, minQuantity, maxQuantity, row, paramName, startTime) {
    const availableCandidates = candidates.filter(c => {
      if (c.available_quantity <= 0) return false;
      if (!paramName) return true;
      const paramValue = c.batch.params[paramName];
      return paramValue !== undefined &&
             paramValue !== null &&
             this._isParamInRange(paramValue, row);
    });

    if (availableCandidates.length < 2) return null;

    const n = Math.min(availableCandidates.length, MAX_CANDIDATE_BATCHES);

    for (let k = 2; k <= MAX_BATCHES_PER_ROW; k++) {
      if (Date.now() - startTime > TIME_LIMIT_MS) return null;

      const combinations = this._getCombinations(n, k);

      for (const combo of combinations) {
        if (Date.now() - startTime > TIME_LIMIT_MS) return null;

        const selectedBatches = combo.map(i => availableCandidates[i]);
        const totalAvailable = selectedBatches.reduce((sum, b) => sum + b.available_quantity, 0);

        if (totalAvailable < minQuantity) continue;

        const allocation = this._allocateQuantities(
          selectedBatches,
          requiredQuantity,
          minQuantity,
          maxQuantity,
          row,
          paramName
        );

        if (allocation) {
          return allocation;
        }
      }
    }

    return null;
  }

  static _allocateQuantities(batches, requiredQuantity, minQuantity, maxQuantity, row, paramName) {
    const totalAvailable = batches.reduce((sum, b) => sum + b.available_quantity, 0);
    const targetTotal = Math.min(Math.max(requiredQuantity, minQuantity), Math.min(maxQuantity, totalAvailable));

    if (targetTotal < minQuantity) return null;

    const quantities = batches.map(b => Math.min(b.available_quantity, targetTotal));
    const totalQty = quantities.reduce((a, b) => a + b, 0);

    if (totalQty < targetTotal) return null;

    const ratios = quantities.map(q => q / totalQty);
    const finalQuantities = ratios.map(r => r * targetTotal);

    const weightedParam = !paramName ? null : finalQuantities.reduce((sum, q, i) => {
      const paramVal = batches[i].batch.params[paramName];
      return paramVal !== undefined && paramVal !== null ? sum + q * paramVal : sum;
    }, 0) / targetTotal;

    if (paramName && !this._isParamInRange(weightedParam, row)) {
      return null;
    }

    return {
      batches: finalQuantities.map((q, i) => ({
        material_batch_id: batches[i].batch.id,
        batch_number: batches[i].batch.batch_number,
        material_type: batches[i].batch.material_type,
        quantity: Math.round(q * 1000) / 1000,
        param_value: paramName ? batches[i].batch.params[paramName] : null,
        unit_price: batches[i].batch.unit_price
      })),
      mixedParam: weightedParam
    };
  }

  static _getCombinations(n, k) {
    const result = [];

    function backtrack(start, current) {
      if (current.length === k) {
        result.push([...current]);
        return;
      }

      for (let i = start; i < n; i++) {
        current.push(i);
        backtrack(i + 1, current);
        current.pop();
      }
    }

    backtrack(0, []);
    return result;
  }

  static _isParamInRange(value, row) {
    const hasMin = row.param_min !== null && row.param_min !== undefined;
    const hasMax = row.param_max !== null && row.param_max !== undefined;

    if (hasMin && value < row.param_min) return false;
    if (hasMax && value > row.param_max) return false;
    return true;
  }

  static _calculateScores(plan, batchMetrics, userWeights) {
    let totalCost = 0;
    let totalWeightedFreshness = 0;
    let totalWeightedQuality = 0;
    let totalQuantity = 0;

    for (const row of plan.rows) {
      for (const batch of row.batches) {
        const metrics = batchMetrics[row.material_type];
        if (!metrics) continue;

        const batchData = metrics.batches.find(b => b.batch.id === batch.material_batch_id);
        if (!batchData) continue;

        const qty = batch.quantity;
        totalCost += qty * (batch.unit_price || 0);
        totalWeightedFreshness += qty * batchData.days_to_expiry;
        totalWeightedQuality += qty * (100 - this._normalizeValue(batchData.param_distance, metrics.ranges.quality, true));
        totalQuantity += qty;
      }
    }

    if (totalQuantity === 0) {
      return { cost: 0, freshness: 0, quality: 0, weightedTotal: 0 };
    }

    const allTypes = Object.keys(batchMetrics);
    let globalMinCost = Infinity, globalMaxCost = -Infinity;
    let globalMinFresh = Infinity, globalMaxFresh = -Infinity;
    let globalMinQual = Infinity, globalMaxQual = Infinity;

    for (const type of allTypes) {
      const m = batchMetrics[type];
      if (!m || !m.ranges) continue;
      globalMinCost = Math.min(globalMinCost, m.ranges.cost.min);
      globalMaxCost = Math.max(globalMaxCost, m.ranges.cost.max);
      globalMinFresh = Math.min(globalMinFresh, m.ranges.freshness.min);
      globalMaxFresh = Math.max(globalMaxFresh, m.ranges.freshness.max);
      globalMinQual = Math.min(globalMinQual, m.ranges.quality.min);
      globalMaxQual = Math.max(globalMaxQual, m.ranges.quality.max);
    }

    const avgCost = totalCost / totalQuantity;
    const avgFreshness = totalWeightedFreshness / totalQuantity;
    const avgQuality = totalWeightedQuality / totalQuantity;

    const costScore = globalMinCost === globalMaxCost ? 50 :
      ((globalMaxCost - avgCost) / (globalMaxCost - globalMinCost)) * 100;

    const freshnessScore = globalMinFresh === globalMaxFresh ? 50 :
      ((avgFreshness - globalMinFresh) / (globalMaxFresh - globalMinFresh)) * 100;

    const qualityScore = globalMinQual === globalMaxQual ? 50 :
      ((avgQuality - globalMinQual) / (globalMaxQual - globalMinQual)) * 100;

    const clampedCost = Math.max(0, Math.min(100, costScore));
    const clampedFreshness = Math.max(0, Math.min(100, freshnessScore));
    const clampedQuality = Math.max(0, Math.min(100, qualityScore));

    const weightedTotal = clampedCost * userWeights.cost +
                          clampedFreshness * userWeights.freshness +
                          clampedQuality * userWeights.quality;

    return {
      cost: clampedCost,
      freshness: clampedFreshness,
      quality: clampedQuality,
      weightedTotal
    };
  }

  static _computeParetoFront(candidates) {
    const front = [];

    for (let i = 0; i < candidates.length; i++) {
      let dominated = false;

      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;

        if (this._dominates(candidates[j], candidates[i])) {
          dominated = true;
          break;
        }
      }

      if (!dominated) {
        front.push(candidates[i]);
      }
    }

    return front;
  }

  static _dominates(a, b) {
    const aScores = a.scores;
    const bScores = b.scores;

    const aBetterOrEqual =
      aScores.cost >= bScores.cost &&
      aScores.freshness >= bScores.freshness &&
      aScores.quality >= bScores.quality;

    const aStrictlyBetter =
      aScores.cost > bScores.cost ||
      aScores.freshness > bScores.freshness ||
      aScores.quality > bScores.quality;

    return aBetterOrEqual && aStrictlyBetter;
  }

  static _calculateEstimatedProductParams(formula, planRows, scaleFactor) {
    const estimated = {};
    const paramDeviations = {};

    planRows.forEach(planRow => {
      const formulaRow = formula.rows.find(r => r.row_index === planRow.row_index);
      if (!formulaRow) return;

      const totalUsed = planRow.batches.reduce((sum, b) => sum + b.quantity, 0);
      const coeff = formulaRow.contribution_coefficient || 0;
      if (coeff === 0) return;

      const avgParam = planRow.mixed_param_value;
      if (avgParam === null || avgParam === undefined) return;

      const hasMin = formulaRow.param_min !== null && formulaRow.param_min !== undefined;
      const hasMax = formulaRow.param_max !== null && formulaRow.param_max !== undefined;

      let standardValue;
      if (hasMin && hasMax) {
        standardValue = (formulaRow.param_min + formulaRow.param_max) / 2;
      } else if (hasMin) {
        standardValue = formulaRow.param_min * 1.01;
      } else if (hasMax) {
        standardValue = formulaRow.param_max * 0.99;
      } else {
        standardValue = avgParam;
      }

      if (standardValue === 0) return;

      const deviationPercent = ((avgParam - standardValue) / standardValue) * 100;

      formula.specs.forEach(spec => {
        if (!paramDeviations[spec.param_name]) {
          paramDeviations[spec.param_name] = { weightedDeviation: 0, totalWeight: 0 };
        }
        paramDeviations[spec.param_name].weightedDeviation += deviationPercent * coeff * totalUsed;
        paramDeviations[spec.param_name].totalWeight += coeff * totalUsed;
      });
    });

    formula.specs.forEach(spec => {
      const baseValue = (spec.param_min + spec.param_max) / 2;
      const range = spec.param_max - spec.param_min;

      let adjustmentPercent = 0;
      if (paramDeviations[spec.param_name] && paramDeviations[spec.param_name].totalWeight > 0) {
        adjustmentPercent = paramDeviations[spec.param_name].weightedDeviation /
                            paramDeviations[spec.param_name].totalWeight;
        adjustmentPercent = Math.max(-10, Math.min(10, adjustmentPercent));
      }

      const adjustedValue = baseValue + (range * adjustmentPercent / 100);
      estimated[spec.param_name] = Math.round(adjustedValue * 1000) / 1000;
    });

    return estimated;
  }

  static async _checkContraindications(planRows) {
    const materialTypes = [];
    for (const row of planRows) {
      const type = row.material_type;
      if (type && !materialTypes.includes(type)) {
        materialTypes.push(type);
      }
    }

    if (materialTypes.length < 2) {
      return { critical: [], warnings: [] };
    }

    const hits = await Contraindication.findContraindicationsForTypes(materialTypes);

    const critical = [];
    const warnings = [];

    for (const hit of hits) {
      const entry = {
        type_a: hit.type_a,
        type_b: hit.type_b,
        level: hit.level,
        description: hit.description
      };

      if (hit.level === 'critical') {
        critical.push(entry);
      } else {
        warnings.push(entry);
      }
    }

    return { critical, warnings };
  }
}

module.exports = BatchOptimizer;
