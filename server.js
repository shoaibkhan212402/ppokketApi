const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const { connectDB } = require('./config/db');
const { connectRedis } = require('./config/redis');

// Routes
const authRoutes         = require('./routes/authRoutes');
const userRoutes         = require('./routes/userRoutes');
const loanRoutes         = require('./routes/loanRoutes');
const kycRoutes          = require('./routes/kycRoutes');
const paymentRoutes      = require('./routes/paymentRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes        = require('./routes/adminRoutes');
const cibilRoutes        = require('./routes/cibilRoutes');
const aadhaarRoutes      = require('./routes/aadhaarRoutes');

const app = express();

// Trust reverse-proxy (Render, etc.) so rate-limiters see real client IPs
app.set('trust proxy', 1);

// Security
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(cors({
  origin: '*',
  credentials: false, // credentials:true + wildcard origin is rejected by browsers
}));

// Global rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Static uploads serving
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'OK', app: 'Ppokket API', version: '1.0.0' }));

// API routes
app.use('/api/auth',          authRoutes);
app.use('/api/user',          userRoutes);
app.use('/api/loan',          loanRoutes);
app.use('/api/kyc',           kycRoutes);
app.use('/api/payment',       paymentRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/cibil',         cibilRoutes);
app.use('/api/aadhaar',       aadhaarRoutes);

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  
  // Log to local file for easier debugging
  try {
    const fs = require('fs');
    const logPath = path.join(__dirname, 'errors.log');
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] ${req.method} ${req.url} - Error: ${err.message}\nStack: ${err.stack}\n\n`
    );
  } catch (logErr) {
    console.error('Failed to write to error log file:', logErr.message);
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  await connectRedis();
  app.listen(PORT, () => {

  });
});

