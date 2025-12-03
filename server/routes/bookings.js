const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Get user's bookings (as renter)
router.get('/my-bookings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, bk.title, bk.brand, bk.model, bk.image_url, u.name as owner_name, u.phone as owner_phone
      FROM bookings b
      JOIN bikes bk ON b.bike_id = bk.id
      JOIN users u ON b.owner_id = u.id
      WHERE b.renter_id = $1
      ORDER BY b.created_at DESC
    `, [req.userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get bookings for user's bikes (as owner)
router.get('/bike-bookings', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, bk.title, bk.brand, bk.model, bk.image_url, u.name as renter_name, u.phone as renter_phone
      FROM bookings b
      JOIN bikes bk ON b.bike_id = bk.id
      JOIN users u ON b.renter_id = u.id
      WHERE b.owner_id = $1
      ORDER BY b.created_at DESC
    `, [req.userId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bike bookings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new booking
router.post('/', authMiddleware, [
  body('bike_id').isNumeric().withMessage('Valid bike ID is required'),
  body('start_date').isISO8601().withMessage('Valid start date is required'),
  body('end_date').isISO8601().withMessage('Valid end date is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bike_id, start_date, end_date } = req.body;

    // Check if bike exists and is available
    const bikeResult = await pool.query(
      'SELECT id, owner_id, price_per_day, available FROM bikes WHERE id = $1',
      [bike_id]
    );

    if (bikeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bike not found' });
    }

    const bike = bikeResult.rows[0];

    if (!bike.available) {
      return res.status(400).json({ error: 'Bike is not available' });
    }

    if (bike.owner_id === req.userId) {
      return res.status(400).json({ error: 'You cannot book your own bike' });
    }

    // Check for conflicting bookings
    const conflictResult = await pool.query(`
      SELECT id FROM bookings 
      WHERE bike_id = $1 
      AND status IN ('pending', 'confirmed')
      AND (
        (start_date <= $2 AND end_date >= $2) OR
        (start_date <= $3 AND end_date >= $3) OR
        (start_date >= $2 AND end_date <= $3)
      )
    `, [bike_id, start_date, end_date]);

    if (conflictResult.rows.length > 0) {
      return res.status(400).json({ error: 'Bike is already booked for these dates' });
    }

    // Calculate total price
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    const diffTime = Math.abs(endDate - startDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // Include both start and end dates
    const totalPrice = diffDays * parseFloat(bike.price_per_day);

    // Create booking
    const bookingResult = await pool.query(`
      INSERT INTO bookings (bike_id, renter_id, owner_id, start_date, end_date, total_price)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [bike_id, req.userId, bike.owner_id, start_date, end_date, totalPrice]);

    res.status(201).json({
      message: 'Booking created successfully',
      booking: bookingResult.rows[0]
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update booking status
router.put('/:id/status', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Check if booking exists and user has permission
    const bookingResult = await pool.query(
      'SELECT * FROM bookings WHERE id = $1',
      [id]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    // Owner can confirm/cancel, renter can cancel
    if (booking.owner_id !== req.userId && booking.renter_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized to update this booking' });
    }

    // Update booking status
    const result = await pool.query(
      'UPDATE bookings SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [status, id]
    );

    res.json({
      message: 'Booking status updated successfully',
      booking: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;