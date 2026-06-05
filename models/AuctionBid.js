const { run, get, all } = require('../config/database');

class AuctionBid {
  static async create(listingId, data) {
    const { price, buyer_line, operator } = data;

    const result = await run(`
      INSERT INTO auction_bids (listing_id, price, buyer_line, operator, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [listingId, price, buyer_line, operator]);

    return result.lastID;
  }

  static async findById(id) {
    return await get(`
      SELECT * FROM auction_bids WHERE id = ?
    `, [id]);
  }

  static async findByListingId(listingId) {
    return await all(`
      SELECT * FROM auction_bids
      WHERE listing_id = ?
      ORDER BY price DESC, created_at ASC
    `, [listingId]);
  }
}

module.exports = AuctionBid;
