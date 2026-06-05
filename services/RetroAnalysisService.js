const Formula = require('../models/Formula');
const ProductBatch = require('../models/ProductBatch');
const MaterialBatch = require('../models/MaterialBatch');
const ExecutionSnapshot = require('../models/ExecutionSnapshot');
const RetroAnalysisResult = require('../models/RetroAnalysisResult');
const QCReport = require('../models/QCReport');
const BatchCalculator = require('./BatchCalculator');

class RetroAnalysisService {
  static async analyze(productBatchId, qcReportId = null) {
    const productBatch = await ProductBatch.findById(productBatchId);
    if (!productBatch) {
      throw new Error('成品批次不存在');
    }

    const snapshot = await ExecutionSnapshot.findByProductBatchId(productBatchId);
    if (!snapshot) {
      throw new Error('该成品批次没有执行前库存快照，无法进行回溯分析');
    }

    const formula = await Formula.findById(productBatch.formula_id);
    if (!formula) {
      throw new Error('关联配方不存在');
    }

    const actualMaterials = await ProductBatch.getMaterials(productBatchId);
    const actualPlan = this._buildActualPlan(actualMaterials, formula);

    const optimalResult = await BatchCalculator.calculatePlan(
      formula,
      productBatch.total_yield,
      {
        customInventory: snapshot.snapshot_data,
        ignoreReservations: true
      }
    );

    let optimalPlan = null;
    let optimalEstimatedParams = null;
    let wouldPass = false;
    let conclusion = 'no_better_option';

    if (optimalResult.success) {
      optimalPlan = optimalResult.rows;
      optimalEstimatedParams = optimalResult.estimated_product_params;
      wouldPass = this._checkParamsPass(optimalEstimatedParams, formula.specs);

      const actualIsOptimal = this._isPlanEqual(actualPlan, optimalPlan);
      if (actualIsOptimal) {
        conclusion = 'actual_was_optimal';
      } else if (wouldPass) {
        conclusion = 'had_better_option';
      } else {
        conclusion = 'no_better_option';
      }
    } else {
      conclusion = 'no_better_option';
    }

    const analysisData = {
      actual_plan: actualPlan,
      optimal_plan: optimalPlan,
      optimal_estimated_params: optimalEstimatedParams,
      would_pass: wouldPass,
      conclusion: conclusion,
      calculation_errors: optimalResult.success ? [] : optimalResult.errors,
      total_cost_optimal: optimalResult.success ? optimalResult.total_cost : null,
      total_cost_actual: this._calculateActualCost(actualMaterials)
    };

    const resolvedQcReportId = qcReportId || await this._findLatestQcReportId(productBatchId);
    if (resolvedQcReportId) {
      await RetroAnalysisResult.create(
        productBatchId,
        resolvedQcReportId,
        wouldPass,
        conclusion,
        analysisData
      );
    }

    return analysisData;
  }

  static _buildActualPlan(actualMaterials, formula) {
    const planRows = [];
    const grouped = {};

    for (const mat of actualMaterials) {
      const rowIndex = mat.formula_row_id;
      if (!grouped[rowIndex]) {
        grouped[rowIndex] = {
          row_index: rowIndex,
          material_type: mat.material_type,
          batches: [],
          is_substitute: mat.is_substitute === 1
        };
      }
      grouped[rowIndex].batches.push({
        material_batch_id: mat.material_batch_id,
        batch_number: mat.batch_number,
        material_type: mat.material_type,
        quantity: mat.quantity_used,
        is_substitute: mat.is_substitute === 1
      });
    }

    for (const rowIndex of Object.keys(grouped).sort((a, b) => a - b)) {
      planRows.push(grouped[rowIndex]);
    }

    return planRows;
  }

  static _isPlanEqual(actualPlan, optimalPlan) {
    if (!actualPlan || !optimalPlan) return false;
    if (actualPlan.length !== optimalPlan.length) return false;

    for (let i = 0; i < actualPlan.length; i++) {
      const actualRow = actualPlan[i];
      const optimalRow = optimalPlan[i];

      if (!optimalRow) return false;
      if (actualRow.material_type !== optimalRow.material_type) return false;
      if (actualRow.batches.length !== optimalRow.batches.length) return false;

      const actualBatchIds = actualRow.batches.map(b => b.material_batch_id).sort();
      const optimalBatchIds = optimalRow.batches.map(b => b.material_batch_id).sort();

      if (JSON.stringify(actualBatchIds) !== JSON.stringify(optimalBatchIds)) {
        return false;
      }
    }

    return true;
  }

  static _checkParamsPass(estimatedParams, specs) {
    if (!estimatedParams || !specs) return false;

    for (const spec of specs) {
      const value = estimatedParams[spec.param_name];
      if (value === undefined || value === null) return false;
      if (value < spec.param_min || value > spec.param_max) return false;
    }

    return true;
  }

  static _calculateActualCost(actualMaterials) {
    let total = 0;
    for (const mat of actualMaterials) {
      total += mat.quantity_used * (mat.unit_price || 0);
    }
    return Math.round(total * 100) / 100;
  }

  static async _findLatestQcReportId(productBatchId) {
    const reports = await QCReport.findByProductBatch(productBatchId);
    if (reports && reports.length > 0) {
      return reports[0].id;
    }
    return null;
  }

  static async getAnalysis(productBatchId) {
    const cached = await RetroAnalysisResult.findByProductBatchId(productBatchId);
    if (cached) {
      return cached.analysis_data;
    }
    return await this.analyze(productBatchId);
  }

  static async getStats() {
    return await RetroAnalysisResult.getStats();
  }
}

module.exports = RetroAnalysisService;
