const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const Formula = require('./Formula');
const ProductBatch = require('./ProductBatch');
const DispositionOrder = require('./DispositionOrder');
const MaterialLock = require('./MaterialLock');
const { EnvReading } = require('./EnvMonitor');

class QCReport {
  static async createInspection(productBatchIdOrNumber, inspector, testData) {
    const productBatch = await ProductBatch.findByBatchNumber(productBatchIdOrNumber) ||
                         await ProductBatch.findById(productBatchIdOrNumber);
    
    if (!productBatch) {
      throw new Error('成品批次不存在');
    }

    const formula = await Formula.findById(productBatch.formula_id);
    if (!formula) {
      throw new Error('关联配方不存在');
    }

    if (!formula.specs || formula.specs.length === 0) {
      throw new Error('配方未定义验收指标');
    }

    const testDataKeys = Object.keys(testData);
    for (const spec of formula.specs) {
      if (testData[spec.param_name] === undefined) {
        throw new Error(`缺少检验参数: ${spec.param_name}`);
      }
    }

    await beginTransaction();
    try {
      const reportNumber = 'QC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
      
      const items = [];
      let overallResult = 'qualified';
      const unqualifiedItems = [];

      for (const spec of formula.specs) {
        const measuredValue = testData[spec.param_name];
        const { result, deviationPercent, deviationDirection } = this._judgeItem(
          measuredValue,
          spec.param_min,
          spec.param_max
        );

        if (result === 'unqualified') {
          overallResult = 'unqualified';
          unqualifiedItems.push({
            param_name: spec.param_name,
            measured_value: measuredValue,
            spec_min: spec.param_min,
            spec_max: spec.param_max,
            deviation_percent: deviationPercent,
            deviation_direction: deviationDirection
          });
        }

        items.push({
          param_name: spec.param_name,
          measured_value: measuredValue,
          spec_min: spec.param_min,
          spec_max: spec.param_max,
          result,
          deviation_percent: deviationPercent,
          deviation_direction: deviationDirection
        });
      }

      const result = await run(`
        INSERT INTO qc_reports 
        (report_number, product_batch_id, product_batch_number, inspector, overall_result)
        VALUES (?, ?, ?, ?, ?)
      `, [
        reportNumber,
        productBatch.id,
        productBatch.batch_number,
        inspector,
        overallResult
      ]);

      const reportId = result.lastID;

      for (const item of items) {
        await run(`
          INSERT INTO qc_report_items 
          (qc_report_id, param_name, measured_value, spec_min, spec_max, result, deviation_percent, deviation_direction)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          reportId,
          item.param_name,
          item.measured_value,
          item.spec_min,
          item.spec_max,
          item.result,
          item.deviation_percent,
          item.deviation_direction
        ]);
      }

      let dispositionOrder = null;
      if (overallResult === 'unqualified') {
        dispositionOrder = await DispositionOrder.createFromQCReport(
          reportId,
          productBatch.id,
          productBatch.batch_number,
          unqualifiedItems
        );
      }

      await commit();

      if (overallResult === 'unqualified' && dispositionOrder) {
        await MaterialLock.lockRelatedMaterials(
          productBatch.id,
          productBatch.batch_number,
          dispositionOrder.id,
          inspector
        );
      } else if (overallResult === 'qualified') {
        await this._cleanupAfterPassedReinspection(productBatch.id, inspector);
      }

      return await this.findById(reportId);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async _cleanupAfterPassedReinspection(productBatchId, inspector) {
    const pendingOrders = await all(`
      SELECT id FROM disposition_orders 
      WHERE product_batch_id = ? AND status IN ('pending', 'rejected')
    `, [productBatchId]);

    for (const order of pendingOrders) {
      await run(`
        UPDATE disposition_orders 
        SET status = 'cancelled', reject_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, ['复检合格，自动取消', inspector, order.id]);

      await run(`
        UPDATE material_locks 
        SET is_locked = 0, unlock_reason = ?, unlocked_by = ?, unlocked_at = CURRENT_TIMESTAMP
        WHERE source_disposition_order_id = ? AND is_locked = 1
      `, ['复检合格，自动解锁', inspector, order.id]);
    }
  }

  static _judgeItem(measuredValue, specMin, specMax) {
    const isQualified = measuredValue >= specMin && measuredValue <= specMax;
    let deviationPercent = 0;
    let deviationDirection = 'within';

    if (!isQualified) {
      if (measuredValue < specMin) {
        deviationDirection = 'low';
        deviationPercent = ((specMin - measuredValue) / (specMin === 0 ? 1 : Math.abs(specMin))) * 100;
      } else if (measuredValue > specMax) {
        deviationDirection = 'high';
        deviationPercent = ((measuredValue - specMax) / (specMax === 0 ? 1 : Math.abs(specMax))) * 100;
      }
    }

    return {
      result: isQualified ? 'qualified' : 'unqualified',
      deviationPercent: Math.round(deviationPercent * 100) / 100,
      deviationDirection
    };
  }

  static async findById(id) {
    const report = await get('SELECT * FROM qc_reports WHERE id = ?', [id]);
    if (!report) return null;

    report.items = await all(`
      SELECT * FROM qc_report_items WHERE qc_report_id = ? ORDER BY id
    `, [id]);

    if (report.overall_result === 'unqualified') {
      report.env_deviations = await EnvReading.getDeviationsForBatch(report.product_batch_number);
    } else {
      report.env_deviations = [];
    }

    return report;
  }

  static async findByReportNumber(reportNumber) {
    const report = await get('SELECT * FROM qc_reports WHERE report_number = ?', [reportNumber]);
    if (!report) return null;

    report.items = await all(`
      SELECT * FROM qc_report_items WHERE qc_report_id = ? ORDER BY id
    `, [report.id]);

    if (report.overall_result === 'unqualified') {
      report.env_deviations = await EnvReading.getDeviationsForBatch(report.product_batch_number);
    } else {
      report.env_deviations = [];
    }

    return report;
  }

  static async findByProductBatch(productBatchIdOrNumber) {
    const productBatch = await ProductBatch.findByBatchNumber(productBatchIdOrNumber) ||
                         await ProductBatch.findById(productBatchIdOrNumber);
    
    if (!productBatch) return [];

    const reports = await all(`
      SELECT * FROM qc_reports 
      WHERE product_batch_id = ? 
      ORDER BY inspection_time DESC
    `, [productBatch.id]);

    for (const report of reports) {
      report.items = await all(`
        SELECT * FROM qc_report_items WHERE qc_report_id = ? ORDER BY id
      `, [report.id]);

      if (report.overall_result === 'unqualified') {
        report.env_deviations = await EnvReading.getDeviationsForBatch(report.product_batch_number);
      } else {
        report.env_deviations = [];
      }
    }

    return reports;
  }

  static async findAll() {
    const reports = await all('SELECT * FROM qc_reports ORDER BY inspection_time DESC');
    
    for (const report of reports) {
      report.items = await all(`
        SELECT * FROM qc_report_items WHERE qc_report_id = ? ORDER BY id
      `, [report.id]);

      if (report.overall_result === 'unqualified') {
        report.env_deviations = await EnvReading.getDeviationsForBatch(report.product_batch_number);
      } else {
        report.env_deviations = [];
      }
    }

    return reports;
  }

  static async getLatestResult(productBatchIdOrNumber) {
    const reports = await this.findByProductBatch(productBatchIdOrNumber);
    return reports.length > 0 ? reports[0] : null;
  }

  static async getStats() {
    const totalReports = await get('SELECT COUNT(*) as count FROM qc_reports');
    const qualifiedReports = await get("SELECT COUNT(*) as count FROM qc_reports WHERE overall_result = 'qualified'");
    
    const dispositionStats = await all(`
      SELECT disposition_level, COUNT(*) as count 
      FROM disposition_orders 
      GROUP BY disposition_level
    `);

    const recentLocks = await get(`
      SELECT COUNT(*) as count 
      FROM material_locks 
      WHERE is_locked = 1 
      AND locked_at >= datetime('now', '-7 days')
    `);

    const passRate = totalReports.count > 0 
      ? Math.round((qualifiedReports.count / totalReports.count) * 10000) / 100 
      : 0;

    const dispositionDistribution = {
      concession: 0,
      rework: 0,
      downgrade: 0,
      scrap: 0
    };

    for (const stat of dispositionStats) {
      dispositionDistribution[stat.disposition_level] = stat.count;
    }

    return {
      total_inspections: totalReports.count,
      qualified_count: qualifiedReports.count,
      unqualified_count: totalReports.count - qualifiedReports.count,
      pass_rate: passRate,
      disposition_distribution: dispositionDistribution,
      recently_locked_material_batches: recentLocks.count
    };
  }
}

module.exports = QCReport;
