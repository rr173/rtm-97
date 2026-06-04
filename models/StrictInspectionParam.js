const { run, get, all } = require('../config/database');

class StrictInspectionParam {
  static async getNormalParams(materialType) {
    return await all(
      'SELECT * FROM strict_inspection_params WHERE material_type = ? AND is_strict = 0',
      [materialType]
    );
  }

  static async getStrictParams(materialType) {
    return await all(
      'SELECT * FROM strict_inspection_params WHERE material_type = ? AND is_strict = 1',
      [materialType]
    );
  }

  static async getAllParamsWithSpecs(materialType) {
    return await all(
      'SELECT * FROM strict_inspection_params WHERE material_type = ? ORDER BY is_strict ASC, id ASC',
      [materialType]
    );
  }

  static async findByMaterialType(materialType) {
    return await all(
      'SELECT * FROM strict_inspection_params WHERE material_type = ? ORDER BY is_strict ASC, id ASC',
      [materialType]
    );
  }

  static async findAll() {
    return await all('SELECT * FROM strict_inspection_params ORDER BY material_type, is_strict ASC, id ASC');
  }

  static async create(materialType, paramName, isStrict, specMin, specMax) {
    const result = await run(`
      INSERT INTO strict_inspection_params (material_type, param_name, is_strict, spec_min, spec_max)
      VALUES (?, ?, ?, ?, ?)
    `, [materialType, paramName, isStrict ? 1 : 0, specMin !== undefined ? specMin : null, specMax !== undefined ? specMax : null]);
    return result.lastID;
  }

  static async delete(id) {
    return await run('DELETE FROM strict_inspection_params WHERE id = ?', [id]);
  }

  static async findByMaterialTypeGrouped(materialType) {
    const params = await this.findByMaterialType(materialType);
    const normal = params.filter(p => p.is_strict === 0).map(p => p.param_name);
    const strict = params.filter(p => p.is_strict === 1).map(p => p.param_name);
    return { normal, strict };
  }
}

module.exports = StrictInspectionParam;
