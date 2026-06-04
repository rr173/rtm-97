const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');

class EnvProcessWindow {
  static async initializeDefaults() {
    const defaults = [
      { param_name: 'temperature', param_min: 20, param_max: 35 },
      { param_name: 'humidity', param_min: 40, param_max: 70 },
      { param_name: 'rpm', param_min: 800, param_max: 1200 }
    ];

    for (const config of defaults) {
      const existing = await get(
        'SELECT id FROM env_process_window WHERE param_name = ?',
        [config.param_name]
      );
      if (!existing) {
        await run(`
          INSERT INTO env_process_window (param_name, param_min, param_max)
          VALUES (?, ?, ?)
        `, [config.param_name, config.param_min, config.param_max]);
      }
    }
  }

  static async getAll() {
    const rows = await all('SELECT * FROM env_process_window ORDER BY param_name');
    const result = {};
    rows.forEach(row => {
      result[row.param_name] = {
        min: row.param_min,
        max: row.param_max
      };
    });
    return result;
  }

  static async getByParam(paramName) {
    const row = await get(
      'SELECT * FROM env_process_window WHERE param_name = ?',
      [paramName]
    );
    if (!row) return null;
    return {
      param_name: row.param_name,
      min: row.param_min,
      max: row.param_max
    };
  }

  static async update(paramName, paramMin, paramMax) {
    const result = await run(`
      UPDATE env_process_window 
      SET param_min = ?, param_max = ?, updated_at = CURRENT_TIMESTAMP
      WHERE param_name = ?
    `, [paramMin, paramMax, paramName]);

    return result.changes > 0;
  }
}

class EnvDeviation {
  static async create(data) {
    const {
      product_batch_number,
      param_name,
      actual_value,
      window_min,
      window_max,
      deviation_direction,
      deviation_percent,
      collected_at
    } = data;

    const result = await run(`
      INSERT INTO env_deviations 
      (product_batch_number, param_name, actual_value, window_min, window_max, 
       deviation_direction, deviation_percent, collected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      product_batch_number,
      param_name,
      actual_value,
      window_min,
      window_max,
      deviation_direction,
      deviation_percent,
      collected_at
    ]);

    return result.lastID;
  }

  static async findByProductBatch(productBatchNumber) {
    return await all(`
      SELECT * FROM env_deviations 
      WHERE product_batch_number = ?
      ORDER BY collected_at ASC
    `, [productBatchNumber]);
  }

  static async findByProductBatchAndParam(productBatchNumber, paramName) {
    return await all(`
      SELECT * FROM env_deviations 
      WHERE product_batch_number = ? AND param_name = ?
      ORDER BY collected_at ASC
    `, [productBatchNumber, paramName]);
  }
}

class EnvReading {
  static async createBatch(readings) {
    if (readings.length === 0 || readings.length > 100) {
      throw new Error('一次最多上报100条数据');
    }

    const validParams = ['temperature', 'humidity', 'rpm'];
    const processWindow = await EnvProcessWindow.getAll();
    const createdIds = [];
    const deviationIds = [];

    await beginTransaction();
    try {
      for (const reading of readings) {
        const { product_batch, param, value, timestamp } = reading;

        if (!product_batch || !param || value === undefined || !timestamp) {
          throw new Error('每条数据必须包含: product_batch, param, value, timestamp');
        }

        if (!validParams.includes(param)) {
          throw new Error(`无效参数名: ${param}，有效值为: ${validParams.join(', ')}`);
        }

        const result = await run(`
          INSERT INTO env_readings 
          (product_batch_number, param_name, param_value, collected_at)
          VALUES (?, ?, ?, ?)
        `, [product_batch, param, value, timestamp]);

        createdIds.push(result.lastID);

        const window = processWindow[param];
        if (window) {
          const deviation = this._checkDeviation(value, window.min, window.max);
          if (deviation) {
            const devId = await EnvDeviation.create({
              product_batch_number: product_batch,
              param_name: param,
              actual_value: value,
              window_min: window.min,
              window_max: window.max,
              deviation_direction: deviation.direction,
              deviation_percent: deviation.percent,
              collected_at: timestamp
            });
            deviationIds.push(devId);
          }
        }
      }

      await commit();
      return { created_count: createdIds.length, deviation_count: deviationIds.length };
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static _checkDeviation(value, min, max) {
    if (value < min) {
      const percent = ((min - value) / (min === 0 ? 1 : Math.abs(min))) * 100;
      return {
        direction: 'low',
        percent: Math.round(percent * 100) / 100
      };
    } else if (value > max) {
      const percent = ((value - max) / (max === 0 ? 1 : Math.abs(max))) * 100;
      return {
        direction: 'high',
        percent: Math.round(percent * 100) / 100
      };
    }
    return null;
  }

  static async findByProductBatchAndParam(productBatchNumber, paramName) {
    return await all(`
      SELECT * FROM env_readings 
      WHERE product_batch_number = ? AND param_name = ?
      ORDER BY collected_at ASC
    `, [productBatchNumber, paramName]);
  }

  static async findByProductBatch(productBatchNumber) {
    return await all(`
      SELECT * FROM env_readings 
      WHERE product_batch_number = ?
      ORDER BY param_name, collected_at ASC
    `, [productBatchNumber]);
  }

  static async getDeviationsForBatch(productBatchNumber) {
    const deviations = await EnvDeviation.findByProductBatch(productBatchNumber);
    return deviations.map(dev => ({
      id: dev.id,
      param_name: dev.param_name,
      actual_value: dev.actual_value,
      window_min: dev.window_min,
      window_max: dev.window_max,
      deviation_direction: dev.deviation_direction,
      deviation_percent: dev.deviation_percent,
      collected_at: dev.collected_at,
      analysis: this._generateAnalysis(dev)
    }));
  }

  static _generateAnalysis(deviation) {
    const paramNames = {
      temperature: '温度',
      humidity: '湿度',
      rpm: '搅拌转速'
    };

    const paramName = paramNames[deviation.param_name] || deviation.param_name;
    const directionText = deviation.deviation_direction === 'high' ? '超了上限' : '低于下限';

    return `${paramName}${directionText}，实际值${deviation.actual_value}，范围[${deviation.window_min}, ${deviation.window_max}]，偏离${deviation.deviation_percent}%`;
  }
}

module.exports = {
  EnvProcessWindow,
  EnvDeviation,
  EnvReading
};
