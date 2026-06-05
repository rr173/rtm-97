const MaterialBatch = require('../models/MaterialBatch');
const SubstitutionRule = require('../models/SubstitutionRule');
const Reservation = require('../models/Reservation');
const Contraindication = require('../models/Contraindication');

const MAX_BATCHES_PER_ROW = 3;
const MAX_CANDIDATE_BATCHES = 5;
const TIME_LIMIT_MS = 3000;

class BatchCalculator {
  static async calculatePlan(formula, plannedQuantity, options = {}) {
    const { useCheapestBatches = false } = options;
    const startTime = Date.now();
    const result = {
      success: false,
      rows: [],
      estimated_product_params: {},
      errors: [],
      calculation_time_ms: 0,
      total_cost: 0
    };

    if (formula.rows.length > 12) {
      result.errors.push({
        type: 'formula_error',
        message: '配方最多只能有12行原料'
      });
      return result;
    }

    const scaleFactor = plannedQuantity / 100;

    for (let rowIndex = 0; rowIndex < formula.rows.length; rowIndex++) {
      const row = formula.rows[rowIndex];
      const requiredQuantity = row.standard_quantity * scaleFactor;
      const minQuantity = requiredQuantity * (1 - row.tolerance_percent / 100);
      const maxQuantity = requiredQuantity * (1 + row.tolerance_percent / 100);

      const rowResult = await this._calculateRow(
        row,
        requiredQuantity,
        minQuantity,
        maxQuantity,
        startTime,
        { useCheapestBatches }
      );

      if (!rowResult.success) {
        const substitutions = await SubstitutionRule.findByOriginal(row.material_type);
        let substituted = false;

        for (const sub of substitutions) {
          if (Date.now() - startTime > TIME_LIMIT_MS) {
            result.errors.push({
              type: 'timeout',
              message: '计算超时，超过3秒限制'
            });
            result.calculation_time_ms = Date.now() - startTime;
            return result;
          }

          const subRequiredQuantity = requiredQuantity * sub.correction_factor;
          const subMinQuantity = subRequiredQuantity * (1 - row.tolerance_percent / 100);
          const subMaxQuantity = subRequiredQuantity * (1 + row.tolerance_percent / 100);

          const subRow = {
            ...row,
            material_type: sub.substitute_type
          };

          const subResult = await this._calculateRow(
            subRow,
            subRequiredQuantity,
            subMinQuantity,
            subMaxQuantity,
            startTime,
            { useCheapestBatches }
          );

          if (subResult.success) {
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

        if (!substituted) {
          result.errors.push({
            row_index: rowIndex,
            material_type: row.material_type,
            required_quantity: requiredQuantity,
            issues: rowResult.issues
          });
        }
      } else {
        rowResult.batches.forEach(b => b.is_substitute = false);
        rowResult.cost = rowResult.batches.reduce((sum, b) => 
          sum + b.quantity * (b.unit_price || 0), 0);
        result.total_cost += rowResult.cost;
        result.rows.push(rowResult);
      }
    }

    result.calculation_time_ms = Date.now() - startTime;

    if (result.errors.length === 0) {
      result.success = true;
      result.estimated_product_params = this._calculateEstimatedProductParams(
        formula,
        result.rows,
        scaleFactor
      );

      const contraindicationResult = await this._checkContraindications(result.rows);
      if (contraindicationResult.critical.length > 0) {
        result.success = false;
        result.contraindication_blocked = true;
        result.errors.push({
          type: 'contraindication_critical',
          message: '方案中包含critical等级的配伍禁忌，方案不能生成',
          contraindications: contraindicationResult.critical
        });
      } else if (contraindicationResult.warnings.length > 0) {
        result.contraindication_warnings = contraindicationResult.warnings;
      }
    }

    return result;
  }

  static async _calculateRow(row, requiredQuantity, minQuantity, maxQuantity, startTime, options = {}) {
    const { useCheapestBatches = false } = options;
    const result = {
      success: false,
      row_index: row.row_index,
      material_type: row.material_type,
      required_quantity: requiredQuantity,
      min_quantity: minQuantity,
      max_quantity: maxQuantity,
      batches: [],
      mixed_param_value: null,
      issues: [],
      cost: 0
    };

    const candidates = await MaterialBatch.findByType(row.material_type, false, false, '合格');
    
    if (candidates.length === 0) {
      result.issues.push({
        type: 'no_batches',
        message: '该类型没有可用的在库批次'
      });
      return result;
    }

    const batchIds = candidates.map(c => c.id);
    const reservedMap = await Reservation.getReservedQuantityMap(batchIds);
    for (const candidate of candidates) {
      const reserved = reservedMap[candidate.id] || 0;
      candidate.available_quantity = Math.max(0, candidate.remaining_quantity - reserved);
    }

    let sortedCandidates;
    if (useCheapestBatches) {
      sortedCandidates = this._sortCandidatesByPrice(candidates);
    } else {
      sortedCandidates = this._sortCandidatesByParamDistance(candidates, row);
    }
    const topCandidates = sortedCandidates.slice(0, MAX_CANDIDATE_BATCHES);

    const singleBatchResult = this._trySingleBatch(
      topCandidates,
      requiredQuantity,
      minQuantity,
      maxQuantity,
      row,
      useCheapestBatches
    );

    if (singleBatchResult) {
      result.success = true;
      result.batches = singleBatchResult.batches;
      result.mixed_param_value = singleBatchResult.mixedParam;
      return result;
    }

    const multiBatchResult = this._tryMultipleBatches(
      topCandidates,
      requiredQuantity,
      minQuantity,
      maxQuantity,
      row,
      startTime,
      useCheapestBatches
    );

    if (multiBatchResult) {
      result.success = true;
      result.batches = multiBatchResult.batches;
      result.mixed_param_value = multiBatchResult.mixedParam;
      return result;
    }

    result.issues = this._analyzeIssues(topCandidates, requiredQuantity, row);
    return result;
  }

  static _sortCandidatesByPrice(candidates) {
    return [...candidates].sort((a, b) => {
      const priceA = a.unit_price || 0;
      const priceB = b.unit_price || 0;
      if (priceA !== priceB) return priceA - priceB;
      return b.available_quantity - a.available_quantity;
    });
  }

  static _sortCandidatesByParamDistance(candidates, row) {
    const paramName = row.param_name;
    const hasMin = row.param_min !== null && row.param_min !== undefined;
    const hasMax = row.param_max !== null && row.param_max !== undefined;

    let targetValue;
    if (hasMin && hasMax) {
      targetValue = (row.param_min + row.param_max) / 2;
    } else if (hasMin) {
      targetValue = row.param_min * 1.01;
    } else if (hasMax) {
      targetValue = row.param_max * 0.99;
    } else {
      return candidates;
    }

    return [...candidates].sort((a, b) => {
      const aVal = a.params[paramName];
      const bVal = b.params[paramName];
      
      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;
      
      const aDist = Math.abs(aVal - targetValue);
      const bDist = Math.abs(bVal - targetValue);
      
      if (aDist !== bDist) return aDist - bDist;
      return b.available_quantity - a.available_quantity;
    });
  }

  static _trySingleBatch(candidates, requiredQuantity, minQuantity, maxQuantity, row, skipParamCheck = false) {
    for (const candidate of candidates) {
      if (candidate.available_quantity < minQuantity) continue;
      
      const paramValue = candidate.params[row.param_name];
      if (!skipParamCheck) {
        if (paramValue === undefined || paramValue === null) continue;
        if (!this._isParamInRange(paramValue, row)) continue;
      }

      const takeQuantity = Math.min(candidate.available_quantity, maxQuantity);
      if (takeQuantity < minQuantity) continue;

      return {
        batches: [{
          material_batch_id: candidate.id,
          batch_number: candidate.batch_number,
          material_type: candidate.material_type,
          quantity: takeQuantity,
          param_value: paramValue,
          unit_price: candidate.unit_price
        }],
        mixedParam: paramValue
      };
    }
    return null;
  }

  static _tryMultipleBatches(candidates, requiredQuantity, minQuantity, maxQuantity, row, startTime, skipParamCheck = false) {
    const availableCandidates = candidates.filter(c => {
      if (c.available_quantity <= 0) return false;
      if (skipParamCheck) return true;
      const paramValue = c.params[row.param_name];
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
          skipParamCheck
        );

        if (allocation) {
          return allocation;
        }
      }
    }

    return null;
  }

  static _allocateQuantities(batches, requiredQuantity, minQuantity, maxQuantity, row, skipParamCheck = false) {
    const paramName = row.param_name;
    
    const totalAvailable = batches.reduce((sum, b) => sum + b.available_quantity, 0);
    const targetTotal = Math.min(Math.max(requiredQuantity, minQuantity), Math.min(maxQuantity, totalAvailable));
    
    if (targetTotal < minQuantity) return null;

    const quantities = batches.map(b => Math.min(b.available_quantity, targetTotal));
    const totalQty = quantities.reduce((a, b) => a + b, 0);
    
    if (totalQty < targetTotal) return null;

    const ratios = quantities.map(q => q / totalQty);
    const finalQuantities = ratios.map(r => r * targetTotal);

    const weightedParam = skipParamCheck ? null : finalQuantities.reduce((sum, q, i) => {
      const paramVal = batches[i].params[paramName];
      return paramVal !== undefined && paramVal !== null ? sum + q * paramVal : sum;
    }, 0) / targetTotal;

    if (!skipParamCheck && !this._isParamInRange(weightedParam, row)) {
      return null;
    }

    return {
      batches: finalQuantities.map((q, i) => ({
        material_batch_id: batches[i].id,
        batch_number: batches[i].batch_number,
        material_type: batches[i].material_type,
        quantity: Math.round(q * 1000) / 1000,
        param_value: batches[i].params[paramName],
        unit_price: batches[i].unit_price
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

  static _analyzeIssues(candidates, requiredQuantity, row) {
    const issues = [];
    const paramName = row.param_name;

    const totalAvailable = candidates.reduce((sum, c) => sum + c.available_quantity, 0);
    
    if (totalAvailable < requiredQuantity * (1 - row.tolerance_percent / 100)) {
      issues.push({
        type: 'insufficient_quantity',
        required: requiredQuantity,
        available: totalAvailable,
        message: `总可用量不足，需要约${requiredQuantity.toFixed(2)}kg，仅有${totalAvailable.toFixed(2)}kg`
      });
    }

    candidates.forEach(c => {
      const paramValue = c.params[paramName];
      if (paramValue === undefined || paramValue === null) {
        issues.push({
          type: 'missing_param',
          batch_number: c.batch_number,
          message: `批次${c.batch_number}缺少参数${paramName}`
        });
      } else if (!this._isParamInRange(paramValue, row)) {
        issues.push({
          type: 'param_out_of_range',
          batch_number: c.batch_number,
          param_name: paramName,
          actual_value: paramValue,
          min: row.param_min,
          max: row.param_max,
          message: `批次${c.batch_number}的${paramName}=${paramValue}超出范围[${row.param_min}, ${row.param_max}]`
        });
      }
    });

    if (issues.length === 0) {
      issues.push({
        type: 'mix_failed',
        message: '无法找到合格的批次组合，混合后参数不能满足要求'
      });
    }

    return issues;
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
      } else if (hit.level === 'high') {
        warnings.push(entry);
      } else {
        warnings.push(entry);
      }
    }

    return { critical, warnings };
  }
}

module.exports = BatchCalculator;
