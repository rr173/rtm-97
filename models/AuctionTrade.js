const { run, get, all } = require('../config/database');

class AuctionTrade {
  static async generateTradeNumber() {
    const timestamp = Math.floor(Date.now() / 1000);
    const row = await get(`
      SELECT COUNT(*) as count FROM auction_trades
      WHERE trade_number LIKE ?
    `, [`TRD-${timestamp}-%`]);
    const seq = (row?.count || 0) + 1;
    return `TRD-${timestamp}-${seq}`;
  }

  static async create(data) {
    const { listing_id, bid_id, batch_id, quantity, price, seller_line, buyer_line } = data;

    const tradeNumber = await this.generateTradeNumber();

    const result = await run(`
      INSERT INTO auction_trades (
        listing_id, bid_id, batch_id, quantity, price,
        seller_line, buyer_line, trade_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [listing_id, bid_id, batch_id, quantity, price, seller_line, buyer_line, tradeNumber]);

    return result.lastID;
  }

  static async findById(id) {
    return await get(`
      SELECT at.*,
             mb.batch_number,
             mb.material_type
      FROM auction_trades at
      JOIN material_batches mb ON at.batch_id = mb.id
      WHERE at.id = ?
    `, [id]);
  }

  static async findAll() {
    return await all(`
      SELECT at.*,
             mb.batch_number,
             mb.material_type
      FROM auction_trades at
      JOIN material_batches mb ON at.batch_id = mb.id
      ORDER BY at.traded_at DESC
    `);
  }

  static async getStats() {
    const totalRow = await get('SELECT COUNT(*) as total_trades FROM auction_trades');
    const totalQuantityRow = await get('SELECT SUM(quantity) as total_quantity FROM auction_trades');
    const totalAmountRow = await get('SELECT SUM(quantity * price) as total_amount FROM auction_trades');

    const byLine = await all(`
      SELECT line, SUM(buy_qty) as buy_quantity, SUM(buy_amt) as buy_amount,
             SUM(sell_qty) as sell_quantity, SUM(sell_amt) as sell_amount
      FROM (
        SELECT buyer_line as line,
               quantity as buy_qty, quantity * price as buy_amt,
               0 as sell_qty, 0 as sell_amt
        FROM auction_trades
        UNION ALL
        SELECT seller_line as line,
               0 as buy_qty, 0 as buy_amt,
               quantity as sell_qty, quantity * price as sell_amt
        FROM auction_trades
      )
      GROUP BY line
      ORDER BY line
    `);

    const lineSummary = {};
    byLine.forEach(row => {
      lineSummary[row.line] = {
        buy_quantity: row.buy_quantity || 0,
        buy_amount: row.buy_amount || 0,
        sell_quantity: row.sell_quantity || 0,
        sell_amount: row.sell_amount || 0
      };
    });

    return {
      total_trades: totalRow?.total_trades || 0,
      total_quantity: totalQuantityRow?.total_quantity || 0,
      total_amount: totalAmountRow?.total_amount || 0,
      by_line: lineSummary
    };
  }
}

module.exports = AuctionTrade;
