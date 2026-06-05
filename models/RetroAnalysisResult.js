const { run, get, all } = require('../config/database');

class RetroAnalysisResult {
  static async create(productBatchId, qcReportId, wouldPass, conclusion, analysisData) {
    const existing = await this.findByProductBatchId(productBatchId);
    if (existing) {
      await run(`
        UPDATE retro_analysis_results 
        SET qc_report_id = ?, would_pass = ?, conclusion = ?, analysis_data = ?, created_at = CURRENT_TIMESTAMP
        WHERE product_batch_id = ?
      `, [qcReportId, wouldPass ? 1 : 0, conclusion, JSON.stringify(analysisData), productBatchId]);
      return existing.id;
    }

    const result = await run(`
      INSERT INTO retro_analysis_results 
      (product_batch_id, qc_report_id, would_pass, conclusion, analysis_data)
      VALUES (?, ?, ?, ?, ?)
    `, [productBatchId, qcReportId, wouldPass ? 1 : 0, conclusion, JSON.stringify(analysisData)]);
    return result.lastID;
  }

  static async findByProductBatchId(productBatchId) {
    const row = await get(`
      SELECT * FROM retro_analysis_results 
      WHERE product_batch_id = ? 
      ORDER BY created_at DESC 
      LIMIT 1
    `, [productBatchId]);

    if (!row) return null;
    row.analysis_data = JSON.parse(row.analysis_data);
    row.would_pass = row.would_pass === 1;
    return row;
  }

  static async findById(id) {
    const row = await get('SELECT * FROM retro_analysis_results WHERE id = ?', [id]);
    if (!row) return null;
    row.analysis_data = JSON.parse(row.analysis_data);
    row.would_pass = row.would_pass === 1;
    return row;
  }

  static async getStats() {
    const totalAnalyzed = await get('SELECT COUNT(*) as count FROM retro_analysis_results');
    const hadBetterOption = await get("SELECT COUNT(*) as count FROM retro_analysis_results WHERE conclusion = 'had_better_option'");
    const noBetterOption = await get("SELECT COUNT(*) as count FROM retro_analysis_results WHERE conclusion = 'no_better_option'");
    const actualWasOptimal = await get("SELECT COUNT(*) as count FROM retro_analysis_results WHERE conclusion = 'actual_was_optimal'");

    const total = totalAnalyzed.count || 0;
    const betterCount = hadBetterOption.count || 0;
    const noBetterCount = noBetterOption.count || 0;
    const optimalCount = actualWasOptimal.count || 0;

    return {
      total_analyzed: total,
      had_better_option_count: betterCount,
      no_better_option_count: noBetterCount,
      actual_was_optimal_count: optimalCount,
      had_better_option_percent: total > 0 ? Math.round((betterCount / total) * 10000) / 100 : 0,
      no_better_option_percent: total > 0 ? Math.round((noBetterCount / total) * 10000) / 100 : 0,
      actual_was_optimal_percent: total > 0 ? Math.round((optimalCount / total) * 10000) / 100 : 0
    };
  }
}

module.exports = RetroAnalysisResult;
