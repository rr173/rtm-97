const express = require('express');
const router = express.Router();
const AuctionListing = require('../models/AuctionListing');
const AuctionTrade = require('../models/AuctionTrade');
const AuctionAgent = require('../models/AuctionAgent');

router.post('/listings', async (req, res) => {
  try {
    const { batch_id, quantity, min_price, expires_days, seller_line, reason } = req.body;

    if (!batch_id || !quantity || !min_price || !expires_days || !seller_line) {
      return res.status(400).json({
        error: '缺少必要参数: batch_id, quantity, min_price, expires_days, seller_line'
      });
    }

    const listing = await AuctionListing.create({
      batch_id,
      quantity,
      min_price,
      expires_days,
      seller_line,
      reason
    });

    const autoBids = await AuctionAgent.processAutoBidsForListing(listing);

    const updatedListing = await AuctionListing.findById(listing.id);

    res.json({
      success: true,
      listing: updatedListing,
      auto_bids_generated: autoBids.length,
      auto_bids: autoBids
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/listings', async (req, res) => {
  try {
    const { material_type } = req.query;
    const listings = await AuctionListing.findAllOpen(material_type);

    res.json({
      success: true,
      listings
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/listings/:id', async (req, res) => {
  try {
    const listing = await AuctionListing.findById(req.params.id);

    if (!listing) {
      return res.status(404).json({ error: '挂单不存在' });
    }

    res.json({
      success: true,
      listing
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/listings/:id/bid', async (req, res) => {
  try {
    const { price, buyer_line, operator } = req.body;

    if (!price || !buyer_line || !operator) {
      return res.status(400).json({
        error: '缺少必要参数: price, buyer_line, operator'
      });
    }

    if (price <= 0) {
      return res.status(400).json({ error: '出价必须大于0' });
    }

    const bid = await AuctionListing.placeBid(req.params.id, {
      price,
      buyer_line,
      operator
    });

    res.json({
      success: true,
      bid
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/listings/:id/accept', async (req, res) => {
  try {
    const { bid_id } = req.body;

    if (!bid_id) {
      return res.status(400).json({ error: '缺少必要参数: bid_id' });
    }

    const result = await AuctionListing.acceptBid(req.params.id, bid_id);

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/trades', async (req, res) => {
  try {
    const trades = await AuctionTrade.findAll();

    res.json({
      success: true,
      trades
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/trades/stats', async (req, res) => {
  try {
    const stats = await AuctionTrade.getStats();

    res.json({
      success: true,
      ...stats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/agents', async (req, res) => {
  try {
    const { buyer_line, material_type, max_price, max_quantity_per_day, priority = 0, enabled = true } = req.body;

    if (!buyer_line || !material_type || max_price === undefined || max_quantity_per_day === undefined) {
      return res.status(400).json({
        error: '缺少必要参数: buyer_line, material_type, max_price, max_quantity_per_day'
      });
    }

    const agent = await AuctionAgent.create({
      buyer_line,
      material_type,
      max_price,
      max_quantity_per_day,
      priority,
      enabled
    });

    res.json({
      success: true,
      agent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const { buyer_line } = req.query;
    const agents = await AuctionAgent.findAll(buyer_line);

    res.json({
      success: true,
      agents
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/agents/:id', async (req, res) => {
  try {
    const agent = await AuctionAgent.findById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: '策略不存在' });
    }

    res.json({
      success: true,
      agent
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/agents/:id', async (req, res) => {
  try {
    const agent = await AuctionAgent.update(req.params.id, req.body);

    res.json({
      success: true,
      agent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/agents/:id', async (req, res) => {
  try {
    await AuctionAgent.delete(req.params.id);

    res.json({
      success: true
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/agents/:id/pause', async (req, res) => {
  try {
    const agent = await AuctionAgent.pause(req.params.id);

    res.json({
      success: true,
      agent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/agents/:id/resume', async (req, res) => {
  try {
    const agent = await AuctionAgent.resume(req.params.id);

    res.json({
      success: true,
      agent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/agents/:id/quota', async (req, res) => {
  try {
    const quota = await AuctionAgent.getQuota(req.params.id);

    res.json({
      success: true,
      ...quota
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
