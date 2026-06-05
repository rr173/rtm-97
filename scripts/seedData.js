const { get, run } = require('../config/database');
const Formula = require('../models/Formula');
const MaterialBatch = require('../models/MaterialBatch');
const SubstitutionRule = require('../models/SubstitutionRule');
const DispositionRule = require('../models/DispositionRule');
const StrictInspectionParam = require('../models/StrictInspectionParam');
const Contraindication = require('../models/Contraindication');

function getFutureDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().split('T')[0];
}

function getPastDate(daysAgo) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split('T')[0];
}

async function seedData() {
  const stats = {
    formulas: 0,
    materials: 0,
    substitution_rules: 0,
    disposition_rules: 0,
    strict_params: 0,
    contraindications: 0
  };

  const existingFormulas = await get('SELECT COUNT(*) as count FROM formulas');
  const existingMaterials = await get('SELECT COUNT(*) as count FROM material_batches');
  const existingSubRules = await get('SELECT COUNT(*) as count FROM substitution_rules');
  const existingDispRules = await get('SELECT COUNT(*) as count FROM disposition_rules');
  const existingStrictParams = await get('SELECT COUNT(*) as count FROM strict_inspection_params');
  const existingContraindications = await get('SELECT COUNT(*) as count FROM contraindications');

  console.log('--- 模块增量检查 ---');
  console.log(`  配方: ${existingFormulas.count} 条已存在`);
  console.log(`  原料批次: ${existingMaterials.count} 条已存在`);
  console.log(`  替代规则: ${existingSubRules.count} 条已存在`);
  console.log(`  处置规则: ${existingDispRules.count} 条已存在`);
  console.log(`  加严检验参数: ${existingStrictParams.count} 条已存在`);
  console.log(`  配伍禁忌: ${existingContraindications.count} 条已存在`);
  console.log('--------------------');

  if (existingFormulas.count === 0) {
    console.log('\n[配方模块] 无数据，开始加载...');

    const formula1Rows = [
      {
        material_type: '环氧树脂A',
        standard_quantity: 60,
        tolerance_percent: 5,
        param_name: 'purity',
        param_min: 99.2,
        param_max: null,
        contribution_coefficient: 0.6
      },
      {
        material_type: '固化剂B',
        standard_quantity: 25,
        tolerance_percent: 3,
        param_name: 'viscosity',
        param_min: 3000,
        param_max: 5000,
        contribution_coefficient: 0.3
      },
      {
        material_type: '稀释剂C',
        standard_quantity: 15,
        tolerance_percent: 5,
        param_name: 'ph',
        param_min: 6.5,
        param_max: 7.5,
        contribution_coefficient: 0.1
      }
    ];

    const formula1Specs = [
      { param_name: 'solid_content', param_min: 68, param_max: 72 },
      { param_name: 'viscosity', param_min: 8000, param_max: 12000 }
    ];

    await Formula.create('环氧胶黏剂配方-标准型', '环氧胶黏剂A-100', formula1Rows, formula1Specs);
    console.log('  ✓ 创建配方1: 环氧胶黏剂配方-标准型');

    const formula2Rows = [
      {
        material_type: '环氧树脂A-改',
        standard_quantity: 55,
        tolerance_percent: 5,
        param_name: 'purity',
        param_min: 99.0,
        param_max: null,
        contribution_coefficient: 0.5
      },
      {
        material_type: '固化剂B',
        standard_quantity: 30,
        tolerance_percent: 3,
        param_name: 'viscosity',
        param_min: 2500,
        param_max: 5500,
        contribution_coefficient: 0.35
      },
      {
        material_type: '稀释剂C',
        standard_quantity: 10,
        tolerance_percent: 5,
        param_name: 'ph',
        param_min: 6.0,
        param_max: 8.0,
        contribution_coefficient: 0.15
      },
      {
        material_type: '促进剂D',
        standard_quantity: 5,
        tolerance_percent: 10,
        param_name: 'purity',
        param_min: 98.0,
        param_max: null,
        contribution_coefficient: 0
      }
    ];

    const formula2Specs = [
      { param_name: 'solid_content', param_min: 70, param_max: 75 },
      { param_name: 'viscosity', param_min: 10000, param_max: 15000 },
      { param_name: 'hardness', param_min: 75, param_max: 90 }
    ];

    await Formula.create('环氧胶黏剂配方-高强度型', '环氧胶黏剂B-200', formula2Rows, formula2Specs);
    console.log('  ✓ 创建配方2: 环氧胶黏剂配方-高强度型');
    stats.formulas = 2;
  } else {
    console.log('[配方模块] 已有数据，跳过');
  }

  console.log('\n[配方迁移检查] 检测老版本配方数据...');
  const formula2 = await get("SELECT id FROM formulas WHERE name = '环氧胶黏剂配方-高强度型'");
  if (formula2) {
    const oldRow = await get(
      "SELECT id FROM formula_rows WHERE formula_id = ? AND row_index = 0 AND material_type = '环氧树脂A'",
      [formula2.id]
    );
    if (oldRow) {
      console.log('  ⚠ 检测到老版本配方2（使用环氧树脂A），正在升级为环氧树脂A-改...');
      await run(
        "UPDATE formula_rows SET material_type = '环氧树脂A-改' WHERE id = ?",
        [oldRow.id]
      );
      console.log('  ✓ 配方2原料升级完成: 环氧树脂A → 环氧树脂A-改');
    } else {
      console.log('  ✓ 配方2已是最新版本，无需迁移');
    }
  }

  if (existingMaterials.count === 0) {
    console.log('\n[原料批次模块] 无数据，开始加载...');
    const materials = [
      {
        material_type: '环氧树脂A',
        batch_number: 'EP-A-2025-001',
        total_quantity: 2000,
        remaining_quantity: 2000,
        supplier: '化工原料有限公司',
        receive_date: getPastDate(30),
        expiry_date: getFutureDate(335),
        params: { purity: 99.5, viscosity: 4200, ph: 7.2 },
        unit_price: 45
      },
      {
        material_type: '环氧树脂A',
        batch_number: 'EP-A-2025-002',
        total_quantity: 1500,
        remaining_quantity: 1500,
        supplier: '化工原料有限公司',
        receive_date: getPastDate(15),
        expiry_date: getFutureDate(350),
        params: { purity: 99.3, viscosity: 4500, ph: 7.0 },
        unit_price: 47
      },
      {
        material_type: '环氧树脂A-改',
        batch_number: 'EP-A-M-2025-001',
        total_quantity: 1000,
        remaining_quantity: 1000,
        supplier: '新材料科技公司',
        receive_date: getPastDate(10),
        expiry_date: getFutureDate(355),
        params: { purity: 99.6, viscosity: 4000, ph: 7.1 },
        unit_price: 52
      },
      {
        material_type: '固化剂B',
        batch_number: 'CU-B-2025-001',
        total_quantity: 1000,
        remaining_quantity: 1000,
        supplier: '固化剂专业厂',
        receive_date: getPastDate(20),
        expiry_date: getFutureDate(345),
        params: { purity: 99.0, viscosity: 4000, ph: 8.5 },
        unit_price: 38
      },
      {
        material_type: '固化剂B',
        batch_number: 'CU-B-2025-002',
        total_quantity: 800,
        remaining_quantity: 800,
        supplier: '固化剂专业厂',
        receive_date: getPastDate(5),
        expiry_date: getFutureDate(360),
        params: { purity: 99.2, viscosity: 3800, ph: 8.3 },
        unit_price: 40
      },
      {
        material_type: '稀释剂C',
        batch_number: 'DL-C-2025-001',
        total_quantity: 500,
        remaining_quantity: 500,
        supplier: '溶剂化工公司',
        receive_date: getPastDate(25),
        expiry_date: getFutureDate(340),
        params: { purity: 99.8, viscosity: 100, ph: 7.0 },
        unit_price: 15
      },
      {
        material_type: '稀释剂C',
        batch_number: 'DL-C-2025-002',
        total_quantity: 600,
        remaining_quantity: 600,
        supplier: '溶剂化工公司',
        receive_date: getPastDate(8),
        expiry_date: getFutureDate(357),
        params: { purity: 99.7, viscosity: 95, ph: 7.2 },
        unit_price: 16
      },
      {
        material_type: '促进剂D',
        batch_number: 'AC-D-2025-001',
        total_quantity: 200,
        remaining_quantity: 200,
        supplier: '助剂生产厂',
        receive_date: getPastDate(12),
        expiry_date: getFutureDate(353),
        params: { purity: 98.5, melting_point: 85 },
        unit_price: 120
      },
      {
        material_type: '促进剂D',
        batch_number: 'AC-D-2025-002',
        total_quantity: 300,
        remaining_quantity: 300,
        supplier: '助剂生产厂',
        receive_date: getPastDate(3),
        expiry_date: getFutureDate(362),
        params: { purity: 98.8, melting_point: 86 },
        unit_price: 125
      }
    ];

    for (const m of materials) {
      await MaterialBatch.create(m);
      console.log(`  ✓ 录入原料批次: ${m.material_type} - ${m.batch_number}`);
    }
    stats.materials = 9;
  } else {
    console.log('[原料批次模块] 已有数据，跳过');
  }

  if (existingSubRules.count === 0) {
    console.log('\n[替代规则模块] 无数据，开始加载...');
    await SubstitutionRule.create('环氧树脂A', '环氧树脂A-改', 1.05);
    console.log('  ✓ 创建替代规则: 环氧树脂A → 环氧树脂A-改 (修正系数 1.05)');
    stats.substitution_rules = 1;
  } else {
    console.log('[替代规则模块] 已有数据，跳过');
  }

  if (existingDispRules.count === 0) {
    console.log('\n[处置规则模块] 无数据，开始加载...');
    const dispositionRules = [
      { param_name: 'solid_content', deviation_min: 0, deviation_max: 5, disposition_level: 'concession', description: '固含量轻微偏离，可让步接收' },
      { param_name: 'solid_content', deviation_min: 5, deviation_max: 15, disposition_level: 'rework', description: '固含量偏离较大，需返工调整' },
      { param_name: 'solid_content', deviation_min: 15, deviation_max: 30, disposition_level: 'downgrade', description: '固含量严重偏离，降级使用' },
      { param_name: 'solid_content', deviation_min: 30, deviation_max: null, disposition_level: 'scrap', description: '固含量极度偏离，报废处理' },
      { param_name: 'viscosity', deviation_min: 0, deviation_max: 5, disposition_level: 'concession', description: '粘度轻微偏离，可让步接收' },
      { param_name: 'viscosity', deviation_min: 5, deviation_max: 15, disposition_level: 'rework', description: '粘度偏离较大，需返工调整' },
      { param_name: 'viscosity', deviation_min: 15, deviation_max: 30, disposition_level: 'downgrade', description: '粘度严重偏离，降级使用' },
      { param_name: 'viscosity', deviation_min: 30, deviation_max: null, disposition_level: 'scrap', description: '粘度极度偏离，报废处理' }
    ];

    for (const rule of dispositionRules) {
      await DispositionRule.create(
        rule.param_name,
        rule.deviation_min,
        rule.deviation_max,
        rule.disposition_level,
        rule.description
      );
      console.log(`  ✓ 创建处置规则: ${rule.param_name} 偏离${rule.deviation_min}-${rule.deviation_max || '∞'}% → ${rule.disposition_level}`);
    }
    stats.disposition_rules = 8;
  } else {
    console.log('[处置规则模块] 已有数据，跳过');
  }

  if (existingStrictParams.count === 0) {
    console.log('\n[加严检验参数模块] 无数据，开始加载...');
    const strictInspectionConfigs = [
      { material_type: '环氧树脂A', param_name: 'purity', is_strict: false, spec_min: 99.0, spec_max: null },
      { material_type: '环氧树脂A', param_name: 'viscosity', is_strict: true, spec_min: 3000, spec_max: 6000 },
      { material_type: '环氧树脂A', param_name: 'ph', is_strict: true, spec_min: 6.0, spec_max: 8.0 },
      { material_type: '固化剂B', param_name: 'viscosity', is_strict: false, spec_min: 2500, spec_max: 5500 },
      { material_type: '固化剂B', param_name: 'purity', is_strict: true, spec_min: 98.5, spec_max: null },
      { material_type: '稀释剂C', param_name: 'ph', is_strict: false, spec_min: 6.0, spec_max: 8.0 },
      { material_type: '稀释剂C', param_name: 'purity', is_strict: true, spec_min: 99.0, spec_max: null },
      { material_type: '促进剂D', param_name: 'purity', is_strict: false, spec_min: 98.0, spec_max: null },
      { material_type: '促进剂D', param_name: 'melting_point', is_strict: true, spec_min: 80, spec_max: 95 },
      { material_type: '环氧树脂A-改', param_name: 'purity', is_strict: false, spec_min: 99.0, spec_max: null },
      { material_type: '环氧树脂A-改', param_name: 'viscosity', is_strict: true, spec_min: 3000, spec_max: 6000 },
      { material_type: '环氧树脂A-改', param_name: 'ph', is_strict: true, spec_min: 6.0, spec_max: 8.0 }
    ];

    for (const config of strictInspectionConfigs) {
      await StrictInspectionParam.create(
        config.material_type,
        config.param_name,
        config.is_strict,
        config.spec_min,
        config.spec_max
      );
      const typeLabel = config.is_strict ? '加严' : '正常';
      console.log(`  ✓ 配置检验参数: ${config.material_type} - ${config.param_name} (${typeLabel})`);
    }
    stats.strict_params = 12;
  } else {
    console.log('[加严检验参数模块] 已有数据，跳过');
  }

  const allMaterialCount = await get('SELECT COUNT(*) as count FROM material_batches');
  if (allMaterialCount.count > 0) {
    await run("UPDATE material_batches SET status = '合格' WHERE status = '待检'");
    console.log('\n  ✓ 原料批次状态更新完成，所有批次已设为合格');

    const priceUpdates = [
      { batch_number: 'EP-A-2025-001', unit_price: 45 },
      { batch_number: 'EP-A-2025-002', unit_price: 47 },
      { batch_number: 'EP-A-M-2025-001', unit_price: 52 },
      { batch_number: 'CU-B-2025-001', unit_price: 38 },
      { batch_number: 'CU-B-2025-002', unit_price: 40 },
      { batch_number: 'DL-C-2025-001', unit_price: 15 },
      { batch_number: 'DL-C-2025-002', unit_price: 16 },
      { batch_number: 'AC-D-2025-001', unit_price: 120 },
      { batch_number: 'AC-D-2025-002', unit_price: 125 }
    ];

    for (const update of priceUpdates) {
      await run(
        "UPDATE material_batches SET unit_price = ? WHERE batch_number = ? AND unit_price IS NULL",
        [update.unit_price, update.batch_number]
      );
    }
    console.log('  ✓ 原料批次单价更新完成');
  }

  if (existingContraindications.count === 0) {
    console.log('\n[配伍禁忌模块] 无数据，开始加载...');
    const contraindications = [
      {
        type_a: '环氧树脂A',
        type_b: '促进剂D',
        level: 'high',
        description: '混合放热超过80℃',
        discovered_date: '2025-03-15'
      },
      {
        type_a: '固化剂B',
        type_b: '稀释剂C',
        level: 'low',
        description: '混合后轻微变色',
        discovered_date: '2025-04-20'
      },
      {
        type_a: '固化剂B',
        type_b: '环氧树脂A-改',
        level: 'critical',
        description: '接触后30秒内凝固',
        discovered_date: '2025-05-10'
      }
    ];

    for (const c of contraindications) {
      try {
        await Contraindication.create(c.type_a, c.type_b, c.level, c.description, c.discovered_date);
        console.log(`  ✓ 创建配伍禁忌: ${c.type_a} + ${c.type_b} = ${c.level} (${c.description})`);
        stats.contraindications++;
      } catch (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          console.log(`  - 跳过重复禁忌: ${c.type_a} + ${c.type_b}`);
        } else {
          throw err;
        }
      }
    }
  } else {
    console.log('[配伍禁忌模块] 已有数据，跳过');
  }

  const finalStats = {
    formulas: stats.formulas > 0 ? stats.formulas : existingFormulas.count,
    materials: stats.materials > 0 ? stats.materials : existingMaterials.count,
    substitution_rules: stats.substitution_rules > 0 ? stats.substitution_rules : existingSubRules.count,
    disposition_rules: stats.disposition_rules > 0 ? stats.disposition_rules : existingDispRules.count,
    strict_params: stats.strict_params > 0 ? stats.strict_params : existingStrictParams.count,
    contraindications: stats.contraindications > 0 ? stats.contraindications : existingContraindications.count
  };

  console.log('\n========================================');
  console.log('演示数据加载完成（增量模式）');
  console.log('----------------------------------------');
  console.log(`  配方: ${finalStats.formulas} 条`);
  console.log(`  原料批次: ${finalStats.materials} 条`);
  console.log(`  原料类型: 6种 (环氧树脂A, 环氧树脂A-改, 固化剂B, 稀释剂C, 促进剂D)`);
  console.log(`  替代规则: ${finalStats.substitution_rules} 条`);
  console.log(`  处置规则: ${finalStats.disposition_rules} 条`);
  console.log(`  加严检验配置: ${finalStats.strict_params} 条`);
  console.log(`  配伍禁忌: ${finalStats.contraindications} 条`);
  console.log('========================================\n');
}

if (require.main === module) {
  seedData().catch(console.error);
}

module.exports = seedData;
