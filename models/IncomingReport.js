const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const MaterialBatch = require('./MaterialBatch');
const SupplierScore = require('./SupplierScore');
const StrictInspectionParam = require('./StrictInspectionParam');

class IncomingReport {
  static async createInspection(batchId, inspector, testData) {
    const batch = await MaterialBatch.findById(batchId);
    if (!batch) {
      throw new Error('原料批次不存在');
    }

    if (batch.status !== '待检') {
      throw new Error('该批次已检验，不支持复检');
    }

    const normalParams = await StrictInspectionParam.getNormalParams(batch.material_type);
    if (!normalParams || normalParams.length === 0) {
      throw new Error('该原料类型未配置检验参数');
    }

    const requiredParamNames = new Set(normalParams.map(p => p.param_name));

    const supplierStatus = batch.supplier ? await SupplierScore.getStatus(batch.supplier) : '正常';
    const needsStrict = supplierStatus === '观察' || supplierStatus === '黑名单';

    if (needsStrict) {
      const strictParams = await StrictInspectionParam.getStrictParams(batch.material_type);
      for (const p of strictParams) {
        requiredParamNames.add(p.param_name);
      }
    }

    for (const paramName of requiredParamNames) {
      if (testData[paramName] === undefined) {
        if (supplierStatus === '黑名单') {
          throw new Error(`供应商已被列入黑名单，须全项检验，缺少检验参数: ${paramName}`);
        } else if (supplierStatus === '观察') {
          throw new Error(`供应商处于观察状态，需要加严检验，缺少检验参数: ${paramName}`);
        }
        throw new Error(`缺少检验参数: ${paramName}`);
      }
    }

    const allParamSpecs = await StrictInspectionParam.getAllParamsWithSpecs(batch.material_type);
    const specMap = {};
    for (const spec of allParamSpecs) {
      specMap[spec.param_name] = spec;
    }

    await beginTransaction();
    try {
      const reportNumber = 'IC-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();

      const items = [];
      let overallResult = 'qualified';
      const checkedParams = new Set();

      for (const paramName of requiredParamNames) {
        if (checkedParams.has(paramName)) continue;
        checkedParams.add(paramName);

        const spec = specMap[paramName];
        if (!spec) continue;

        const measuredValue = testData[paramName];
        const specMin = spec.spec_min !== null && spec.spec_min !== undefined ? spec.spec_min : null;
        const specMax = spec.spec_max !== null && spec.spec_max !== undefined ? spec.spec_max : null;

        const { result, deviationPercent, deviationDirection } = this._judgeItem(
          measuredValue,
          specMin,
          specMax
        );

        if (result === 'unqualified') {
          overallResult = 'unqualified';
        }

        items.push({
          param_name: paramName,
          measured_value: measuredValue,
          spec_min: specMin,
          spec_max: specMax,
          result,
          deviation_percent: deviationPercent,
          deviation_direction: deviationDirection
        });
      }

      const result = await run(`
        INSERT INTO incoming_reports
        (report_number, material_batch_id, batch_number, material_type, supplier, inspector, overall_result)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        reportNumber,
        batch.id,
        batch.batch_number,
        batch.material_type,
        batch.supplier,
        inspector,
        overallResult
      ]);

      const reportId = result.lastID;

      for (const item of items) {
        await run(`
          INSERT INTO incoming_report_items
          (incoming_report_id, param_name, measured_value, spec_min, spec_max, result, deviation_percent, deviation_direction)
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

      const newStatus = overallResult === 'qualified' ? '合格' : '拒收';
      await run(`
        UPDATE material_batches SET status = ? WHERE id = ?
      `, [newStatus, batch.id]);

      if (batch.supplier) {
        await SupplierScore.updateAfterInspection(batch.supplier, overallResult === 'qualified');
      }

      await commit();

      return await this.findById(reportId);
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static _judgeItem(measuredValue, specMin, specMax) {
    let isQualified = true;
    if (specMin !== null && specMin !== undefined && measuredValue < specMin) {
      isQualified = false;
    }
    if (specMax !== null && specMax !== undefined && measuredValue > specMax) {
      isQualified = false;
    }

    let deviationPercent = 0;
    let deviationDirection = 'within';

    if (!isQualified) {
      if (specMin !== null && specMin !== undefined && measuredValue < specMin) {
        deviationDirection = 'low';
        deviationPercent = ((specMin - measuredValue) / (specMin === 0 ? 1 : Math.abs(specMin))) * 100;
      } else if (specMax !== null && specMax !== undefined && measuredValue > specMax) {
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
    const report = await get('SELECT * FROM incoming_reports WHERE id = ?', [id]);
    if (!report) return null;

    report.items = await all(`
      SELECT * FROM incoming_report_items WHERE incoming_report_id = ? ORDER BY id
    `, [id]);

    return report;
  }

  static async findByBatchId(batchId) {
    const reports = await all(`
      SELECT * FROM incoming_reports WHERE material_batch_id = ? ORDER BY inspection_time DESC
    `, [batchId]);

    for (const report of reports) {
      report.items = await all(`
        SELECT * FROM incoming_report_items WHERE incoming_report_id = ? ORDER BY id
      `, [report.id]);
    }

    return reports;
  }

  static async findAll() {
    const reports = await all('SELECT * FROM incoming_reports ORDER BY inspection_time DESC');

    for (const report of reports) {
      report.items = await all(`
        SELECT * FROM incoming_report_items WHERE incoming_report_id = ? ORDER BY id
      `, [report.id]);
    }

    return reports;
  }

  static async getStats() {
    const totalReports = await get('SELECT COUNT(*) as count FROM incoming_reports');
    const qualifiedReports = await get("SELECT COUNT(*) as count FROM incoming_reports WHERE overall_result = 'qualified'");

    const supplierRejectionRates = await all(`
      SELECT supplier,
             COUNT(*) as total,
             SUM(CASE WHEN overall_result = 'unqualified' THEN 1 ELSE 0 END) as rejected
      FROM incoming_reports
      WHERE supplier IS NOT NULL
      GROUP BY supplier
    `);

    const passRate = totalReports.count > 0
      ? Math.round((qualifiedReports.count / totalReports.count) * 10000) / 100
      : 0;

    const supplierStats = {};
    for (const row of supplierRejectionRates) {
      supplierStats[row.supplier] = {
        total: row.total,
        rejected: row.rejected,
        rejection_rate: Math.round((row.rejected / row.total) * 10000) / 100
      };
    }

    return {
      total_inspections: totalReports.count,
      qualified_count: qualifiedReports.count,
      unqualified_count: totalReports.count - qualifiedReports.count,
      pass_rate: passRate,
      supplier_rejection_rates: supplierStats
    };
  }
}

module.exports = IncomingReport;
