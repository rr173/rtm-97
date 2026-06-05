const BatchCompatibility = require('../models/BatchCompatibility');
const MaterialBatch = require('../models/MaterialBatch');

const DEFAULT_COMPATIBILITY_SCORE = 70;

class CompatibilityService {
  static _typeAverageCache = {};
  static _cacheTimestamp = 0;
  static _cacheTTL = 5 * 60 * 1000;

  static async getBatchInfo(batchIds) {
    const uniqueIds = [...new Set(batchIds)];
    const batches = [];
    
    for (const id of uniqueIds) {
      const batch = await MaterialBatch.findById(id);
      if (batch) {
        batches.push(batch);
      }
    }
    
    return batches;
  }

  static async getInferredScoreForType(materialType) {
    const now = Date.now();
    if (now - this._cacheTimestamp < this._cacheTTL && 
        this._typeAverageCache[materialType] !== undefined) {
      return this._typeAverageCache[materialType];
    }

    const result = await BatchCompatibility.getTypeAverageScore(materialType);
    
    let inferredScore;
    if (result.record_count > 0 && result.average_score !== null) {
      inferredScore = Math.round(result.average_score * 10) / 10;
    } else {
      inferredScore = DEFAULT_COMPATIBILITY_SCORE;
    }

    this._typeAverageCache[materialType] = {
      score: inferredScore,
      record_count: result.record_count,
      is_default: result.record_count === 0
    };
    this._cacheTimestamp = now;

    return this._typeAverageCache[materialType];
  }

  static invalidateCache() {
    this._typeAverageCache = {};
    this._cacheTimestamp = 0;
  }

  static async getPairCompatibility(batchAId, batchBId) {
    if (batchAId === batchBId) {
      return {
        batch_a_id: batchAId,
        batch_b_id: batchBId,
        score: 100,
        type: 'actual',
        source: 'self',
        notes: '同一批次完全兼容'
      };
    }

    const directRecord = await BatchCompatibility.getLatestPairScore(batchAId, batchBId);
    
    if (directRecord && directRecord.score !== null && directRecord.score !== undefined) {
      return {
        batch_a_id: Math.min(batchAId, batchBId),
        batch_b_id: Math.max(batchAId, batchBId),
        score: directRecord.score,
        type: 'actual',
        source: directRecord.source,
        notes: directRecord.notes
      };
    }

    const batchA = await MaterialBatch.findById(batchAId);
    const batchB = await MaterialBatch.findById(batchBId);

    if (!batchA || !batchB) {
      return {
        batch_a_id: batchAId,
        batch_b_id: batchBId,
        score: DEFAULT_COMPATIBILITY_SCORE,
        type: 'inferred',
        source: 'default',
        notes: '批次不存在，使用默认兼容性评分'
      };
    }

    if (batchA.material_type !== batchB.material_type) {
      return {
        batch_a_id: batchAId,
        batch_b_id: batchBId,
        score: DEFAULT_COMPATIBILITY_SCORE,
        type: 'inferred',
        source: 'cross_type_default',
        notes: '不同原料类型，使用默认兼容性评分'
      };
    }

    const inferredResult = await this.getInferredScoreForType(batchA.material_type);
    
    return {
      batch_a_id: Math.min(batchAId, batchBId),
      batch_b_id: Math.max(batchAId, batchBId),
      score: inferredResult.score,
      type: 'inferred',
      source: inferredResult.is_default ? 'type_default' : 'type_average',
      notes: inferredResult.is_default 
        ? `无${batchA.material_type}类型历史数据，使用默认值`
        : `基于${inferredResult.record_count}条${batchA.material_type}类型历史记录推断`
    };
  }

  static async getCompatibilityMatrixWithInference(materialType) {
    const batches = await MaterialBatch.findByType(materialType, true, true);
    const batchIds = batches.map(b => b.id);
    
    const matrix = [];
    const inferredResult = await this.getInferredScoreForType(materialType);
    
    for (let i = 0; i < batchIds.length; i++) {
      for (let j = i + 1; j < batchIds.length; j++) {
        const compat = await this.getPairCompatibility(batchIds[i], batchIds[j]);
        matrix.push(compat);
      }
    }

    return {
      material_type: materialType,
      batches: batches.map(b => ({
        id: b.id,
        batch_number: b.batch_number,
        material_type: b.material_type
      })),
      type_default_score: inferredResult.score,
      type_record_count: inferredResult.record_count,
      compatibility_pairs: matrix
    };
  }

  static async predictMixCompatibility(batchIds) {
    if (!batchIds || !Array.isArray(batchIds) || batchIds.length < 2) {
      return {
        success: false,
        error: '需要提供至少2个批次ID',
        batch_ids: batchIds
      };
    }

    const uniqueBatchIds = [...new Set(batchIds)];
    
    if (uniqueBatchIds.length < 2) {
      return {
        success: false,
        error: '需要提供至少2个不同的批次ID',
        batch_ids: batchIds
      };
    }

    const batchInfo = await this.getBatchInfo(uniqueBatchIds);
    const validBatchIds = batchInfo.map(b => b.id);
    
    if (validBatchIds.length < 2) {
      return {
        success: false,
        error: '有效批次数量不足2个',
        batch_ids: batchIds,
        valid_batches: validBatchIds
      };
    }

    const pairs = [];
    for (let i = 0; i < validBatchIds.length; i++) {
      for (let j = i + 1; j < validBatchIds.length; j++) {
        pairs.push([validBatchIds[i], validBatchIds[j]]);
      }
    }

    const compatibilityResults = [];
    for (const [idA, idB] of pairs) {
      const result = await this.getPairCompatibility(idA, idB);
      compatibilityResults.push(result);
    }

    const scores = compatibilityResults.map(r => r.score);
    const minimumScore = Math.min(...scores);
    const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    
    const riskPairs = compatibilityResults
      .filter(r => r.score < 60)
      .map(r => ({
        batch_a_id: r.batch_a_id,
        batch_b_id: r.batch_b_id,
        score: r.score,
        type: r.type,
        source: r.source
      }));

    let verdict;
    let verdictText;
    if (minimumScore >= 60) {
      verdict = 'compatible';
      verdictText = '建议混合';
    } else if (minimumScore >= 40) {
      verdict = 'risky';
      verdictText = '存在风险，谨慎混合';
    } else {
      verdict = 'incompatible';
      verdictText = '风险过高，建议避免';
    }

    const batchInfoMap = {};
    for (const batch of batchInfo) {
      batchInfoMap[batch.id] = {
        id: batch.id,
        batch_number: batch.batch_number,
        material_type: batch.material_type,
        supplier: batch.supplier
      };
    }

    return {
      success: true,
      batch_ids: validBatchIds,
      batch_info: batchInfoMap,
      minimum_score: Math.round(minimumScore * 10) / 10,
      average_score: Math.round(averageScore * 10) / 10,
      risk_pairs: riskPairs,
      verdict: verdict,
      verdict_text: verdictText,
      compatibility_details: compatibilityResults
    };
  }

  static async checkRowCompatibility(rows) {
    const rowWarnings = [];

    for (const row of rows) {
      if (!row.batches || row.batches.length < 2) {
        continue;
      }

      const batchIds = row.batches.map(b => b.material_batch_id);
      const uniqueBatchIds = [...new Set(batchIds)];
      
      if (uniqueBatchIds.length < 2) {
        continue;
      }

      const result = await this.predictMixCompatibility(uniqueBatchIds);
      
      if (result.success && result.minimum_score < 40) {
        rowWarnings.push({
          row_index: row.row_index,
          material_type: row.material_type,
          minimum_score: result.minimum_score,
          verdict: result.verdict,
          risk_pairs: result.risk_pairs,
          message: `第${row.row_index + 1}行(${row.material_type})混用批次兼容性评分${result.minimum_score}，存在严重风险`
        });
      }
    }

    return rowWarnings;
  }
}

module.exports = CompatibilityService;
