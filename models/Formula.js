const { run, get, all } = require('../config/database');

class Formula {
  static async create(name, targetProduct, rows, specs) {
    const result = await run(
      'INSERT INTO formulas (name, target_product) VALUES (?, ?)',
      [name, targetProduct]
    );
    const formulaId = result.lastID;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await run(`
        INSERT INTO formula_rows 
        (formula_id, row_index, material_type, standard_quantity, tolerance_percent, 
         param_name, param_min, param_max, contribution_coefficient)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        formulaId,
        i,
        row.material_type,
        row.standard_quantity,
        row.tolerance_percent,
        row.param_name,
        row.param_min,
        row.param_max,
        row.contribution_coefficient || 0
      ]);
    }

    for (const spec of specs) {
      await run(`
        INSERT INTO formula_specs (formula_id, param_name, param_min, param_max)
        VALUES (?, ?, ?, ?)
      `, [formulaId, spec.param_name, spec.param_min, spec.param_max]);
    }

    return formulaId;
  }

  static async findById(id) {
    const formula = await get('SELECT * FROM formulas WHERE id = ?', [id]);
    if (!formula) return null;

    formula.rows = await all(`
      SELECT * FROM formula_rows WHERE formula_id = ? ORDER BY row_index
    `, [id]);

    formula.specs = await all(`
      SELECT * FROM formula_specs WHERE formula_id = ?
    `, [id]);

    return formula;
  }

  static async findAll() {
    const formulas = await all('SELECT * FROM formulas ORDER BY id');
    
    for (const f of formulas) {
      f.rows = await all(`
        SELECT * FROM formula_rows WHERE formula_id = ? ORDER BY row_index
      `, [f.id]);
      f.specs = await all(`
        SELECT * FROM formula_specs WHERE formula_id = ?
      `, [f.id]);
    }
    
    return formulas;
  }

  static async delete(id) {
    return await run('DELETE FROM formulas WHERE id = ?', [id]);
  }

  static async update(id, updates) {
    const { name, targetProduct, rows, specs } = updates;
    
    if (name || targetProduct) {
      const fields = [];
      const values = [];
      if (name) { fields.push('name = ?'); values.push(name); }
      if (targetProduct) { fields.push('target_product = ?'); values.push(targetProduct); }
      values.push(id);
      
      await run(`UPDATE formulas SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    if (rows) {
      await run('DELETE FROM formula_rows WHERE formula_id = ?', [id]);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        await run(`
          INSERT INTO formula_rows 
          (formula_id, row_index, material_type, standard_quantity, tolerance_percent, 
           param_name, param_min, param_max, contribution_coefficient)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          i,
          row.material_type,
          row.standard_quantity,
          row.tolerance_percent,
          row.param_name,
          row.param_min,
          row.param_max,
          row.contribution_coefficient || 0
        ]);
      }
    }

    if (specs) {
      await run('DELETE FROM formula_specs WHERE formula_id = ?', [id]);
      for (const spec of specs) {
        await run(`
          INSERT INTO formula_specs (formula_id, param_name, param_min, param_max)
          VALUES (?, ?, ?, ?)
        `, [id, spec.param_name, spec.param_min, spec.param_max]);
      }
    }

    return id;
  }
}

module.exports = Formula;
