const { run, all } = require('../config/database');

class SubstitutionRule {
  static async create(original_type, substitute_type, correction_factor) {
    return await run(`
      INSERT INTO substitution_rules (original_type, substitute_type, correction_factor)
      VALUES (?, ?, ?)
    `, [original_type, substitute_type, correction_factor]);
  }

  static async findByOriginal(original_type) {
    return await all(`
      SELECT * FROM substitution_rules WHERE original_type = ?
    `, [original_type]);
  }

  static async findAll() {
    return await all('SELECT * FROM substitution_rules ORDER BY id');
  }

  static async delete(id) {
    return await run('DELETE FROM substitution_rules WHERE id = ?', [id]);
  }
}

module.exports = SubstitutionRule;
