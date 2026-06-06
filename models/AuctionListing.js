const { run, get, all, beginTransaction, commit, rollback } = require('../config/database');
const MaterialBatch = require('./MaterialBatch');
const MaterialLock = require('./MaterialLock');
const Reservation = require('./Reservation');
const Transfer = require('./Transfer');
const AuctionBid = require('./AuctionBid');
const AuctionTrade = require('./AuctionTrade');

class AuctionListing {
  static async getOpenListingQuantity(batchId) {
    const row = await get(`
      SELECT SUM(quantity) as total_listed
      FROM auction_listings
      WHERE batch_id = ? AND status = 'open'
    `, [batchId]);
    return row?.total_listed || 0;
  }

  static async getAvailableQuantity(batchId) {
    const batch = await get('SELECT remaining_quantity FROM material_batches WHERE id = ?', [batchId]);
    if (!batch) return 0;

    const reservedMap = await Reservation.getReservedQuantityMap([batchId]);
    const reservedQuantity = reservedMap[batchId] || 0;
    const pendingTransferQuantity = await Transfer.getPendingTransferQuantity(batchId);
    const openListingQuantity = await this.getOpenListingQuantity(batchId);

    return Math.max(0, batch.remaining_quantity - reservedQuantity - pendingTransferQuantity - openListingQuantity);
  }

  static async create(data) {
    const { batch_id, quantity, min_price, expires_days, seller_line, reason } = data;

    const batch = await MaterialBatch.findById(batch_id);
    if (!batch) {
      throw new Error('批次不存在');
    }

    if (batch.expiry_date < new Date().toISOString().split('T')[0]) {
      throw new Error('批次已过期，不能挂单');
    }

    if (batch.lock_status?.is_locked) {
      throw new Error('批次已锁定，不能挂单');
    }

    const availableQuantity = await this.getAvailableQuantity(batch_id);
    if (availableQuantity < quantity) {
      throw new Error(`可用量不足，当前可用（含已挂单预占）: ${availableQuantity}kg`);
    }

    if (quantity <= 0) {
      throw new Error('挂单数量必须大于0');
    }

    if (min_price <= 0) {
      throw new Error('底价必须大于0');
    }

    if (expires_days <= 0 || !Number.isInteger(expires_days)) {
      throw new Error('过期天数必须为正整数');
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expires_days);

    const result = await run(`
      INSERT INTO auction_listings (batch_id, quantity, min_price, seller_line, reason, status, expires_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `, [batch_id, quantity, min_price, seller_line, reason || null, expiresAt.toISOString()]);

    return await this.findById(result.lastID);
  }

  static async findById(id) {
    const listing = await get(`
      SELECT al.*,
             mb.batch_number,
             mb.material_type,
             mb.remaining_quantity as batch_remaining,
             mb.expiry_date as batch_expiry,
             mb.unit_price as batch_unit_price
      FROM auction_listings al
      JOIN material_batches mb ON al.batch_id = mb.id
      WHERE al.id = ?
    `, [id]);

    if (listing) {
      listing.bids = await AuctionBid.findByListingId(listing.id);
    }

    return listing;
  }

  static async findAllOpen(materialType = null) {
    let sql = `
      SELECT al.*,
             mb.batch_number,
             mb.material_type,
             mb.remaining_quantity as batch_remaining,
             mb.expiry_date as batch_expiry,
             mb.unit_price as batch_unit_price
      FROM auction_listings al
      JOIN material_batches mb ON al.batch_id = mb.id
      WHERE al.status = 'open'
    `;
    const params = [];

    if (materialType) {
      sql += ' AND mb.material_type = ?';
      params.push(materialType);
    }

    sql += ' ORDER BY al.created_at DESC';

    const listings = await all(sql, params);

    for (const listing of listings) {
      listing.bids = await AuctionBid.findByListingId(listing.id);
    }

    return listings;
  }

  static async placeBid(listingId, data) {
    const { price, buyer_line, operator } = data;

    const listing = await this.findById(listingId);
    if (!listing) {
      throw new Error('挂单不存在');
    }

    if (listing.status !== 'open') {
      throw new Error('该挂单已结束，不能出价');
    }

    if (price < listing.min_price) {
      throw new Error(`出价不能低于底价 ${listing.min_price} 元`);
    }

    if (!buyer_line) {
      throw new Error('请填写买方产线');
    }

    if (!operator) {
      throw new Error('请填写操作人');
    }

    if (buyer_line === listing.seller_line) {
      throw new Error('买方产线不能与卖方产线相同');
    }

    const bidId = await AuctionBid.create(listingId, { price, buyer_line, operator });
    return await AuctionBid.findById(bidId);
  }

  static async acceptBid(listingId, bidId, approver = 'system') {
    const listing = await this.findById(listingId);
    if (!listing) {
      throw new Error('挂单不存在');
    }

    if (listing.status !== 'open') {
      throw new Error('该挂单已结束');
    }

    const bid = await AuctionBid.findById(bidId);
    if (!bid) {
      throw new Error('出价不存在');
    }

    if (Number(bid.listing_id) !== Number(listingId)) {
      throw new Error('出价与挂单不匹配');
    }

    if (bid.status !== 'pending') {
      throw new Error('该出价已处理');
    }

    const sourceBatch = await MaterialBatch.findById(listing.batch_id);
    if (!sourceBatch) {
      throw new Error('源批次不存在');
    }

    await beginTransaction();
    try {
      const availableQuantity = await this.getAvailableQuantity(listing.batch_id);
      if (availableQuantity < listing.quantity) {
        throw new Error(`源批次可用量不足(已扣除预占/调拨/挂单预占): 当前可用${availableQuantity}kg，需要${listing.quantity}kg`);
      }
      await run(`
        UPDATE auction_listings SET status = 'sold' WHERE id = ?
      `, [listingId]);

      await run(`
        UPDATE auction_bids SET status = 'accepted' WHERE id = ?
      `, [bidId]);

      await run(`
        UPDATE auction_bids SET status = 'rejected' WHERE listing_id = ? AND id != ? AND status = 'pending'
      `, [listingId, bidId]);

      const cancelledReservations = await Reservation.cancelByBatchId(
        listing.batch_id,
        approver
      );

      const transfer = await Transfer._createInternal({
        source_batch_id: listing.batch_id,
        quantity: listing.quantity,
        destination_line: bid.buyer_line,
        operator: bid.operator,
        reason: `拍卖成交: 挂单#${listingId} / 出价#${bidId}`,
        status: 'approved',
        sourceBatch
      });

      const tradeId = await AuctionTrade.create({
        listing_id: listingId,
        bid_id: bidId,
        batch_id: listing.batch_id,
        quantity: listing.quantity,
        price: bid.price,
        seller_line: listing.seller_line,
        buyer_line: bid.buyer_line
      });

      await commit();

      return {
        listing: await this.findById(listingId),
        accepted_bid: await AuctionBid.findById(bidId),
        trade: await AuctionTrade.findById(tradeId),
        transfer,
        cancelled_reservation_count: cancelledReservations.cancelled_count,
        cancelled_plan_ids: cancelledReservations.plans
      };
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  static async expireListings() {
    const expired = await all(`
      SELECT id FROM auction_listings
      WHERE status = 'open' AND expires_at < datetime('now')
    `);

    if (expired.length === 0) return { expired_count: 0 };

    const listingIds = expired.map(r => r.id);
    const placeholders = listingIds.map(() => '?').join(', ');

    await beginTransaction();
    try {
      const result = await run(`
        UPDATE auction_listings SET status = 'expired'
        WHERE status = 'open' AND expires_at < datetime('now')
      `);

      await run(`
        UPDATE auction_bids SET status = 'rejected'
        WHERE listing_id IN (${placeholders}) AND status = 'pending'
      `, listingIds);

      await commit();

      return {
        expired_count: result.changes,
        expired_listing_ids: listingIds
      };
    } catch (err) {
      await rollback();
      throw err;
    }
  }
}

module.exports = AuctionListing;
