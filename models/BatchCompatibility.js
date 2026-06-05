const { run, get, all } = require('../config/database');

class BatchCompatibility {
  static async create(data) {
    const { batch_a_id, batch_b_id, score, source, notes } = data;
    
    if (batch_a_id === batch_b_id) {
      throw new Error('批次不能与自身比较');
    }

    const smallerId = Math.min(batch_a_id, batch_b_id);
    const largerId = Math.max(batch_a_id, batch_b_id);

    const existing = await this.getLatestPairScore(smallerId, largerId);
    
    if (existing) {
      await run(`
        UPDATE batch_compatibility 
        SET score = ?, source = ?, notes = ?, created_at = CURRENT_TIMESTAMP
        WHERE batch_a_id = ? AND batch_b_id = ?
      `, [score, source, notes || null, smallerId, largerId]);
      
      return await this.getByPair(smallerId, largerId);
    } else {
      const result = await run(`
        INSERT INTO batch_compatibility (batch_a_id, batch_b_id, score, source, notes)
        VALUES (?, ?, ?, ?, ?)
      `, [smallerId, largerId, score, source, notes || null]);
      
      return await this.findById(result.lastID);
    }
  }

  static async findById(id) {
    const record = await get(`
      SELECT bc.*,
             ma.material_type as type_a,
             ma.batch_number as batch_a_number,
             mb.material_type as type_b,
             mb.batch_number as batch_b_number
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      WHERE bc.id = ?
    `, [id]);
    
    return record || null;
  }

  static async getByPair(batchAId, batchBId) {
    const smallerId = Math.min(batchAId, batchBId);
    const largerId = Math.max(batchAId, batchBId);
    
    return await get(`
      SELECT bc.*,
             ma.material_type as type_a,
             ma.batch_number as batch_a_number,
             mb.material_type as type_b,
             mb.batch_number as batch_b_number
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      WHERE bc.batch_a_id = ? AND bc.batch_b_id = ?
    `, [smallerId, largerId]);
  }

  static async getLatestPairScore(batchAId, batchBId) {
    const smallerId = Math.min(batchAId, batchBId);
    const largerId = Math.max(batchAId, batchBId);
    
    return await get(`
      SELECT score, source, notes, created_at
      FROM batch_compatibility 
      WHERE batch_a_id = ? AND batch_b_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [smallerId, largerId]);
  }

  static async findByBatchId(batchId) {
    return await all(`
      SELECT bc.*,
             ma.material_type as type_a,
             ma.batch_number as batch_a_number,
             mb.material_type as type_b,
             mb.batch_number as batch_b_number,
             CASE 
               WHEN bc.batch_a_id = ? THEN bc.batch_b_id
               ELSE bc.batch_a_id
             END as other_batch_id,
             CASE 
               WHEN bc.batch_a_id = ? THEN mb.batch_number
               ELSE ma.batch_number
             END as other_batch_number,
             CASE 
               WHEN bc.batch_a_id = ? THEN mb.material_type
               ELSE ma.material_type
             END as other_material_type
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      WHERE bc.batch_a_id = ? OR bc.batch_b_id = ?
      ORDER BY bc.created_at DESC
    `, [batchId, batchId, batchId, batchId, batchId]);
  }

  static async findAll() {
    return await all(`
      SELECT bc.*,
             ma.material_type as type_a,
             ma.batch_number as batch_a_number,
             mb.material_type as type_b,
             mb.batch_number as batch_b_number
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      ORDER BY bc.created_at DESC
    `);
  }

  static async getTypeAverageScore(materialType) {
    const result = await get(`
      SELECT AVG(bc.score) as average_score,
             COUNT(*) as record_count
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      WHERE ma.material_type = ? AND mb.material_type = ?
    `, [materialType, materialType]);
    
    return {
      average_score: result ? result.average_score : null,
      record_count: result ? result.record_count : 0
    };
  }

  static async getCompatibilityMatrixByType(materialType) {
    const batches = await all(`
      SELECT id, batch_number, material_type
      FROM material_batches 
      WHERE material_type = ?
      ORDER BY batch_number
    `, [materialType]);
    
    const batchIds = batches.map(b => b.id);
    const matrix = {};
    
    for (const batch of batches) {
      matrix[batch.id] = {
        batch_id: batch.id,
        batch_number: batch.batch_number,
        material_type: batch.material_type,
        compatibilities: {}
      };
    }
    
    for (let i = 0; i < batchIds.length; i++) {
      for (let j = i + 1; j < batchIds.length; j++) {
        const idA = batchIds[i];
        const idB = batchIds[j];
        
        const compat = await this.getLatestPairScore(idA, idB);
        const isActual = compat && compat.score !== null;
        const score = isActual ? compat.score : null;
        
        matrix[idA].compatibilities[idB] = {
          score: score,
          type: isActual ? 'actual' : null,
          source: isActual ? compat.source : null
        };
        
        matrix[idB].compatibilities[idA] = {
          score: score,
          type: isActual ? 'actual' : null,
          source: isActual ? compat.source : null
        };
      }
    }
    
    return {
      batches: batches,
      matrix: matrix
    };
  }

  static async getAllRecordsByType(materialType) {
    return await all(`
      SELECT bc.*,
             ma.material_type as type_a,
             ma.batch_number as batch_a_number,
             mb.material_type as type_b,
             mb.batch_number as batch_b_number
      FROM batch_compatibility bc
      INNER JOIN material_batches ma ON bc.batch_a_id = ma.id
      INNER JOIN material_batches mb ON bc.batch_b_id = mb.id
      WHERE ma.material_type = ? AND mb.material_type = ?
      ORDER BY bc.created_at DESC
    `, [materialType, materialType]);
  }

  static async delete(id) {
    return await run('DELETE FROM batch_compatibility WHERE id = ?', [id]);
  }
}

module.exports = BatchCompatibility;
