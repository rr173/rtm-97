const { run, get, all } = require('../config/database');

class ShelfLifeRule {
  static async create(data) {
    const {
      material_type,
      param_name,
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value
    } = data;

    const result = await run(`
      INSERT INTO shelf_life_rules 
      (material_type, param_name, decay_start_days, decay_rate, min_value)
      VALUES (?, ?, ?, ?, ?)
    `, [
      material_type,
      param_name,
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value
    ]);

    return result.lastID;
  }

  static async findById(id) {
    return await get('SELECT * FROM shelf_life_rules WHERE id = ?', [id]);
  }

  static async findByMaterialType(materialType) {
    return await all(
      'SELECT * FROM shelf_life_rules WHERE material_type = ? ORDER BY id',
      [materialType]
    );
  }

  static async findByMaterialAndParam(materialType, paramName) {
    return await get(
      'SELECT * FROM shelf_life_rules WHERE material_type = ? AND param_name = ?',
      [materialType, paramName]
    );
  }

  static async findAll() {
    return await all('SELECT * FROM shelf_life_rules ORDER BY material_type, param_name');
  }

  static async update(id, data) {
    const {
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value
    } = data;

    return await run(`
      UPDATE shelf_life_rules 
      SET decay_start_days = ?, decay_rate = ?, min_value = ?
      WHERE id = ?
    `, [
      decay_start_days_before_expiry,
      decay_rate_per_day,
      min_acceptable_value,
      id
    ]);
  }

  static async delete(id) {
    return await run('DELETE FROM shelf_life_rules WHERE id = ?', [id]);
  }

  static async upsert(data) {
    const existing = await this.findByMaterialAndParam(
      data.material_type,
      data.param_name
    );

    if (existing) {
      await this.update(existing.id, data);
      return existing.id;
    } else {
      return await this.create(data);
    }
  }
}

module.exports = ShelfLifeRule;
