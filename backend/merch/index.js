import express from 'express';
import adminRoutes from './adminRoutes.js';
import publicRoutes from './publicRoutes.js';
import checkoutRoutes from './checkoutRoutes.js';
import webhookRoutes from './webhookRoutes.js';

const router = express.Router();

router.use('/drops', publicRoutes);
router.use('/admin', adminRoutes);
router.use('/checkout', checkoutRoutes);
router.use('/webhooks', webhookRoutes);

export default router;
