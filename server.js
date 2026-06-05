const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const initDatabase = require('./scripts/initDB');
const seedData = require('./scripts/seedData');
const Reservation = require('./models/Reservation');
const { EnvProcessWindow } = require('./models/EnvMonitor');
const AuctionListing = require('./models/AuctionListing');
const AuctionAgent = require('./models/AuctionAgent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

async function startServer() {
  await initDatabase();
  console.log('数据库初始化完成');

  await seedData();
  console.log('演示数据加载完成');

  await EnvProcessWindow.initializeDefaults();
  console.log('工艺窗口配置初始化完成');

  await AuctionAgent.seedDefaults();
  console.log('竞价代理策略初始化完成');

  app.get('/api/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      service: '工业配方批次追溯与动态替代服务',
      timestamp: new Date().toISOString()
    });
  });

  app.use('/api/formulas', require('./routes/formulas'));
  app.use('/api/materials', require('./routes/materials'));
  app.use('/api/batches', require('./routes/batches'));
  app.use('/api/trace', require('./routes/trace'));
  app.use('/api/qc', require('./routes/qc'));
  app.use('/api/incoming', require('./routes/incoming'));
  app.use('/api/suppliers', require('./routes/suppliers'));
  app.use('/api/contraindications', require('./routes/contraindications'));
  app.use('/api/env', require('./routes/env'));
  app.use('/api/transfers', require('./routes/transfers'));
  app.use('/api/shelf-life', require('./routes/shelf-life'));
  app.use('/api/compatibility', require('./routes/compatibility'));
  app.use('/api/auction', require('./routes/auction'));

  app.use((req, res) => {
    res.status(404).json({ error: '接口不存在' });
  });

  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: '服务器内部错误' });
  });

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  工业配方批次追溯服务已启动`);
    console.log(`  服务地址: http://localhost:${PORT}`);
    console.log(`  健康检查: http://localhost:${PORT}/api/health`);
    console.log(`========================================\n`);
    console.log(`可用API接口:`);
    console.log(`  GET    /api/formulas                 - 获取所有配方`);
    console.log(`  POST   /api/formulas                 - 创建配方`);
    console.log(`  GET    /api/materials/batches        - 获取所有原料批次`);
  console.log(`  POST   /api/materials/batches        - 录入原料批次`);
  console.log(`  POST   /api/batches/plan             - 计算投料方案`);
    console.log(`  POST   /api/batches/execute          - 执行投料方案`);
    console.log(`  GET    /api/batches/reservations     - 查询活跃预占列表`);
    console.log(`  DELETE /api/batches/reservations/:planId - 取消方案预占`);
    console.log(`  GET    /api/trace/forward/:id        - 正向追溯（原料→成品）`);
  console.log(`  GET    /api/trace/backward/:id       - 反向追溯（成品→原料）`);
  console.log(`  POST   /api/qc/inspect               - 成品质检录入（不合格时自动触发回溯分析）`);
    console.log(`  GET    /api/qc/retroanalyze/:id      - 回溯分析某成品批次`);
    console.log(`  GET    /api/qc/retroanalyze/stats    - 回溯分析统计`);
    console.log(`  GET    /api/qc/reports               - 查询质检报告`);
  console.log(`  GET    /api/qc/dispositions          - 查询处置工单`);
  console.log(`  POST   /api/qc/dispositions/:id/approve - 审批处置工单`);
  console.log(`  POST   /api/qc/dispositions/:id/reject  - 驳回处置工单`);
  console.log(`  GET    /api/qc/rules                 - 查询处置规则`);
  console.log(`  POST   /api/qc/rules                 - 创建处置规则`);
  console.log(`  GET    /api/qc/stats                 - 质检统计数据`);
  console.log(`  POST   /api/materials/batches/:id/unlock - 解锁原料批次`);
  console.log(`  POST   /api/incoming/inspect         - 来料检验`);
  console.log(`  GET    /api/incoming/reports          - 查询来料检验报告`);
  console.log(`  GET    /api/incoming/stats            - 来料检验统计`);
  console.log(`  GET    /api/suppliers/scores          - 供应商评分列表`);
    console.log(`  GET    /api/suppliers/strict-params   - 加严检验参数配置`);
    console.log(`  POST   /api/suppliers/strict-params   - 配置加严检验参数`);
    console.log(`  GET    /api/contraindications         - 获取配伍禁忌列表(支持?level=过滤)`);
    console.log(`  POST   /api/contraindications         - 创建配伍禁忌记录`);
    console.log(`  DELETE /api/contraindications/:id     - 删除配伍禁忌记录`);
    console.log(`  POST   /api/contraindications/simulate - 配伍模拟检查`);
    console.log(`  POST   /api/env/readings              - 批量上报环境数据`);
    console.log(`  GET    /api/env/readings              - 查询环境数据(需传product_batch)`);
    console.log(`  GET    /api/env/process-window        - 获取工艺窗口配置`);
    console.log(`  PUT    /api/env/process-window/:param - 修改某参数工艺窗口`);
    console.log(`  GET    /api/env/deviations            - 查询环境偏差事件(需传product_batch)`);
    console.log(`  POST   /api/transfers                 - 创建调拨记录`);
    console.log(`  GET    /api/transfers                 - 查询调拨列表(支持?status=过滤)`);
    console.log(`  GET    /api/transfers/stats           - 调拨统计`);
    console.log(`  GET    /api/transfers/:id             - 查询调拨详情`);
    console.log(`  POST   /api/transfers/:id/approve     - 审批调拨`);
    console.log(`  POST   /api/transfers/:id/reject      - 驳回调拨`);
    console.log(`  GET    /api/transfers/:batchId/history - 批次调拨链路`);
    console.log(`  GET    /api/transfers/batch/:id/available - 批次可用量查询`);
    console.log(`  GET    /api/shelf-life/rules          - 获取保质期衰减规则列表`);
    console.log(`  POST   /api/shelf-life/rules          - 配置保质期衰减规则`);
    console.log(`  GET    /api/shelf-life/assess         - 评估所有在库批次`);
    console.log(`  GET    /api/shelf-life/assess/:batchId - 评估指定批次`);
    console.log(`  POST   /api/shelf-life/schedule       - 生成消耗排程`);
    console.log(`  GET    /api/shelf-life/alerts         - 获取浪费预警列表`);
    console.log(`  POST   /api/compatibility/records     - 录入批次兼容性记录`);
    console.log(`  GET    /api/compatibility/records     - 查询兼容性记录(支持?batch_id=过滤)`);
    console.log(`  GET    /api/compatibility/matrix      - 获取某类型批次兼容性矩阵(含推断值)`);
    console.log(`  POST   /api/compatibility/predict     - 预测多批次混合兼容性`);
    console.log(`  GET    /api/compatibility/pair/:a/:b  - 查询两个批次的兼容性`);
    console.log(`  POST   /api/auction/listings          - 创建拍卖挂单`);
    console.log(`  GET    /api/auction/listings          - 查询所有open挂单(支持?material_type=过滤)`);
    console.log(`  GET    /api/auction/listings/:id      - 查询挂单详情`);
    console.log(`  POST   /api/auction/listings/:id/bid  - 对挂单出价摘单`);
    console.log(`  POST   /api/auction/listings/:id/accept - 接受某个出价(成交)`);
    console.log(`  GET    /api/auction/trades            - 查询所有交易记录`);
    console.log(`  GET    /api/auction/trades/stats      - 交易统计数据`);
    console.log(`  POST   /api/auction/agents            - 创建竞价代理策略`);
    console.log(`  GET    /api/auction/agents            - 查询所有策略(支持?buyer_line=过滤)`);
    console.log(`  GET    /api/auction/agents/:id        - 查询策略详情`);
    console.log(`  PUT    /api/auction/agents/:id        - 修改策略`);
    console.log(`  DELETE /api/auction/agents/:id        - 删除策略`);
    console.log(`  POST   /api/auction/agents/:id/pause  - 暂停策略`);
    console.log(`  POST   /api/auction/agents/:id/resume - 恢复策略`);
    console.log(`  GET    /api/auction/agents/:id/quota  - 查询今日限额使用情况`);
    console.log(`\n快速测试命令:`);
    console.log(`  curl -X POST http://localhost:${PORT}/api/batches/plan \\\n    -H "Content-Type: application/json" \\\n    -d '{"formula_id":1,"planned_quantity":500}'`);
    console.log();

    const reservationCleaner = setInterval(async () => {
      try {
        const result = await Reservation.expireReservations();
        if (result.expired_count > 0) {
          console.log(`[预占清理器] 已过期${result.expired_count}条预占记录，涉及方案: ${result.plans_expired.join(', ') || '无'}`);
        }
      } catch (err) {
        console.error('[预占清理器] 清理失败:', err.message);
      }
    }, 60 * 1000);

    const auctionCleaner = setInterval(async () => {
      try {
        const result = await AuctionListing.expireListings();
        if (result.expired_count > 0) {
          console.log(`[拍卖清理器] 已过期${result.expired_count}条挂单，挂单ID: ${result.expired_listing_ids.join(', ') || '无'}`);
        }
      } catch (err) {
        console.error('[拍卖清理器] 清理失败:', err.message);
      }
    }, 60 * 1000);

    process.on('SIGTERM', () => {
      clearInterval(reservationCleaner);
      clearInterval(auctionCleaner);
    });
    process.on('SIGINT', () => {
      clearInterval(reservationCleaner);
      clearInterval(auctionCleaner);
    });
  });
}

startServer().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
