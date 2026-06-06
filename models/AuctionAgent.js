const { run, get, all } = require('../config/database');
const AuctionBid = require('./AuctionBid');

class AuctionAgent {
  static async create(data) {
    const { buyer_line, material_type, max_price, max_quantity_per_day, priority = 0, enabled = true } = data;

    if (!buyer_line || !material_type) {
      throw new Error('buyer_line 和 material_type 为必填项');
    }
    if (max_price <= 0) {
      throw new Error('max_price 必须大于0');
    }
    if (max_quantity_per_day <= 0) {
      throw new Error('max_quantity_per_day 必须大于0');
    }
    if (priority < 0 || priority > 100 || !Number.isInteger(priority)) {
      throw new Error('priority 必须为 0-100 的整数');
    }

    const existing = await get(`
      SELECT id FROM auction_agents WHERE buyer_line = ? AND material_type = ?
    `, [buyer_line, material_type]);
    if (existing) {
      throw new Error(`该产线(${buyer_line})对该原料类型(${material_type})已有策略，请勿重复创建`);
    }

    const result = await run(`
      INSERT INTO auction_agents (buyer_line, material_type, max_price, max_quantity_per_day, priority, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [buyer_line, material_type, max_price, max_quantity_per_day, priority, enabled ? 1 : 0]);

    return await this.findById(result.lastID);
  }

  static async findById(id) {
    return await get(`
      SELECT * FROM auction_agents WHERE id = ?
    `, [id]);
  }

  static async findAll(buyerLine = null) {
    let sql = 'SELECT * FROM auction_agents';
    const params = [];

    if (buyerLine) {
      sql += ' WHERE buyer_line = ?';
      params.push(buyerLine);
    }

    sql += ' ORDER BY priority DESC, created_at DESC';
    return await all(sql, params);
  }

  static async findEnabledByMaterialType(materialType) {
    return await all(`
      SELECT * FROM auction_agents
      WHERE material_type = ? AND enabled = 1
      ORDER BY priority DESC, created_at ASC
    `, [materialType]);
  }

  static async update(id, data) {
    const agent = await this.findById(id);
    if (!agent) {
      throw new Error('策略不存在');
    }

    const { max_price, max_quantity_per_day, priority, enabled } = data;

    const newMaxPrice = max_price !== undefined ? max_price : agent.max_price;
    const newMaxQty = max_quantity_per_day !== undefined ? max_quantity_per_day : agent.max_quantity_per_day;
    const newPriority = priority !== undefined ? priority : agent.priority;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : agent.enabled;

    if (newMaxPrice <= 0) {
      throw new Error('max_price 必须大于0');
    }
    if (newMaxQty <= 0) {
      throw new Error('max_quantity_per_day 必须大于0');
    }
    if (newPriority < 0 || newPriority > 100 || !Number.isInteger(newPriority)) {
      throw new Error('priority 必须为 0-100 的整数');
    }

    await run(`
      UPDATE auction_agents
      SET max_price = ?, max_quantity_per_day = ?, priority = ?, enabled = ?
      WHERE id = ?
    `, [newMaxPrice, newMaxQty, newPriority, newEnabled, id]);

    return await this.findById(id);
  }

  static async delete(id) {
    const agent = await this.findById(id);
    if (!agent) {
      throw new Error('策略不存在');
    }
    await run('DELETE FROM auction_agents WHERE id = ?', [id]);
    return { success: true };
  }

  static async pause(id) {
    const agent = await this.findById(id);
    if (!agent) {
      throw new Error('策略不存在');
    }
    await run('UPDATE auction_agents SET enabled = 0 WHERE id = ?', [id]);
    return await this.findById(id);
  }

  static async resume(id) {
    const agent = await this.findById(id);
    if (!agent) {
      throw new Error('策略不存在');
    }
    await run('UPDATE auction_agents SET enabled = 1 WHERE id = ?', [id]);
    return await this.findById(id);
  }

  static async getTodayUsed(agent) {
    const today = new Date().toISOString().split('T')[0];

    const tradedRow = await get(`
      SELECT COALESCE(SUM(at.quantity), 0) as traded_qty
      FROM auction_trades at
      JOIN auction_bids ab ON at.bid_id = ab.id
      WHERE ab.buyer_line = ?
        AND ab.source = 'auto'
        AND DATE(at.traded_at) = ?
        AND EXISTS (
          SELECT 1 FROM auction_listings al
          JOIN material_batches mb ON al.batch_id = mb.id
          WHERE al.id = at.listing_id AND mb.material_type = ?
        )
    `, [agent.buyer_line, today, agent.material_type]);

    const pendingRow = await get(`
      SELECT COALESCE(SUM(al.quantity), 0) as pending_qty
      FROM auction_bids ab
      JOIN auction_listings al ON ab.listing_id = al.id
      JOIN material_batches mb ON al.batch_id = mb.id
      WHERE ab.buyer_line = ?
        AND ab.source = 'auto'
        AND ab.status = 'pending'
        AND mb.material_type = ?
        AND DATE(ab.created_at) = ?
    `, [agent.buyer_line, agent.material_type, today]);

    return (tradedRow?.traded_qty || 0) + (pendingRow?.pending_qty || 0);
  }

  static async getQuota(id) {
    const agent = await this.findById(id);
    if (!agent) {
      throw new Error('策略不存在');
    }
    const todayUsed = await this.getTodayUsed(agent);
    return {
      today_used: todayUsed,
      max_per_day: agent.max_quantity_per_day,
      remaining: Math.max(0, agent.max_quantity_per_day - todayUsed)
    };
  }

  static async processAutoBidsForListing(listing) {
    const agents = await this.findEnabledByMaterialType(listing.material_type);
    const autoBids = [];

    for (const agent of agents) {
      if (agent.buyer_line === listing.seller_line) {
        continue;
      }
      if (agent.max_price < listing.min_price) {
        continue;
      }

      const todayUsed = await this.getTodayUsed(agent);
      if (todayUsed + listing.quantity > agent.max_quantity_per_day) {
        continue;
      }

      const rawPrice = Math.min(agent.max_price, listing.min_price * 1.05);
      const price = Math.ceil(rawPrice * 100) / 100;

      const bidId = await AuctionBid.create(listing.id, {
        price,
        buyer_line: agent.buyer_line,
        operator: 'auto-bidder',
        source: 'auto',
        agent_id: agent.id
      });

      const bid = await AuctionBid.findById(bidId);
      autoBids.push(bid);
    }

    return autoBids;
  }

  static async seedDefaults() {
    const defaults = [
      {
        buyer_line: '二号线',
        material_type: '环氧树脂A',
        max_price: 48,
        max_quantity_per_day: 500,
        priority: 80,
        enabled: true
      },
      {
        buyer_line: '三号线',
        material_type: '固化剂B',
        max_price: 42,
        max_quantity_per_day: 300,
        priority: 60,
        enabled: true
      }
    ];

    for (const data of defaults) {
      const existing = await get(`
        SELECT id FROM auction_agents WHERE buyer_line = ? AND material_type = ?
      `, [data.buyer_line, data.material_type]);
      if (!existing) {
        await this.create(data);
        console.log(`  已预置竞价策略: ${data.buyer_line} - ${data.material_type}`);
      }
    }
  }
}

module.exports = AuctionAgent;
