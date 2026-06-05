const { exec, get, all, run } = require('../config/database');

async function initDatabase() {
  await exec(`
    CREATE TABLE IF NOT EXISTS formulas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_product TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS formula_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formula_id INTEGER NOT NULL,
      row_index INTEGER NOT NULL,
      material_type TEXT NOT NULL,
      standard_quantity REAL NOT NULL,
      tolerance_percent REAL NOT NULL,
      param_name TEXT NOT NULL,
      param_min REAL,
      param_max REAL,
      contribution_coefficient REAL DEFAULT 0,
      FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS formula_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formula_id INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      param_min REAL NOT NULL,
      param_max REAL NOT NULL,
      FOREIGN KEY (formula_id) REFERENCES formulas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS material_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_type TEXT NOT NULL,
      batch_number TEXT NOT NULL UNIQUE,
      total_quantity REAL NOT NULL,
      remaining_quantity REAL NOT NULL,
      supplier TEXT,
      receive_date TEXT NOT NULL,
      expiry_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '待检' CHECK(status IN ('待检', '合格', '拒收')),
      unit_price REAL,
      parent_batch_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_batch_id) REFERENCES material_batches(id)
    );

    CREATE TABLE IF NOT EXISTS material_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_batch_id INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      param_value REAL NOT NULL,
      FOREIGN KEY (material_batch_id) REFERENCES material_batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS substitution_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_type TEXT NOT NULL,
      substitute_type TEXT NOT NULL,
      correction_factor REAL NOT NULL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS batch_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_uuid TEXT NOT NULL UNIQUE,
      formula_id INTEGER NOT NULL,
      planned_quantity REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'executed', 'failed', 'expired')),
      plan_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (formula_id) REFERENCES formulas(id)
    );

    CREATE TABLE IF NOT EXISTS product_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_number TEXT NOT NULL UNIQUE,
      formula_id INTEGER NOT NULL,
      plan_id INTEGER,
      production_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      operator TEXT,
      total_yield REAL NOT NULL,
      FOREIGN KEY (formula_id) REFERENCES formulas(id),
      FOREIGN KEY (plan_id) REFERENCES batch_plans(id)
    );

    CREATE TABLE IF NOT EXISTS product_batch_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_batch_id INTEGER NOT NULL,
      material_batch_id INTEGER NOT NULL,
      formula_row_id INTEGER,
      material_type TEXT NOT NULL,
      quantity_used REAL NOT NULL,
      is_substitute INTEGER DEFAULT 0,
      param_snapshot TEXT,
      FOREIGN KEY (product_batch_id) REFERENCES product_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (material_batch_id) REFERENCES material_batches(id)
    );

    CREATE TABLE IF NOT EXISTS qc_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_number TEXT NOT NULL UNIQUE,
      product_batch_id INTEGER NOT NULL,
      product_batch_number TEXT NOT NULL,
      inspector TEXT NOT NULL,
      inspection_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      overall_result TEXT NOT NULL CHECK(overall_result IN ('qualified', 'unqualified')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_batch_id) REFERENCES product_batches(id)
    );

    CREATE TABLE IF NOT EXISTS qc_report_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      qc_report_id INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      measured_value REAL NOT NULL,
      spec_min REAL NOT NULL,
      spec_max REAL NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('qualified', 'unqualified')),
      deviation_percent REAL,
      deviation_direction TEXT CHECK(deviation_direction IN ('low', 'high', 'within')),
      FOREIGN KEY (qc_report_id) REFERENCES qc_reports(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS disposition_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      param_name TEXT NOT NULL,
      deviation_min REAL NOT NULL,
      deviation_max REAL,
      disposition_level TEXT NOT NULL CHECK(disposition_level IN ('concession', 'rework', 'downgrade', 'scrap')),
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS disposition_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      qc_report_id INTEGER NOT NULL,
      product_batch_id INTEGER NOT NULL,
      product_batch_number TEXT NOT NULL,
      disposition_level TEXT NOT NULL CHECK(disposition_level IN ('concession', 'rework', 'downgrade', 'scrap')),
      unqualified_items TEXT NOT NULL,
      suggested_action TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'executed', 'rejected', 'cancelled')),
      reject_reason TEXT,
      approved_by TEXT,
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (qc_report_id) REFERENCES qc_reports(id),
      FOREIGN KEY (product_batch_id) REFERENCES product_batches(id)
    );

    CREATE TABLE IF NOT EXISTS material_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_batch_id INTEGER NOT NULL UNIQUE,
      lock_reason TEXT NOT NULL,
      source_disposition_order_id INTEGER,
      locked_by TEXT,
      locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_locked INTEGER NOT NULL DEFAULT 1,
      unlock_reason TEXT,
      unlocked_by TEXT,
      unlocked_at DATETIME,
      FOREIGN KEY (material_batch_id) REFERENCES material_batches(id),
      FOREIGN KEY (source_disposition_order_id) REFERENCES disposition_orders(id)
    );

    CREATE TABLE IF NOT EXISTS incoming_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_number TEXT NOT NULL UNIQUE,
      material_batch_id INTEGER NOT NULL,
      batch_number TEXT NOT NULL,
      material_type TEXT NOT NULL,
      supplier TEXT,
      inspector TEXT NOT NULL,
      inspection_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      overall_result TEXT NOT NULL CHECK(overall_result IN ('qualified', 'unqualified')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (material_batch_id) REFERENCES material_batches(id)
    );

    CREATE TABLE IF NOT EXISTS incoming_report_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incoming_report_id INTEGER NOT NULL,
      param_name TEXT NOT NULL,
      measured_value REAL NOT NULL,
      spec_min REAL,
      spec_max REAL,
      result TEXT NOT NULL CHECK(result IN ('qualified', 'unqualified')),
      deviation_percent REAL,
      deviation_direction TEXT CHECK(deviation_direction IN ('low', 'high', 'within')),
      FOREIGN KEY (incoming_report_id) REFERENCES incoming_reports(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supplier_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT NOT NULL UNIQUE,
      score REAL NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT '正常' CHECK(status IN ('正常', '观察', '黑名单')),
      total_batches INTEGER NOT NULL DEFAULT 0,
      qualified_batches INTEGER NOT NULL DEFAULT 0,
      last_20_qualified INTEGER NOT NULL DEFAULT 0,
      last_20_total INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS strict_inspection_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_type TEXT NOT NULL,
      param_name TEXT NOT NULL,
      is_strict INTEGER NOT NULL DEFAULT 0,
      spec_min REAL,
      spec_max REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_type, param_name)
    );

    CREATE TABLE IF NOT EXISTS contraindications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_a TEXT NOT NULL,
      type_b TEXT NOT NULL,
      level TEXT NOT NULL CHECK(level IN ('low', 'medium', 'high', 'critical')),
      description TEXT NOT NULL,
      discovered_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(type_a, type_b)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      material_batch_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'executed', 'expired', 'cancelled')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      renew_count INTEGER DEFAULT 0,
      FOREIGN KEY (plan_id) REFERENCES batch_plans(id),
      FOREIGN KEY (material_batch_id) REFERENCES material_batches(id)
    );

    CREATE TABLE IF NOT EXISTS reservation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('created', 'renewed', 'expired', 'cancelled', 'executed')),
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      operator TEXT NOT NULL DEFAULT 'system',
      FOREIGN KEY (plan_id) REFERENCES batch_plans(id)
    );

    CREATE INDEX IF NOT EXISTS idx_incoming_reports_batch ON incoming_reports(material_batch_id);
    CREATE INDEX IF NOT EXISTS idx_incoming_report_items_report ON incoming_report_items(incoming_report_id);
    CREATE INDEX IF NOT EXISTS idx_supplier_scores_name ON supplier_scores(supplier_name);
    CREATE INDEX IF NOT EXISTS idx_strict_inspection_type ON strict_inspection_params(material_type);
    CREATE INDEX IF NOT EXISTS idx_material_batches_status ON material_batches(status);
    CREATE INDEX IF NOT EXISTS idx_formula_specs_formula_id ON formula_specs(formula_id);
    CREATE INDEX IF NOT EXISTS idx_material_batches_type ON material_batches(material_type);
    CREATE INDEX IF NOT EXISTS idx_material_params_batch_id ON material_params(material_batch_id);
    CREATE INDEX IF NOT EXISTS idx_product_batch_materials_product ON product_batch_materials(product_batch_id);
    CREATE INDEX IF NOT EXISTS idx_product_batch_materials_material ON product_batch_materials(material_batch_id);
    CREATE INDEX IF NOT EXISTS idx_qc_reports_product_batch ON qc_reports(product_batch_id);
    CREATE INDEX IF NOT EXISTS idx_qc_report_items_report ON qc_report_items(qc_report_id);
    CREATE INDEX IF NOT EXISTS idx_disposition_rules_param ON disposition_rules(param_name);
    CREATE INDEX IF NOT EXISTS idx_disposition_orders_status ON disposition_orders(status);
    CREATE INDEX IF NOT EXISTS idx_disposition_orders_product_batch ON disposition_orders(product_batch_id);
    CREATE INDEX IF NOT EXISTS idx_material_locks_batch ON material_locks(material_batch_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_plan ON reservations(plan_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_batch ON reservations(material_batch_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);
    CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at);
    CREATE INDEX IF NOT EXISTS idx_contraindications_type_a ON contraindications(type_a);
    CREATE INDEX IF NOT EXISTS idx_contraindications_type_b ON contraindications(type_b);
    CREATE INDEX IF NOT EXISTS idx_contraindications_level ON contraindications(level);

    CREATE INDEX IF NOT EXISTS idx_reservation_events_plan ON reservation_events(plan_id);
    CREATE INDEX IF NOT EXISTS idx_reservation_events_type ON reservation_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_reservation_events_occurred ON reservation_events(occurred_at);

    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL UNIQUE,
      source_batch_id INTEGER NOT NULL,
      new_batch_id INTEGER,
      quantity REAL NOT NULL,
      destination_line TEXT NOT NULL,
      operator TEXT NOT NULL,
      approver TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'return_error')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME,
      FOREIGN KEY (source_batch_id) REFERENCES material_batches(id),
      FOREIGN KEY (new_batch_id) REFERENCES material_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
    CREATE INDEX IF NOT EXISTS idx_transfers_source_batch ON transfers(source_batch_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_new_batch ON transfers(new_batch_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_destination ON transfers(destination_line);
    CREATE INDEX IF NOT EXISTS idx_material_batches_parent ON material_batches(parent_batch_id);

    CREATE TABLE IF NOT EXISTS env_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_batch_number TEXT NOT NULL,
      param_name TEXT NOT NULL CHECK(param_name IN ('temperature', 'humidity', 'rpm')),
      param_value REAL NOT NULL,
      collected_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS env_process_window (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      param_name TEXT NOT NULL UNIQUE CHECK(param_name IN ('temperature', 'humidity', 'rpm')),
      param_min REAL NOT NULL,
      param_max REAL NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS env_deviations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_batch_number TEXT NOT NULL,
      param_name TEXT NOT NULL CHECK(param_name IN ('temperature', 'humidity', 'rpm')),
      actual_value REAL NOT NULL,
      window_min REAL NOT NULL,
      window_max REAL NOT NULL,
      deviation_direction TEXT NOT NULL CHECK(deviation_direction IN ('high', 'low')),
      deviation_percent REAL NOT NULL,
      collected_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_env_readings_batch ON env_readings(product_batch_number);
    CREATE INDEX IF NOT EXISTS idx_env_readings_param ON env_readings(param_name);
    CREATE INDEX IF NOT EXISTS idx_env_readings_collected_at ON env_readings(collected_at);
    CREATE INDEX IF NOT EXISTS idx_env_readings_batch_param ON env_readings(product_batch_number, param_name);
    CREATE INDEX IF NOT EXISTS idx_env_deviations_batch ON env_deviations(product_batch_number);
    CREATE INDEX IF NOT EXISTS idx_env_deviations_param ON env_deviations(param_name);
    CREATE INDEX IF NOT EXISTS idx_env_deviations_collected_at ON env_deviations(collected_at);

    CREATE TABLE IF NOT EXISTS shelf_life_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_type TEXT NOT NULL,
      param_name TEXT NOT NULL,
      decay_start_days INTEGER NOT NULL,
      decay_rate REAL NOT NULL,
      min_value REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_type, param_name)
    );

    CREATE INDEX IF NOT EXISTS idx_shelf_life_rules_type ON shelf_life_rules(material_type);
    CREATE INDEX IF NOT EXISTS idx_shelf_life_rules_param ON shelf_life_rules(param_name);
  `);

  await migrateDispositionOrdersStatus();
  await migrateMaterialBatchesStatus();
  await migrateBatchPlansStatus();
  await migrateMaterialBatchesUnitPrice();
  await migrateReservationsRenewCount();
  await migrateReservationEventsTable();
  await migrateMaterialBatchesParentBatchId();
  await migrateTransfersTable();

  console.log('数据库初始化完成');
}

if (require.main === module) {
  initDatabase().catch(console.error);
}

async function migrateDispositionOrdersStatus() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='disposition_orders'");
    if (row && row.sql && !row.sql.includes("'cancelled'")) {
      await exec(`
        CREATE TABLE disposition_orders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_number TEXT NOT NULL UNIQUE,
          qc_report_id INTEGER NOT NULL,
          product_batch_id INTEGER NOT NULL,
          product_batch_number TEXT NOT NULL,
          disposition_level TEXT NOT NULL CHECK(disposition_level IN ('concession', 'rework', 'downgrade', 'scrap')),
          unqualified_items TEXT NOT NULL,
          suggested_action TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'executed', 'rejected', 'cancelled')),
          reject_reason TEXT,
          approved_by TEXT,
          approved_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (qc_report_id) REFERENCES qc_reports(id),
          FOREIGN KEY (product_batch_id) REFERENCES product_batches(id)
        );

        INSERT INTO disposition_orders_new SELECT * FROM disposition_orders;

        DROP TABLE disposition_orders;

        ALTER TABLE disposition_orders_new RENAME TO disposition_orders;
      `);

      console.log('  已迁移 disposition_orders 表: status CHECK 增加 cancelled 值');
    }
  } catch (err) {
    console.error('  迁移 disposition_orders 表失败:', err.message);
  }
}

async function migrateMaterialBatchesStatus() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_batches'");
    if (row && row.sql && !row.sql.includes("'待检'")) {
      await exec(`
        CREATE TABLE material_batches_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          material_type TEXT NOT NULL,
          batch_number TEXT NOT NULL UNIQUE,
          total_quantity REAL NOT NULL,
          remaining_quantity REAL NOT NULL,
          supplier TEXT,
          receive_date TEXT NOT NULL,
          expiry_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '待检' CHECK(status IN ('待检', '合格', '拒收')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO material_batches_new
          SELECT id, material_type, batch_number, total_quantity, remaining_quantity,
                 supplier, receive_date, expiry_date, '合格', created_at
          FROM material_batches;

        DROP TABLE material_batches;

        ALTER TABLE material_batches_new RENAME TO material_batches;
      `);

      console.log('  已迁移 material_batches 表: 新增 status 字段，已有批次默认为合格');
    }
  } catch (err) {
    console.error('  迁移 material_batches 表失败:', err.message);
  }
}

async function migrateBatchPlansStatus() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='batch_plans'");
    if (row && row.sql && !row.sql.includes("'expired'")) {
      await exec(`
        CREATE TABLE batch_plans_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_uuid TEXT NOT NULL UNIQUE,
          formula_id INTEGER NOT NULL,
          planned_quantity REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'executed', 'failed', 'expired')),
          plan_data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (formula_id) REFERENCES formulas(id)
        );

        INSERT INTO batch_plans_new SELECT * FROM batch_plans;

        DROP TABLE batch_plans;

        ALTER TABLE batch_plans_new RENAME TO batch_plans;
      `);

      console.log('  已迁移 batch_plans 表: status CHECK 增加 expired 值');
    }
  } catch (err) {
    console.error('  迁移 batch_plans 表失败:', err.message);
  }
}

async function migrateMaterialBatchesUnitPrice() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_batches'");
    if (row && row.sql && !row.sql.includes('unit_price')) {
      await exec(`ALTER TABLE material_batches ADD COLUMN unit_price REAL`);
      console.log('  已迁移 material_batches 表: 新增 unit_price 字段');
    }
  } catch (err) {
    console.error('  迁移 material_batches 表失败:', err.message);
  }
}

async function migrateReservationsRenewCount() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='reservations'");
    if (row && row.sql && !row.sql.includes('renew_count')) {
      await exec(`ALTER TABLE reservations ADD COLUMN renew_count INTEGER DEFAULT 0`);
      console.log('  已迁移 reservations 表: 新增 renew_count 字段');
    }
  } catch (err) {
    console.error('  迁移 reservations 表失败:', err.message);
  }
}

async function migrateReservationEventsTable() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='reservation_events'");
    if (!row) {
      await exec(`
        CREATE TABLE IF NOT EXISTS reservation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id INTEGER NOT NULL,
          event_type TEXT NOT NULL CHECK(event_type IN ('created', 'renewed', 'expired', 'cancelled', 'executed')),
          occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          operator TEXT NOT NULL DEFAULT 'system',
          FOREIGN KEY (plan_id) REFERENCES batch_plans(id)
        );
        CREATE INDEX IF NOT EXISTS idx_reservation_events_plan ON reservation_events(plan_id);
        CREATE INDEX IF NOT EXISTS idx_reservation_events_type ON reservation_events(event_type);
        CREATE INDEX IF NOT EXISTS idx_reservation_events_occurred ON reservation_events(occurred_at);
      `);
      console.log('  已创建 reservation_events 表');
    }
  } catch (err) {
    console.error('  创建 reservation_events 表失败:', err.message);
  }
}

async function migrateMaterialBatchesParentBatchId() {
  try {
    const row = await get("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_batches'");
    if (row && row.sql && !row.sql.includes('parent_batch_id')) {
      await exec(`ALTER TABLE material_batches ADD COLUMN parent_batch_id INTEGER`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_material_batches_parent ON material_batches(parent_batch_id)`);
      console.log('  已迁移 material_batches 表: 新增 parent_batch_id 字段');
    }
  } catch (err) {
    console.error('  迁移 material_batches parent_batch_id 失败:', err.message);
  }
}

async function migrateTransfersTable() {
  try {
    const row = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='transfers'");
    if (!row) {
      await exec(`
        CREATE TABLE IF NOT EXISTS transfers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transfer_number TEXT NOT NULL UNIQUE,
          source_batch_id INTEGER NOT NULL,
          new_batch_id INTEGER,
          quantity REAL NOT NULL,
          destination_line TEXT NOT NULL,
          operator TEXT NOT NULL,
          approver TEXT,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'return_error')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          approved_at DATETIME,
          FOREIGN KEY (source_batch_id) REFERENCES material_batches(id),
          FOREIGN KEY (new_batch_id) REFERENCES material_batches(id)
        );
        CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
        CREATE INDEX IF NOT EXISTS idx_transfers_source_batch ON transfers(source_batch_id);
        CREATE INDEX IF NOT EXISTS idx_transfers_new_batch ON transfers(new_batch_id);
        CREATE INDEX IF NOT EXISTS idx_transfers_destination ON transfers(destination_line);
      `);
      console.log('  已创建 transfers 表');
    }
  } catch (err) {
    console.error('  创建 transfers 表失败:', err.message);
  }
}

module.exports = initDatabase;
