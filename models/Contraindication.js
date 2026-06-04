const { run, get, all } = require('../config/database');

const LEVEL_ORDER = { low: 1, medium: 2, high: 3, critical: 4 };

class Contraindication {
  static async create(type_a, type_b, level, description, discovered_date) {
    const sorted = this._sortPair(type_a, type_b);
    return await run(`
      INSERT INTO contraindications (type_a, type_b, level, description, discovered_date)
      VALUES (?, ?, ?, ?, ?)
    `, [sorted.type_a, sorted.type_b, level, description, discovered_date]);
  }

  static async findById(id) {
    return await get('SELECT * FROM contraindications WHERE id = ?', [id]);
  }

  static async findAll(level = null) {
    if (level) {
      return await all('SELECT * FROM contraindications WHERE level = ? ORDER BY id', [level]);
    }
    return await all('SELECT * FROM contraindications ORDER BY id');
  }

  static async delete(id) {
    return await run('DELETE FROM contraindications WHERE id = ?', [id]);
  }

  static async findByPair(type_a, type_b) {
    const sorted = this._sortPair(type_a, type_b);
    return await get(
      'SELECT * FROM contraindications WHERE type_a = ? AND type_b = ?',
      [sorted.type_a, sorted.type_b]
    );
  }

  static async findContraindicationsForTypes(materialTypes) {
    if (materialTypes.length < 2) return [];

    const pairs = [];
    for (let i = 0; i < materialTypes.length; i++) {
      for (let j = i + 1; j < materialTypes.length; j++) {
        pairs.push(this._sortPair(materialTypes[i], materialTypes[j]));
      }
    }

    const results = [];
    for (const pair of pairs) {
      const record = await get(
        'SELECT * FROM contraindications WHERE type_a = ? AND type_b = ?',
        [pair.type_a, pair.type_b]
      );
      if (record) {
        results.push(record);
      }
    }
    return results;
  }

  static async simulate(materialTypes) {
    const totalPairs = [];
    for (let i = 0; i < materialTypes.length; i++) {
      for (let j = i + 1; j < materialTypes.length; j++) {
        totalPairs.push([materialTypes[i], materialTypes[j]]);
      }
    }

    const contraindicatedPairs = [];
    const safePairs = [];

    for (const [a, b] of totalPairs) {
      const sorted = this._sortPair(a, b);
      const record = await get(
        'SELECT * FROM contraindications WHERE type_a = ? AND type_b = ?',
        [sorted.type_a, sorted.type_b]
      );
      if (record) {
        contraindicatedPairs.push({
          type_a: a,
          type_b: b,
          level: record.level,
          description: record.description
        });
      } else {
        safePairs.push({ type_a: a, type_b: b });
      }
    }

    let overallRisk = 'safe';
    if (contraindicatedPairs.length > 0) {
      overallRisk = contraindicatedPairs.reduce((max, p) => {
        return LEVEL_ORDER[p.level] > LEVEL_ORDER[max] ? p.level : max;
      }, 'low');
    }

    return {
      total_combinations: totalPairs.length,
      contraindicated_pairs: contraindicatedPairs,
      safe_pairs: safePairs,
      overall_risk: overallRisk
    };
  }

  static _sortPair(type_a, type_b) {
    if (type_a <= type_b) {
      return { type_a, type_b };
    }
    return { type_a: type_b, type_b: type_a };
  }
}

module.exports = Contraindication;
