const { run, get, all } = require('../config/database');

class AuctionBid {
  static async create(listingId, data) {
    const { price, buyer_line, operator, source = 'manual', agent_id = null } = data;

    const result = await run(`
      INSERT INTO auction_bids (listing_id, price, buyer_line, operator, status, source, agent_id)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `, [listingId, price, buyer_line, operator, source, agent_id]);

    return result.lastID;
  }

  static async findById(id) {
    return await get(`
      SELECT ab.*, aa.priority as agent_priority
      FROM auction_bids ab
      LEFT JOIN auction_agents aa ON ab.agent_id = aa.id
      WHERE ab.id = ?
    `, [id]);
  }

  static async findByListingId(listingId) {
    return await all(`
      SELECT ab.*, aa.priority as agent_priority
      FROM auction_bids ab
      LEFT JOIN auction_agents aa ON ab.agent_id = aa.id
      WHERE ab.listing_id = ?
      ORDER BY ab.price DESC, COALESCE(aa.priority, 0) DESC, ab.created_at ASC
    `, [listingId]);
  }
}

module.exports = AuctionBid;
