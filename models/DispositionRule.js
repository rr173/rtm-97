const { run, get, all } = require('../config/database');

const DISPOSITION_LEVELS = {
  concession: { level: 0, name: '让步接收' },
  rework: { level: 1, name: '返工' },
  downgrade: { level: 2, name: '降级' },
  scrap: { level: 3, name: '报废' }
};

class DispositionRule {
  static async create(paramName, deviationMin, deviationMax, dispositionLevel, description) {
    if (!DISPOSITION_LEVELS[dispositionLevel]) {
      throw new Error(`无效的处置等级: ${dispositionLevel}`);
    }

    if (deviationMax !== null && deviationMax !== undefined && deviationMin >= deviationMax) {
      throw new Error('偏离度区间无效，最小值必须小于最大值');
    }

    const result = await run(`
      INSERT INTO disposition_rules 
      (param_name, deviation_min, deviation_max, disposition_level, description)
      VALUES (?, ?, ?, ?, ?)
    `, [paramName, deviationMin, deviationMax, dispositionLevel, description]);

    return result.lastID;
  }

  static async findById(id) {
    return await get('SELECT * FROM disposition_rules WHERE id = ?', [id]);
  }

  static async findByParamName(paramName) {
    return await all(`
      SELECT * FROM disposition_rules 
      WHERE param_name = ? 
      ORDER BY deviation_min
    `, [paramName]);
  }

  static async findAll() {
    return await all('SELECT * FROM disposition_rules ORDER BY param_name, deviation_min');
  }

  static async update(id, updates) {
    const { param_name, deviation_min, deviation_max, disposition_level, description } = updates;
    
    const fields = [];
    const values = [];

    if (param_name !== undefined) {
      fields.push('param_name = ?');
      values.push(param_name);
    }
    if (deviation_min !== undefined) {
      fields.push('deviation_min = ?');
      values.push(deviation_min);
    }
    if (deviation_max !== undefined) {
      fields.push('deviation_max = ?');
      values.push(deviation_max);
    }
    if (disposition_level !== undefined) {
      if (!DISPOSITION_LEVELS[disposition_level]) {
        throw new Error(`无效的处置等级: ${disposition_level}`);
      }
      fields.push('disposition_level = ?');
      values.push(disposition_level);
    }
    if (description !== undefined) {
      fields.push('description = ?');
      values.push(description);
    }

    if (fields.length === 0) {
      return id;
    }

    values.push(id);
    await run(`UPDATE disposition_rules SET ${fields.join(', ')} WHERE id = ?`, values);
    return id;
  }

  static async delete(id) {
    return await run('DELETE FROM disposition_rules WHERE id = ?', [id]);
  }

  static matchDisposition(paramName, deviationPercent) {
    return all(`
      SELECT * FROM disposition_rules 
      WHERE param_name = ? 
      AND deviation_min <= ?
      AND (deviation_max IS NULL OR deviation_max > ?)
      ORDER BY deviation_min DESC
      LIMIT 1
    `, [paramName, deviationPercent, deviationPercent]).then(rules => {
      if (rules.length > 0) {
        return rules[0];
      }
      return {
        id: null,
        param_name: paramName,
        deviation_min: null,
        deviation_max: null,
        disposition_level: 'scrap',
        description: '默认规则：无匹配规则时报废'
      };
    });
  }

  static getHighestDisposition(rules) {
    let highest = null;
    let highestLevel = -1;

    for (const rule of rules) {
      const level = DISPOSITION_LEVELS[rule.disposition_level]?.level ?? -1;
      if (level > highestLevel) {
        highestLevel = level;
        highest = rule;
      }
    }

    return highest || { disposition_level: 'scrap', description: '默认规则：无匹配规则时报废' };
  }

  static getLevelName(level) {
    return DISPOSITION_LEVELS[level]?.name || level;
  }

  static compareLevels(level1, level2) {
    const l1 = DISPOSITION_LEVELS[level1]?.level ?? -1;
    const l2 = DISPOSITION_LEVELS[level2]?.level ?? -1;
    return l1 - l2;
  }
}

module.exports = DispositionRule;
