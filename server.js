require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_2026';

const preferencesService = require('./services/preferences.service');
const chatSessionService = require('./services/chatSession.service');
const personalityService = require('./services/personality.service');
const mixpanelService = require('./services/mixpanel.service');
const emailService = require('./services/email.service');
const otpService = require('./services/otp.service');

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : (dbState === 2 ? 'connecting' : 'disconnected');
  res.status(200).json({
    status: 'ok',
    database: dbStatus,
    uptime: process.uptime()
  });
});

// Admin Login Page Route (GET /admin)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-views', 'admin-login.html'));
});

// Alias /admin/login to /admin
app.get('/admin/login', (req, res) => {
  res.redirect('/admin');
});

// Admin Dashboard Route (Protected)
app.get('/admin/dashboard', authenticateAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-views', 'admin-affiliate.html'));
});

// Admin Affiliate Private Page Route (Protected alias)
app.get('/admin/affiliates', authenticateAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-views', 'admin-affiliate.html'));
});

// Admin Logout Route
app.get('/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.setHeader('Set-Cookie', 'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.redirect('/admin');
});

// STATIC ASSETS MIDDLEWARE (After dynamic HTML routes)
app.use(express.static(path.join(__dirname, 'public')));
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}
const CHAT_IMAGES_DIR = path.join(UPLOADS_DIR, 'chat-images');
if (!fs.existsSync(CHAT_IMAGES_DIR)) {
  fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });
}

function validateImageBase64(imageBase64, mimeType) {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedMimeTypes.includes(mimeType)) {
    return { valid: false, error: 'Please choose a JPG, PNG, or WEBP image.' };
  }

  let base64Data = imageBase64;
  if (imageBase64.includes(';base64,')) {
    base64Data = imageBase64.split(';base64,')[1];
  }

  const buffer = Buffer.from(base64Data, 'base64');

  if (buffer.length > 10 * 1024 * 1024) {
    return { valid: false, error: 'That image is too large. Please choose an image under 10 MB.' };
  }

  const hex = buffer.toString('hex', 0, 4);
  let detectedType = null;
  if (hex.startsWith('ffd8ff')) {
    detectedType = 'image/jpeg';
  } else if (hex.startsWith('89504e47')) {
    detectedType = 'image/png';
  } else if (buffer.toString('utf8', 0, 4) === 'RIFF' && buffer.toString('utf8', 8, 12) === 'WEBP') {
    detectedType = 'image/webp';
  }

  if (!detectedType || detectedType !== mimeType) {
    return { valid: false, error: 'Please choose a JPG, PNG, or WEBP image.' };
  }

  return { valid: true, buffer, detectedType };
}

// -------------------------------------------------------------
// MongoDB & Mongoose Schema Setup
// -------------------------------------------------------------

const cloudMongoUri = process.env.MONGO_URI;
const localMongoUri = 'mongodb://127.0.0.1:27017/donotbesolo';

console.log('Attempting connection to Cloud MongoDB...');
mongoose.connect(cloudMongoUri)
  .then(async () => {
    console.log('Connected to MongoDB Cloud Database.');
    seedPromoCodes();
    seedStorePackages();
    await migrateLegacyPasswords();
    seedAdminUser();
  })
  .catch(err => {
    console.error('MongoDB Cloud connection authentication/network failure. Trying local MongoDB...');
    mongoose.disconnect().then(() => {
      mongoose.connect(localMongoUri)
        .then(async () => {
          console.log('Connected successfully to local MongoDB instance (mongodb://127.0.0.1:27017/donotbesolo).');
          seedPromoCodes();
          seedStorePackages();
          await migrateLegacyPasswords();
          seedAdminUser();
        })
        .catch(localErr => {
          console.error('All MongoDB connection options failed. Database services are offline.', localErr.message);
        });
    });
  });

// 1. User Schema
const userSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  username: { type: String, required: true, unique: true },
  email: { type: String, sparse: true, unique: true },
  passwordHash: { type: String },
  phone: { type: String, sparse: true, unique: true },
  emailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },
  role: { type: String, default: 'user' },
  referredByPartnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', default: null },
  credits: { type: Number, default: 20 },
  coins: { type: Number, default: 20 },
  referredBy: { type: String, default: null },
  paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
  isSubscriptionActive: { type: Boolean, default: false },
  subscription: {
    active: { type: Boolean, default: false },
    plan: { type: String, default: null },
    startedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null }
  },
  passwordResetToken: { type: String, default: null },
  passwordResetExpires: { type: Date, default: null },
  chatCount: { type: Number, default: 0 },
  teasingStatus: { type: String, default: 'none' },
  teaseLinesCount: { type: Number, default: 0 },
  activeCompanionName: { type: String, default: 'Aria' },
  activeCompanion: { type: String, default: 'Aria' },
  activeVibe: { type: String, default: 'Flirty' },
  activeLanguage: { type: String, default: 'English' },
  relationshipStage: { type: Number, default: 1 },
  memories: { type: Array, default: [] },
  selectedCompanion: { type: String, default: 'Aria' },
  selectedLanguage: { type: String, default: 'English' },
  selectedVibe: { type: String, default: 'Flirty' },
  relationshipLevel: { type: Number, default: 1.0 },
  importantMemories: [{ type: String }],
  conversationSummary: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 1.1 Memory Schema
const memorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  companionName: { type: String, required: true },
  summary: { type: String, default: "" },
  pinnedMemories: [{ type: String }],
  relationshipLevel: { type: Number, default: 1.0 },
  importantFacts: [{ type: String }],
  lastActiveTime: { type: Date, default: Date.now },
  conversationCount: { type: Number, default: 0 },
  totalMessages: { type: Number, default: 0 },
  preferredLanguage: { type: String, default: "English" },
  currentMood: { type: String, default: "" },
  nickname: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now }
});
memorySchema.index({ userId: 1, companionName: 1 }, { unique: true });
const Memory = mongoose.model('Memory', memorySchema);

// 1.25 Pending User Schema
const pendingUserSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  referredBy: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  lastResentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});
const PendingUser = mongoose.model('PendingUser', pendingUserSchema);

// Phone OTP Schema
const phoneOtpSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true }
});
const PhoneOtp = mongoose.model('PhoneOtp', phoneOtpSchema);

// 1.5. Conversation Schema
const conversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  companionName: { type: String, required: true },
  vibe: { type: String, required: true },
  language: { type: String, required: true },
  relationshipLevel: { type: Number, default: 1.0 },
  memories: [{ type: String }],
  summary: { type: String, default: "" },
  history: [
    {
      role: { type: String, enum: ['user', 'assistant'], required: true },
      content: { type: String, default: "" },
      imageUrl: { type: String, default: null },
      timestamp: { type: Date, default: Date.now },
      lockedMedia: {
        mediaId: { type: String },
        mediaType: { type: String, enum: ['image', 'voice'] },
        coins: { type: Number }
      }
    }
  ],
  updatedAt: { type: Date, default: Date.now }
});
conversationSchema.index({ userId: 1, companionName: 1 }, { unique: true });
const Conversation = mongoose.model('Conversation', conversationSchema);

// 2. OTP Schema
const otpSchema = new mongoose.Schema({
  email: { type: String, required: true },
  otpCode: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});
const OTP = mongoose.model('OTP', otpSchema);

// 3. Traffic Log Schema
const trafficLogSchema = new mongoose.Schema({
  refCode: { type: String, required: true },
  ip: { type: String },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sessionId: { type: String, default: null },
  timestamp: { type: Date, default: Date.now }
});
const TrafficLog = mongoose.model('TrafficLog', trafficLogSchema);

// 4. Transaction Schema
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  refCode: { type: String, default: null },
  amount: { type: Number, required: true },
  type: { type: String, enum: ['subscription', 'coins', 'chat_deduction', 'media_unlock', 'image_generation', 'voice_note_generation'], required: true },
  coins: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  timestamp: { type: Date, default: Date.now },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', default: null },
  affiliateCommissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateConversion', default: null },
  originalAmount: { type: Number, default: 0 },
  discountAmount: { type: Number, default: 0 },
  commissionAmount: { type: Number, default: 0 }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// 5. Media Schema
const mediaSchema = new mongoose.Schema({
  mediaId: { type: String, required: true, unique: true },
  mediaType: { type: String, enum: ['image', 'voice'], required: true },
  filePath: { type: String, required: true },
  isLocked: { type: Boolean, default: true },
  unlockedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
mediaSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
const Media = mongoose.model('Media', mediaSchema);

// 6. PromoCode Schema
const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  discount: { type: Number, required: true },
  isActive: { type: Boolean, default: true },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', default: null },
  commissionPercent: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const PromoCode = mongoose.model('PromoCode', promoCodeSchema);

// 7. AffiliatePartner Schema
const affiliatePartnerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  instagramUsername: { type: String, required: true, unique: true },
  instagramUrl: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, default: null },
  commissionPercent: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ['active', 'paused', 'terminated'], default: 'active' },
  notes: { type: String, default: "" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  totalClicks: { type: Number, default: 0 },
  totalCodeUses: { type: Number, default: 0 },
  uniqueUsers: { type: Number, default: 0 },
  totalSuccessfulPurchases: { type: Number, default: 0 },
  totalRevenue: { type: Number, default: 0 },
  totalCommissionEarned: { type: Number, default: 0 },
  totalCommissionPaid: { type: Number, default: 0 },
  totalCommissionPending: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
const AffiliatePartner = mongoose.model('AffiliatePartner', affiliatePartnerSchema);

// 8. AffiliateCodeUse Schema
const affiliateCodeUseSchema = new mongoose.Schema({
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', required: true },
  promoCode: { type: String, required: true },
  customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now }
});
const AffiliateCodeUse = mongoose.model('AffiliateCodeUse', affiliateCodeUseSchema);

// 9. AffiliateConversion Schema
const affiliateConversionSchema = new mongoose.Schema({
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', required: true },
  promoCode: { type: String, required: true },
  customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true, unique: true },
  paymentId: { type: String, default: null },
  originalAmount: { type: Number, required: true },
  discountAmount: { type: Number, required: true },
  amountPaid: { type: Number, required: true },
  commissionPercent: { type: Number, required: true },
  commissionAmount: { type: Number, required: true },
  status: { type: String, enum: ['earned', 'pending', 'paid', 'reversed'], default: 'earned' },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date, default: null },
  reversedAt: { type: Date, default: null },
  reversalReason: { type: String, default: null }
});
const AffiliateConversion = mongoose.model('AffiliateConversion', affiliateConversionSchema);

// 10. AffiliatePayout Schema
const affiliatePayoutSchema = new mongoose.Schema({
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliatePartner', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' },
  paymentMethod: { type: String, default: null },
  paymentReference: { type: String, default: null },
  notes: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date, default: null }
});
const AffiliatePayout = mongoose.model('AffiliatePayout', affiliatePayoutSchema);

// StorePackage Schema
const storePackageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  coins: { type: Number, default: 0 },
  type: { type: String, enum: ['subscription', 'coins'], required: true },
  available: { type: Boolean, default: true }
});
const StorePackage = mongoose.model('StorePackage', storePackageSchema);

// PaymentSession Schema
const paymentSessionSchema = new mongoose.Schema({
  paymentSessionId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 15 * 60 * 1000) } // 15 mins
});
const PaymentSession = mongoose.model('PaymentSession', paymentSessionSchema);

// Payment Schema
const paymentSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, unique: true },
  paymentId: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  email: { type: String }, // payment email
  status: { type: String, default: 'completed' },
  createdAt: { type: Date, default: Date.now }
});
const Payment = mongoose.model('Payment', paymentSchema);

// Subscription Schema
const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: String, required: true },
  paymentId: { type: String },
  transactionId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['active', 'expired', 'pending_review'], default: 'active' },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// Seeders
async function seedPromoCodes() {
  const codes = [
    { code: 'LAUNCH10', discount: 11 },
    { code: 'SPECIAL99', discount: 11 },
    { code: 'LOVE99', discount: 11 },
    { code: 'SOLO99', discount: 11 },
    { code: 'FRIEND99', discount: 11 }
  ];
  try {
    for (const c of codes) {
      await PromoCode.findOneAndUpdate(
        { code: c.code },
        { code: c.code, discount: c.discount, isActive: true },
        { upsert: true }
      );
    }
    console.log('[PromoCode Seed]: Promo codes initialized successfully in DB.');
  } catch (err) {
    console.error('[PromoCode Seed Error]:', err);
  }
}

async function seedStorePackages() {
  const packages = [
    { name: "Premium Dating Pass", price: 110, coins: 100, type: "subscription", available: true },
    { name: "300 intimacy coins", price: 299, coins: 300, type: "coins", available: false },
    { name: "800 intimacy coins", price: 599, coins: 800, type: "coins", available: false },
    { name: "1200 intimacy coins", price: 999, coins: 1200, type: "coins", available: false }
  ];
  try {
    for (const p of packages) {
      await StorePackage.findOneAndUpdate(
        { name: p.name },
        { name: p.name, price: p.price, coins: p.coins, type: p.type, available: p.available },
        { upsert: true }
      );
    }
    console.log('[StorePackage Seed]: Store packages initialized successfully in DB.');
  } catch (err) {
    console.error('[StorePackage Seed Error]:', err);
  }
}

async function migrateLegacyPasswords() {
  const User = mongoose.model('User');
  try {
    const rawUsers = await User.collection.find({
      password: { $exists: true },
      passwordHash: { $exists: false }
    }).toArray();

    if (rawUsers.length > 0) {
      console.log(`[Database Migration]: Found ${rawUsers.length} legacy users to migrate password field.`);
      for (const rUser of rawUsers) {
        await User.updateOne(
          { _id: rUser._id },
          {
            $set: { passwordHash: rUser.password },
            $unset: { password: "" }
          }
        );
      }
      console.log('[Database Migration]: Password migration completed successfully.');
    }
  } catch (err) {
    console.error('[Database Migration Error]:', err);
  }

  try {
    // Auto-verify all existing users to prevent lockout
    const res = await User.updateMany(
      { emailVerified: { $ne: true } },
      { $set: { emailVerified: true } }
    );
    if (res.modifiedCount > 0) {
      console.log(`[Database Migration]: Verified email for ${res.modifiedCount} legacy users.`);
    }
  } catch (err) {
    console.error('[Database Migration Email Verification Error]:', err);
  }

  try {
    // Drop legacy non-sparse unique index on email if exists
    await User.collection.dropIndex('email_1');
    console.log('[Database Migration]: Dropped legacy non-sparse email index.');
  } catch (e) {
    // Already dropped or did not exist
  }

  try {
    // Recreate unique index on email as sparse
    await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
    console.log('[Database Migration]: Recreated email unique index as sparse.');
  } catch (err) {
    console.error('[Database Migration Sparse Index Error]:', err);
  }
}

async function seedAdminUser() {
  const User = mongoose.model('User');
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@donotbesolo.com';
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  try {
    const existingAdmin = await User.findOne({
      $or: [{ username: adminUsername }, { role: 'admin' }]
    });

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    if (!existingAdmin) {
      await User.create({
        fullname: 'System Admin',
        username: adminUsername,
        email: adminEmail,
        passwordHash: hashedPassword,
        emailVerified: true,
        credits: 9999,
        coins: 9999,
        isSubscriptionActive: true,
        subscription: {
          active: true,
          plan: 'Premium Dating Pass',
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000) // Lifetime
        },
        role: 'admin'
      });
      console.log(`[Admin Seed]: Admin user auto-created (${adminUsername} / ${adminEmail}).`);
    } else {
      existingAdmin.username = adminUsername;
      existingAdmin.email = adminEmail;
      existingAdmin.passwordHash = hashedPassword;
      existingAdmin.emailVerified = true;
      existingAdmin.role = 'admin';
      existingAdmin.isSubscriptionActive = true;
      existingAdmin.subscription = {
        active: true,
        plan: 'Premium Dating Pass',
        startedAt: existingAdmin.subscription?.startedAt || new Date(),
        expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
      };
      await existingAdmin.save();
      console.log(`[Admin Seed]: Admin user credentials synchronized with env config.`);
    }
  } catch (err) {
    console.error('[Admin Seed Error]:', err);
  }
}

// -------------------------------------------------------------
// Security Middleware & Helpers
// -------------------------------------------------------------

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required. Please sign in.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token.' });
    }
    req.user = user;
    next();
  });
}

async function authenticateAdmin(req, res, next) {
  const secretKey = process.env.ADMIN_SECRET_KEY || 'super_secret_admin_key_2026';
  const keyHeader = req.headers['x-admin-key'] || req.headers['x-api-key'];
  const keyQuery = req.query.key || req.query.admin_key || req.query.apiKey;

  if ((keyHeader && keyHeader === secretKey) || (keyQuery && keyQuery === secretKey)) {
    return next();
  }

  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const [k, v] = c.trim().split('=');
      acc[k] = v;
      return acc;
    }, {});
    token = cookies['token'] || cookies['admin_token'];
  }
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Access token required. Please sign in.' });
    } else {
      return res.redirect('/admin');
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin privileges required.' });
      } else {
        return res.redirect('/admin');
      }
    }

    const User = mongoose.model('User');
    const user = await User.findById(decoded.userId);
    if (!user || user.role !== 'admin') {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ error: 'Admin profile not found or role is not admin.' });
      } else {
        return res.redirect('/admin');
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid or expired admin token.' });
    } else {
      return res.redirect('/admin');
    }
  }
}

function getDateFilterQuery(range, dateField = 'createdAt') {
  const now = new Date();
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  let matchQuery = {};

  if (range === 'today') {
    matchQuery[dateField] = { $gte: start, $lte: now };
  } else if (range === 'yesterday') {
    const yesterdayStart = new Date(start);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const yesterdayEnd = new Date(start);
    yesterdayEnd.setMilliseconds(-1);
    matchQuery[dateField] = { $gte: yesterdayStart, $lte: yesterdayEnd };
  } else if (range === '7days') {
    const sevenDaysAgo = new Date(start);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    matchQuery[dateField] = { $gte: sevenDaysAgo, $lte: now };
  } else if (range === '30days') {
    const thirtyDaysAgo = new Date(start);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
    matchQuery[dateField] = { $gte: thirtyDaysAgo, $lte: now };
  } else if (range === 'thismonth') {
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    matchQuery[dateField] = { $gte: firstDayOfMonth, $lte: now };
  } else {
    matchQuery = {};
  }

  return matchQuery;
}

async function cleanExpiredPhysicalFiles() {
  try {
    const activeMediaInDb = await Media.find({}, { filePath: 1 });
    const activePaths = new Set(activeMediaInDb.map(m => path.resolve(m.filePath)));

    fs.readdir(UPLOADS_DIR, (err, files) => {
      if (err) return console.error('[Cleanup] Error reading uploads folder:', err);

      files.forEach(file => {
        const fullPath = path.join(UPLOADS_DIR, file);
        if (file.startsWith('.')) return;

        if (!activePaths.has(path.resolve(fullPath))) {
          fs.unlink(fullPath, (unlinkErr) => {
            if (unlinkErr) console.error(`[Cleanup] Failed to delete expired file ${file}:`, unlinkErr);
            else console.log(`[Cleanup] Successfully purged expired file: ${file}`);
          });
        }
      });
    });
  } catch (err) {
    console.error('[Cleanup] Routine encountered error:', err);
  }
}
setInterval(cleanExpiredPhysicalFiles, 60 * 60 * 1000);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const { checkSubscription } = require('./services/subscription.service');

// Simple In-Memory Rate Limiter Middleware
const rateLimitStore = {};
function rateLimiter(limit, windowMs, message) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();

    if (!rateLimitStore[ip]) {
      rateLimitStore[ip] = [];
    }

    rateLimitStore[ip] = rateLimitStore[ip].filter(time => now - time < windowMs);

    if (rateLimitStore[ip].length >= limit) {
      return res.status(429).json({ error: message || 'Too many requests. Please try again later.' });
    }

    rateLimitStore[ip].push(now);
    next();
  };
}

// POST /api/signup (Direct Registration)
app.post('/api/signup', rateLimiter(5, 60 * 1000, 'Too many accounts created from this IP. Please try again later.'), async (req, res) => {
  const { fullname, username, email, password, confirmPassword, referredBy, referralCode } = req.body;

  if (!fullname || !username || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Full name, username, password, and confirm password fields are required.' });
  }

  // Prevent NoSQL Injection
  const safeFullname = String(fullname).trim();
  const safeUsername = String(username).trim();
  const safeEmail = email ? String(email).trim().toLowerCase() : null;
  const safePassword = String(password);
  const safeConfirmPassword = String(confirmPassword);
  const rawRef = String(referralCode || referredBy || '').toUpperCase().trim();

  try {
    if (safeUsername.length < 3 || safePassword.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters and password must be at least 6 characters long.' });
    }

    if (safePassword !== safeConfirmPassword) {
      return res.status(400).json({ error: 'Password and confirm password do not match.' });
    }

    // Email format validation (only if provided)
    if (safeEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(safeEmail)) {
        return res.status(400).json({ error: 'Invalid email address format.' });
      }
    }

    // Check username uniqueness (case-insensitive)
    const usernameExists = await User.findOne({ username: { $regex: new RegExp(`^${safeUsername}$`, 'i') } });
    if (usernameExists) {
      return res.status(400).json({ error: 'Username is already registered.' });
    }

    // Check email uniqueness (case-insensitive) (only if provided)
    if (safeEmail) {
      const emailExists = await User.findOne({ email: { $regex: new RegExp(`^${safeEmail}$`, 'i') } });
      if (emailExists) {
        return res.status(400).json({ error: 'Email is already registered.' });
      }
    }

    const hashedPassword = await bcrypt.hash(safePassword, 10);
    const initialCredits = 20;

    let referredByPartnerId = null;
    let promo = null;
    if (rawRef) {
      promo = await PromoCode.findOne({ code: rawRef, isActive: true });
      if (promo) {
        referredByPartnerId = promo.affiliateId;
      }
    }

    // Generate random verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedVerificationToken = crypto.createHash('sha256').update(verificationToken).digest('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours validity

    // Create User (emailVerified is true if no email is provided, false if email is provided)
    const userPayload = {
      fullname: safeFullname,
      username: safeUsername,
      passwordHash: hashedPassword,
      emailVerified: safeEmail ? false : true,
      emailVerificationToken: safeEmail ? hashedVerificationToken : null,
      emailVerificationExpires: safeEmail ? verificationExpires : null,
      referredByPartnerId,
      credits: initialCredits,
      coins: initialCredits,
      referredBy: promo ? promo.code : (rawRef || null),
      paymentStatus: 'unpaid',
      isSubscriptionActive: false,
      subscription: {
        active: false,
        plan: null,
        startedAt: null,
        expiresAt: null
      }
    };

    if (safeEmail) {
      userPayload.email = safeEmail;
    }

    const newUser = await User.create(userPayload);

    // Send Verification Email (only if email is provided)
    if (safeEmail) {
      const verificationLink = `${req.protocol}://${req.get('host')}/api/verify-email?token=${verificationToken}`;
      try {
        const { sendVerificationEmail } = require('./services/email.service');
        await sendVerificationEmail(newUser.email, verificationLink);
      } catch (mailErr) {
        console.log(`[LOCAL DEV EMAIL VERIFICATION LINK LOG] Email: ${newUser.email} | Link: ${verificationLink}`);
      }
    }

    // Process referrer credits if standard user referral
    if (rawRef && !promo) {
      const referrer = await User.findOne({ username: { $regex: new RegExp(`^${rawRef}$`, 'i') } });
      if (referrer) {
        referrer.credits = (referrer.credits || 0) + 50;
        referrer.coins = (referrer.coins || 0) + 50;
        await referrer.save();

        await Transaction.create({
          userId: referrer._id,
          refCode: rawRef,
          amount: 0,
          type: 'coins',
          coins: 50,
          status: 'completed'
        });
      }
    }

    // Process affiliate partner code use
    if (referredByPartnerId) {
      await AffiliatePartner.findByIdAndUpdate(referredByPartnerId, {
        $inc: { totalCodeUses: 1, uniqueUsers: 1 }
      });
    }

    const token = jwt.sign(
      { userId: newUser._id, username: newUser.username, role: newUser.role || 'user' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    mixpanelService.track('User Signed Up', newUser._id, {
      fullname: newUser.fullname,
      username: newUser.username,
      email: newUser.email,
      referred_by: newUser.referredBy
    });
    mixpanelService.setUserProfile(newUser._id, {
      $name: newUser.fullname,
      $email: newUser.email,
      username: newUser.username,
      $created: newUser.createdAt || new Date()
    });

    res.setHeader('Set-Cookie', `token=${token}; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);

    res.status(201).json({
      success: true,
      token,
      userId: newUser._id,
      username: newUser.username,
      credits: newUser.coins !== undefined ? newUser.coins : newUser.credits,
      paymentStatus: newUser.paymentStatus || 'unpaid',
      isSubscriptionActive: false,
      redirect: "/index.html",
      message: safeEmail ? 'Account created successfully! A verification link has been sent to your email.' : 'Account created successfully!'
    });
  } catch (err) {
    console.error('[Signup Error]:', err);
    res.status(500).json({ error: 'System failure creating your account profile.' });
  }
});

// Disabled email/phone OTP routes
app.post('/api/verify-otp', (req, res) => {
  res.status(410).json({ error: 'OTP verification is deprecated and removed.' });
});
app.post('/api/resend-otp', (req, res) => {
  res.status(410).json({ error: 'OTP verification is deprecated and removed.' });
});
app.post('/api/auth/send-phone-otp', (req, res) => {
  res.status(410).json({ error: 'OTP verification is deprecated and removed.' });
});
// GET /api/verify-email
app.get('/api/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('/login.html?message=email_verification_failed');
  }

  try {
    const hashedToken = crypto.createHash('sha256').update(String(token)).digest('hex');
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.redirect('/login.html?message=email_verification_failed');
    }

    user.emailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    res.redirect('/login.html?message=email_verified');
  } catch (err) {
    console.error('[Verify Email Error]:', err);
    res.redirect('/login.html?message=email_verification_failed');
  }
});

// POST /api/resend-verification
app.post('/api/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    const user = await User.findOne({ email: String(email).trim().toLowerCase() });
    if (!user) {
      return res.status(200).json({ success: true, message: 'If the account exists, a new verification link has been sent.' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: 'Email is already verified.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    user.emailVerificationToken = hashedToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    const verificationLink = `${req.protocol}://${req.get('host')}/api/verify-email?token=${token}`;
    
    try {
      const { sendVerificationEmail } = require('./services/email.service');
      await sendVerificationEmail(user.email, verificationLink);
    } catch (err) {
      console.log(`[LOCAL DEV VERIFICATION LINK LOG] Email: ${user.email} | Link: ${verificationLink}`);
    }

    res.status(200).json({ success: true, message: 'If the account exists, a new verification link has been sent.' });
  } catch (err) {
    console.error('[Resend verification error]:', err);
    res.status(500).json({ error: 'Failed to process verification request.' });
  }
});

// POST /api/login
app.post('/api/login', rateLimiter(10, 60 * 1000, 'Too many login attempts. Please try again in a minute.'), async (req, res) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Identifier and password credentials required.' });
  }

  // Prevent NoSQL Injection
  const safeIdentifier = String(usernameOrEmail).trim();
  const safePassword = String(password);

  try {
    const user = await User.findOne({
      $or: [
        { email: { $regex: new RegExp(`^${safeIdentifier}$`, 'i') } },
        { username: { $regex: new RegExp(`^${safeIdentifier}$`, 'i') } }
      ]
    });

    if (!user) {
      return res.status(400).json({ error: 'Credentials not found in the grid.' });
    }

    // Verify Password Hash
    const isMatch = await bcrypt.compare(safePassword, user.passwordHash || '');
    if (!isMatch) {
      return res.status(400).json({ error: 'Access denied. Incorrect security credentials.' });
    }

    // Verify Email Verification Status
    // Verify Email Verification Status (only if email is registered)
    if (user.email && !user.emailVerified) {
      return res.status(400).json({ error: 'Please verify your email address. A verification link was sent to your email.' });
    }

    // Check & dynamic update subscription expiration
    const subscriptionActive = await checkSubscription(user);

    const token = jwt.sign({ userId: user._id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });

    mixpanelService.track('User Logged In', user._id, {
      username: user.username
    });

    res.setHeader('Set-Cookie', `token=${token}; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@donotbesolo.com';
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const isEmailAdmin = user.email && adminEmail && user.email.toLowerCase().trim() === adminEmail.toLowerCase().trim();
    const isUsernameAdmin = user.username && adminUsername && user.username.toLowerCase().trim() === adminUsername.toLowerCase().trim();

    let redirectUrl = "/index.html";
    if (isEmailAdmin || isUsernameAdmin || user.role === 'admin') {
      redirectUrl = "/admin/affiliates";
    }

    res.status(200).json({
      success: true,
      token,
      userId: user._id,
      username: user.username,
      credits: user.coins !== undefined ? user.coins : user.credits,
      paymentStatus: user.paymentStatus || 'unpaid',
      isSubscriptionActive: subscriptionActive,
      redirect: redirectUrl
    });
  } catch (err) {
    console.error('[Login Error]:', err);
    res.status(500).json({ error: 'System failure verifying database login.' });
  }
});

// POST /api/send-reset-otp (Forgot Password Request)
app.post('/api/send-reset-otp', rateLimiter(5, 60 * 1000, 'Too many password reset requests. Please try again in a minute.'), async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required to recover account.' });
  }

  // Prevent NoSQL Injection
  const safeEmail = String(email).trim().toLowerCase();

  try {
    const user = await User.findOne({ email: safeEmail });

    // Security practice: do not reveal user existence
    const successMsg = 'If a matching account exists, a recovery link has been dispatched to your email address.';
    if (!user || !user.email) {
      return res.status(200).json({ success: true, message: successMsg });
    }

    // Generate random token and hash it for DB storage
    const token = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes validity
    await user.save();

    // Construct reset link
    const resetUrl = `${req.protocol}://${req.get('host')}/forgot-password.html?token=${token}`;

    try {
      const { sendResetPasswordEmail } = require('./services/email.service');
      await sendResetPasswordEmail(user.email, resetUrl);
      res.status(200).json({ success: true, message: successMsg });
    } catch (mailErr) {
      console.log(`[LOCAL DEV RESET LINK LOG] Email: ${user.email} | Link: ${resetUrl}`);
      return res.status(200).json({ success: true, devMode: true, message: 'Recovery link logged to server console (SMTP skipped).' });
    }
  } catch (err) {
    console.error('[Reset OTP Error]:', err);
    res.status(500).json({ error: 'System failed to register reset parameters.' });
  }
});

// POST /api/reset-password
app.post('/api/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required to update credentials.' });
  }

  try {
    // Hash incoming token to match DB
    const hashedToken = crypto.createHash('sha256').update(String(token)).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired password reset token.' });
    }

    // Set new password
    user.passwordHash = await bcrypt.hash(String(newPassword), 10);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    res.status(200).json({ success: true, message: 'Cybernetic credentials updated successfully.' });
  } catch (err) {
    console.error('[Reset password Error]:', err);
    res.status(500).json({ error: 'Security engine failed to rehash password credentials.' });
  }
});

const COMPANIONS = personalityService.COMPANIONS;

// POST /api/chat/select
app.post('/api/chat/select', authenticateToken, async (req, res) => {
  const { companion, gender, vibe, language } = req.body;
  if (!companion || !gender || !vibe || !language) {
    return res.status(400).json({ error: 'Companion, gender, vibe, and language are required.' });
  }
  const userId = req.user.userId;

  try {
    const updated = await preferencesService.updatePreferences(userId, { companion, vibe, language });
    mixpanelService.track('Bot Selected', userId, {
      companion: companion,
      gender: gender,
      vibe: vibe,
      language: language
    });

    res.status(200).json({
      success: true,
      message: 'Companion preferences saved successfully.',
      activeCompanion: {
        name: companion,
        gender,
        vibe,
        language
      }
    });
  } catch (err) {
    console.error('[Select Companion API Error]:', err);
    res.status(500).json({ error: `Database update failed: ${err.message}` });
  }
});

// GET /api/chat/history (Uses Blueminds Llama 3.1 8B for Greetings)
app.get('/api/chat/history', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    let companionName = user.selectedCompanion || user.activeCompanionName;
    let vibe = user.selectedVibe || user.activeVibe;
    let language = user.selectedLanguage || user.activeLanguage;

    if (!companionName) {
      companionName = 'Aria';
      vibe = 'Flirty';
      language = 'English';

      await User.updateOne({ _id: userId }, {
        $set: {
          selectedCompanion: companionName,
          selectedVibe: vibe,
          selectedLanguage: language,
          activeCompanionName: companionName,
          activeVibe: vibe,
          activeLanguage: language
        }
      });
    }

    const companionMeta = COMPANIONS[companionName] || { gender: 'Female', avatar: '👩‍🦰', defaultVibe: 'Flirty', defaultLanguage: 'Hinglish' };
    const gender = companionMeta.gender;
    const avatar = companionMeta.avatar;

    let conversation = await Conversation.findOne({ userId, companionName });
    if (!conversation) {
      conversation = await Conversation.create({
        userId,
        companionName,
        vibe,
        language,
        relationshipLevel: 1.0,
        memories: [],
        summary: "",
        history: []
      });
    }

    if (conversation.history.length === 0) {
      let welcomeMsg = "";

      // Blueminds AI Chat Greeting (meta-llama/llama-3.1-8b-instruct)
      const aiApiKey = process.env.BLUEMINDS_API_KEY;

      if (aiApiKey) {
        try {
          const sysPrompt = `You are a 20-year-old ${gender} companion named ${companionName} in a cyberpunk universe. You have a ${vibe} personality.
Write a warm, engaging, and highly personalized introductory message to the user who has just opened the chat for the first time. Keep it strictly 1 to 2 short sentences.
Response language: ${language === 'Hinglish' ? 'Hinglish (mix of Hindi written in Latin script and English - e.g., "Main theek hoon, you tell how are you?")' : language} (Write strictly in the specified language, matching the vibe. If Hinglish, do not use Devanagari script).
Never write warnings, meta-text, or break character. Keep it flirty/playful/supportive according to your ${vibe} vibe. Never use asterisks or written stage actions (e.g., do NOT write *giggles*, *blushes*, *smiles*, *looks away*). Express all emotions and tone naturally through dialogue, light expressive text (like 'haha', 'hehe', 'omg'), and natural emojis.`;

          const aiRes = await axios.post('https://api.bluesminds.com/v1/chat/completions', {
            model: 'meta/llama-3.1-8b-instruct',
            messages: [
              { role: 'system', content: sysPrompt },
              { role: 'user', content: 'Greet me for the first time.' }
            ],
            max_tokens: 80,
            temperature: 0.8
          }, {
            headers: {
              'Authorization': `Bearer ${aiApiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          });

          welcomeMsg = aiRes.data.choices[0].message.content.trim();
        } catch (apiErr) {
          console.error('[Bluesminds Welcome Greeting Error]:', apiErr.response ? apiErr.response.data : apiErr.message);
        }
      }

      if (!welcomeMsg) {
        if (language === 'Hinglish') {
          welcomeMsg = "Hey! Aur batao, kaise ho? I've been waiting for you! ❤️";
        } else {
          welcomeMsg = "Hey! I've been waiting for you. How was your day? ❤️";
        }
      }
      if (welcomeMsg) {
        welcomeMsg = welcomeMsg.replace(/\*[^*]+\*/g, '').replace(/\s{2,}/g, ' ').trim();
      }
      conversation.history.push({
        role: 'assistant',
        content: welcomeMsg,
        timestamp: new Date()
      });
      await conversation.save();
    }

    const resolvedHistory = [];
    for (const msg of conversation.history) {
      const msgObj = msg.toObject();
      if (msgObj.lockedMedia && msgObj.lockedMedia.mediaId) {
        const media = await Media.findOne({ mediaId: msgObj.lockedMedia.mediaId });
        if (media) {
          msgObj.lockedMedia.unlocked = media.unlockedBy.includes(userId);
        }
      }
      resolvedHistory.push(msgObj);
    }

    res.status(200).json({
      success: true,
      credits: user.coins !== undefined ? user.coins : user.credits,
      isSubscriptionActive: await checkSubscription(user),
      activeCompanion: {
        name: companionName,
        gender,
        avatar,
        vibe,
        language,
        relationshipLevel: conversation.relationshipLevel
      },
      history: resolvedHistory
    });
  } catch (err) {
    console.error('[Get Chat History API Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve connection history.' });
  }
});

const memoryRoutes = require('./services/memory.routes');
app.use('/api/memory', authenticateToken, memoryRoutes);

// Preferences routes
app.post('/api/preferences/update', authenticateToken, async (req, res) => {
  const { companion, vibe, language } = req.body;
  const userId = req.user.userId;

  if (!companion || !vibe || !language) {
    return res.status(400).json({ error: 'Companion, vibe, and language are required.' });
  }

  try {
    const updated = await preferencesService.updatePreferences(userId, { companion, vibe, language });
    res.status(200).json({
      success: true,
      message: 'Preferences updated successfully.',
      preferences: updated
    });
  } catch (err) {
    console.error('[Update Preferences Error]:', err);
    res.status(500).json({ error: `Failed to update preferences: ${err.message}` });
  }
});

app.post('/api/user/preferences', authenticateToken, async (req, res) => {
  const { companion, vibe, language } = req.body;
  const userId = req.user.userId;

  if (!companion || !vibe || !language) {
    return res.status(400).json({ error: 'Missing preference data.' });
  }

  try {
    const updated = await preferencesService.updatePreferences(userId, { companion, vibe, language });
    res.status(200).json({
      success: true,
      message: 'Preferences saved successfully.',
      preferences: { companion, vibe, language }
    });
  } catch (err) {
    console.error('[Preference Save Error]:', err);
    res.status(500).json({ error: 'Failed to update preferences on server.' });
  }
});

app.post('/api/chat/settings', authenticateToken, async (req, res) => {
  const { vibe, language, companion } = req.body;
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    const companionName = companion || user.selectedCompanion || user.activeCompanionName || 'Aria';
    const activeVibe = vibe || user.selectedVibe || user.activeVibe || 'Flirty';
    const activeLanguage = language || user.selectedLanguage || user.activeLanguage || 'English';

    await preferencesService.updatePreferences(userId, {
      companion: companionName,
      vibe: activeVibe,
      language: activeLanguage
    });

    res.status(200).json({
      success: true,
      message: 'Active settings updated immediately.',
      companion: companionName,
      vibe: activeVibe,
      language: activeLanguage
    });
  } catch (err) {
    console.error('[Update Settings API Error]:', err);
    res.status(500).json({ error: `Failed to update preferences: ${err.message}` });
  }
});

// Chat Images
app.post('/api/chat/upload-image', authenticateToken, async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({ error: 'Missing image payload parameters.' });
  }

  try {
    const validation = validateImageBase64(imageBase64, mimeType);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const uniqueId = crypto.randomBytes(16).toString('hex');
    const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp';
    const filename = `chat-img-${uniqueId}.${ext}`;
    const filePath = path.join(CHAT_IMAGES_DIR, filename);

    fs.writeFileSync(filePath, validation.buffer);

    res.status(200).json({
      success: true,
      imageUrl: `/api/chat/images/${filename}`
    });
  } catch (err) {
    console.error('[Chat Image Upload Error]:', err.message);
    res.status(500).json({ error: "Couldn't upload that image. Please try again." });
  }
});

app.get('/api/chat/images/:filename', authenticateToken, async (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(CHAT_IMAGES_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Image file not found.');
  }

  res.sendFile(filePath);
});

// Main Chat endpoint
app.post('/api/chat', authenticateToken, async (req, res) => {
  const { message, imageUrl } = req.body;
  const userId = req.user.userId;

  if (!message && !imageUrl) {
    return res.status(400).json({ error: 'Message content or image is required.' });
  }

  try {
    const result = await chatSessionService.handleChatMessage(userId, { message, imageUrl });
    res.status(200).json(result);
  } catch (err) {
    console.error('[Chat API Error]:', err.message);
    if (err.statusCode === 402) {
      return res.status(402).json({ error: err.message, credits: err.credits });
    }
    res.status(err.statusCode || 500).json({ error: err.message || 'Communication glitch. Please check connection.' });
  }
});

// POST /api/generate-image
app.post('/api/generate-image', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User registry error.' });

    if (!(await checkSubscription(user))) {
      return res.status(403).json({ error: 'Active Dating Pass Required' });
    }

    const currentCoins = user.coins !== undefined ? user.coins : user.credits;
    if (currentCoins < 40) {
      return res.status(402).json({
        success: false,
        error: "INSUFFICIENT_COINS",
        message: "You need coins to generate custom photos. Please top-up your coins!"
      });
    }

    const userPref = await preferencesService.loadPreferences(userId);
    const activeCompanionName = userPref.selectedCompanion;
    const activeVibe = userPref.selectedVibe;
    const relationshipLevel = userPref.relationshipLevel;

    user.coins = currentCoins - 40;
    user.credits = user.coins;
    await user.save();

    const mediaId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(UPLOADS_DIR, `media-${mediaId}.jpg`);

    const svg = `
      <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="#150d2a" />
        <circle cx="256" cy="256" r="100" fill="none" stroke="#ff4da6" stroke-width="4" />
        <text x="50%" y="270" text-anchor="middle" fill="#ff4da6" font-size="20">Selfie Generation Fallback</text>
      </svg>
    `;
    fs.writeFileSync(filePath, svg);

    await Media.create({
      mediaId,
      mediaType: 'image',
      filePath,
      isLocked: true,
      unlockedBy: []
    });

    res.status(200).json({
      success: true,
      mediaId,
      mediaType: 'image',
      coins: 50,
      credits: user.credits
    });
  } catch (err) {
    console.error('[Generate Image Error]:', err);
    res.status(500).json({ error: 'Failed to command visual generator.' });
  }
});

// POST /api/request-voice-note (ElevenLabs Audio Generation)
app.post('/api/request-voice-note', authenticateToken, async (req, res) => {
  const { text, history } = req.body;
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile mapping error.' });

    if (!(await checkSubscription(user))) {
      return res.status(403).json({ error: 'Active Dating Pass Required' });
    }

    const currentCoins = user.coins !== undefined ? user.coins : user.credits;
    if (currentCoins < 40) {
      return res.status(402).json({
        success: false,
        error: "INSUFFICIENT_COINS",
        message: "You need coins to generate custom voice notes. Please top-up your coins!"
      });
    }

    const userPref = await preferencesService.loadPreferences(userId);
    const activeCompanionName = userPref.selectedCompanion;
    const activeVibe = userPref.selectedVibe;
    const personalityData = personalityService.getPersonalityPrompt(activeCompanionName, activeVibe);
    const companionGender = personalityData.gender;

    user.coins = currentCoins - 40;
    user.credits = user.coins;
    await user.save();

    await Transaction.create({
      userId,
      amount: 0,
      type: 'voice_note_generation',
      coins: 40,
      status: 'completed'
    });

    const speechText = text || "Hey baby, I'm thinking of you. Let's stay connected! ❤️";
    const mediaId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(UPLOADS_DIR, `media-${mediaId}.mp3`);
    let voiceWritten = false;

    if (process.env.ELEVENLABS_API_KEY) {
      try {
        const voiceId = companionGender && companionGender.toLowerCase() === 'male' ? 'pNInz6obpgqjVW4WZ44C' : '21m00Tcm4TlvDq8ikWAM';
        const voiceRes = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          text: speechText,
          model_id: 'eleven_monolingual_v1',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        }, {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          responseType: 'arraybuffer',
          timeout: 10000
        });

        fs.writeFileSync(filePath, Buffer.from(voiceRes.data));
        voiceWritten = true;
      } catch (err) {
        console.error('[Elevenlabs Custom TTS failed]:', err.message);
      }
    }

    if (!voiceWritten) {
      fs.writeFileSync(filePath, Buffer.alloc(100));
    }

    await Media.create({
      mediaId,
      mediaType: 'voice',
      filePath,
      isLocked: true,
      unlockedBy: []
    });

    res.status(200).json({
      success: true,
      mediaId,
      mediaType: 'voice',
      coins: 40,
      credits: user.credits
    });
  } catch (err) {
    console.error('[Request voice note error]:', err);
    res.status(500).json({ error: 'Voice synthesizer unit encountered an error.' });
  }
});

// POST /api/media/unlock
app.post('/api/media/unlock', authenticateToken, async (req, res) => {
  const { mediaId } = req.body;
  const userId = req.user.userId;

  if (!mediaId) {
    return res.status(400).json({ error: 'Media identifier is required to unlock.' });
  }

  try {
    const media = await Media.findOne({ mediaId });
    if (!media) {
      return res.status(404).json({ error: 'Requested premium media log does not exist.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User registration error.' });

    if (media.unlockedBy.includes(userId)) {
      return res.status(200).json({ success: true, message: 'Media already unlocked.', mediaType: media.mediaType });
    }

    const cost = 40;
    if (user.credits < cost) {
      return res.status(402).json({ error: `Insufficient credits. Unlocking this requires ${cost} coins.`, credits: user.credits });
    }

    user.credits -= cost;
    await user.save();

    media.unlockedBy.push(userId);
    await media.save();

    await Transaction.create({
      userId,
      amount: 0,
      type: 'media_unlock',
      coins: cost,
      status: 'completed'
    });

    res.status(200).json({
      success: true,
      message: 'Premium media unlocked successfully.',
      credits: user.credits,
      mediaType: media.mediaType
    });
  } catch (err) {
    console.error('[Media unlock error]:', err);
    res.status(500).json({ error: 'Failed to verify transaction code.' });
  }
});

// GET /api/media/:mediaId
app.get('/api/media/:mediaId', async (req, res) => {
  const { mediaId } = req.params;
  const token = req.query.token || (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]);

  if (!token) {
    return res.status(401).json({ error: 'Authorization token required to access files.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId;

    const media = await Media.findOne({ mediaId });
    if (!media) {
      return res.status(404).json({ error: 'Media resource not found.' });
    }

    if (media.isLocked && !media.unlockedBy.includes(userId)) {
      return res.status(403).json({ error: 'Access denied. Premium resource is locked.' });
    }

    const absolutePath = path.resolve(media.filePath);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Resource file lost in disk registry.' });
    }

    res.sendFile(absolutePath);
  } catch (err) {
    console.error('[Secure Stream Error]:', err);
    res.status(403).json({ error: 'Invalid authentication authorization.' });
  }
});

// -------------------------------------------------------------
// Affiliate Helpers & Packages
// -------------------------------------------------------------

async function processAffiliateConversion(tx) {
  if (!tx.refCode) return;

  try {
    const promo = await PromoCode.findOne({ code: tx.refCode.toUpperCase().trim() });
    if (!promo || !promo.affiliateId) return;

    const existingConversion = await AffiliateConversion.findOne({ transactionId: tx._id });
    if (existingConversion) return;

    const affiliate = await AffiliatePartner.findById(promo.affiliateId);
    if (!affiliate) return;

    const customerUser = await User.findById(tx.userId);
    if (customerUser && (
      (affiliate.email && customerUser.email && affiliate.email.toLowerCase().trim() === customerUser.email.toLowerCase().trim()) ||
      (affiliate.userId && affiliate.userId.toString() === tx.userId.toString())
    )) {
      return;
    }

    const originalAmount = tx.originalAmount || (tx.amount + (tx.discountAmount || promo.discount || 0));
    const discountAmount = tx.discountAmount || promo.discount || 0;
    const amountPaid = tx.amount;
    const commissionPercent = promo.commissionPercent || affiliate.commissionPercent || 0;
    const commissionAmount = Math.round((amountPaid * (commissionPercent / 100)) * 100) / 100;

    const conversion = await AffiliateConversion.create({
      affiliateId: affiliate._id,
      promoCode: promo.code,
      customerUserId: tx.userId,
      transactionId: tx._id,
      paymentId: tx._id.toString(),
      originalAmount,
      discountAmount,
      amountPaid,
      commissionPercent,
      commissionAmount,
      status: 'earned'
    });

    tx.affiliateId = affiliate._id;
    tx.affiliateCommissionId = conversion._id;
    tx.commissionAmount = commissionAmount;
    await tx.save();

    affiliate.totalSuccessfulPurchases += 1;
    affiliate.totalRevenue += amountPaid;
    affiliate.totalCommissionEarned += commissionAmount;
    affiliate.totalCommissionPending += commissionAmount;
    affiliate.updatedAt = new Date();
    await affiliate.save();

    mixpanelService.track('Affiliate Commission Earned', tx.userId, {
      affiliate_id: affiliate._id.toString(),
      affiliate_instagram: affiliate.instagramUsername,
      promo_code: promo.code,
      transaction_id: tx._id.toString(),
      amount: amountPaid,
      commission_amount: commissionAmount
    });
  } catch (err) {
    console.error('[Affiliate Conversion Process Error]:', err);
  }
}

async function reverseAffiliateConversion(transactionId, reason = 'Refunded') {
  try {
    const conversion = await AffiliateConversion.findOne({ transactionId });
    if (!conversion || conversion.status === 'reversed') return;

    const previousStatus = conversion.status;
    conversion.status = 'reversed';
    conversion.reversedAt = new Date();
    conversion.reversalReason = reason;
    await conversion.save();

    const affiliate = await AffiliatePartner.findById(conversion.affiliateId);
    if (affiliate) {
      affiliate.totalSuccessfulPurchases = Math.max(0, affiliate.totalSuccessfulPurchases - 1);
      affiliate.totalRevenue = Math.max(0, affiliate.totalRevenue - conversion.amountPaid);
      affiliate.totalCommissionEarned = Math.max(0, affiliate.totalCommissionEarned - conversion.commissionAmount);

      if (previousStatus === 'paid') {
        affiliate.totalCommissionPaid = Math.max(0, affiliate.totalCommissionPaid - conversion.commissionAmount);
      } else {
        affiliate.totalCommissionPending = Math.max(0, affiliate.totalCommissionPending - conversion.commissionAmount);
      }
      affiliate.updatedAt = new Date();
      await affiliate.save();
    }

    await Transaction.findByIdAndUpdate(transactionId, { status: 'failed' });
  } catch (err) {
    console.error('[Affiliate Conversion Reversal Error]:', err);
  }
}

// GET /api/store/packages
app.get('/api/store/packages', async (req, res) => {
  try {
    const StorePackage = mongoose.model('StorePackage');
    const packages = await StorePackage.find({});
    res.status(200).json(packages);
  } catch (err) {
    console.error('[Get Store Packages Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve packages.' });
  }
});

// POST /api/payment/validate-referral
app.post('/api/payment/validate-referral', authenticateToken, async (req, res) => {
  const { refCode } = req.body;
  const customerUserId = req.user.userId;
  const originalPrice = 110;

  if (!refCode) {
    return res.status(400).json({ valid: false, message: 'Referral code is required.' });
  }

  try {
    const promo = await PromoCode.findOne({ code: refCode.toUpperCase().trim(), isActive: true });
    if (!promo) {
      return res.status(200).json({ valid: false, discount: 0, message: 'Invalid referral code.' });
    }

    let affiliate = null;
    if (promo.affiliateId) {
      affiliate = await AffiliatePartner.findById(promo.affiliateId);
      if (!affiliate || affiliate.status !== 'active') {
        return res.status(200).json({ valid: false, discount: 0, message: 'Referral code is currently inactive.' });
      }

      const customerUser = await User.findById(customerUserId);
      if (customerUser && (
        (affiliate.email && customerUser.email && affiliate.email.toLowerCase().trim() === customerUser.email.toLowerCase().trim()) ||
        (affiliate.userId && affiliate.userId.toString() === customerUserId.toString())
      )) {
        return res.status(200).json({ valid: false, discount: 0, message: 'Self-referral is not permitted.' });
      }

      const existingUse = await AffiliateCodeUse.findOne({
        affiliateId: affiliate._id,
        customerUserId,
        promoCode: promo.code
      });

      if (!existingUse) {
        await AffiliateCodeUse.create({
          affiliateId: affiliate._id,
          promoCode: promo.code,
          customerUserId: customerUserId
        });
        await AffiliatePartner.findByIdAndUpdate(affiliate._id, { $inc: { totalCodeUses: 1 } });
      }
    }

    const discountPrice = Math.max(0, originalPrice - promo.discount);
    res.status(200).json({
      valid: true,
      code: promo.code,
      affiliateId: affiliate ? affiliate._id : null,
      instagramUsername: affiliate ? affiliate.instagramUsername : null,
      discount: promo.discount,
      discountPrice: discountPrice,
      finalPrice: discountPrice
    });
  } catch (err) {
    console.error('[Promo Validate Error]:', err);
    res.status(500).json({ error: 'Server error during promo code validation.' });
  }
});

// GET /api/subscription/status
app.get('/api/subscription/status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.status(200).json({
      subscriptionActive: await checkSubscription(user),
      coins: user.coins !== undefined ? user.coins : (user.credits || 0)
    });
  } catch (err) {
    console.error('[Get Subscription Status Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve subscription status.' });
  }
});

// POST /api/check-referral
app.post('/api/check-referral', authenticateToken, async (req, res) => {
  const { refCode } = req.body;
  const customerUserId = req.user.userId;
  const originalPrice = 110;

  if (!refCode) {
    return res.status(200).json({ valid: false, discountPrice: originalPrice });
  }

  try {
    const promo = await PromoCode.findOne({ code: refCode.toUpperCase().trim(), isActive: true });
    if (!promo) {
      return res.status(200).json({ valid: false, discountPrice: originalPrice, message: 'Invalid referral code.' });
    }

    let affiliate = null;
    if (promo.affiliateId) {
      affiliate = await AffiliatePartner.findById(promo.affiliateId);
      if (!affiliate || affiliate.status !== 'active') {
        return res.status(200).json({ valid: false, discountPrice: originalPrice, message: 'Referral code is currently inactive.' });
      }

      const customerUser = await User.findById(customerUserId);
      if (customerUser && (
        (affiliate.email && customerUser.email && affiliate.email.toLowerCase().trim() === customerUser.email.toLowerCase().trim()) ||
        (affiliate.userId && affiliate.userId.toString() === customerUserId.toString())
      )) {
        return res.status(200).json({ valid: false, discountPrice: originalPrice, message: 'Self-referral is not permitted.' });
      }
    }

    const discountPrice = Math.max(0, originalPrice - promo.discount);
    return res.status(200).json({
      valid: true,
      code: promo.code,
      affiliateId: affiliate ? affiliate._id : null,
      instagramUsername: affiliate ? affiliate.instagramUsername : null,
      discount: promo.discount,
      discountPrice: discountPrice,
      finalPrice: discountPrice
    });
  } catch (err) {
    console.error('[Promo Validate Error]:', err);
    return res.status(200).json({ valid: false, discountPrice: originalPrice });
  }
});

// POST /api/payment/create-order (UroPay UPI)
app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  const { refCode, packageName } = req.body;
  const userId = req.user.userId;

  const targetPackageName = packageName || "Premium Dating Pass";

  try {
    const StorePackage = mongoose.model('StorePackage');
    const pack = await StorePackage.findOne({ name: targetPackageName });
    if (!pack || !pack.available) {
      return res.status(400).json({ error: 'This package is currently unavailable.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    if (await checkSubscription(user) || user.paymentStatus === 'paid') {
      return res.status(400).json({ error: 'Subscription is already active.' });
    }

    // Safely load and trim UroPay links from environment variables
    const rawLink110 = process.env.UROPAY_LINK_110;
    const rawLink99 = process.env.UROPAY_LINK_99;

    const uropayLink110 = rawLink110 ? String(rawLink110).trim().replace(/^["']|["']$/g, '') : null;
    const uropayLink99 = rawLink99 ? String(rawLink99).trim().replace(/^["']|["']$/g, '') : null;

    if (!uropayLink110 || !uropayLink99) {
      console.error('[UroPay Config Error]: Missing UROPAY_LINK_110 or UROPAY_LINK_99 in environment configuration.');
      return res.status(500).json({ error: 'Payment gateway configuration error. Please contact system administrator.' });
    }

    let promo = null;
    let affiliate = null;
    let discountAmount = 0;
    let isCouponValid = false;
    const hasCouponSupplied = Boolean(refCode && typeof refCode === 'string' && refCode.trim().length > 0);

    if (hasCouponSupplied) {
      const cleanRefCode = refCode.toUpperCase().trim();
      promo = await PromoCode.findOne({ code: cleanRefCode, isActive: true });
      if (promo) {
        if (promo.affiliateId) {
          affiliate = await AffiliatePartner.findById(promo.affiliateId);
          if (affiliate && affiliate.status === 'active') {
            const isSelfReferral = (
              (affiliate.email && user.email && affiliate.email.toLowerCase().trim() === user.email.toLowerCase().trim()) ||
              (affiliate.userId && affiliate.userId.toString() === userId.toString())
            );
            if (!isSelfReferral) {
              isCouponValid = true;
              discountAmount = promo.discount || 0;
            }
          }
        } else {
          isCouponValid = true;
          discountAmount = promo.discount || 0;
        }
      }
    }

    const originalAmount = pack.price || 110;
    let amount = originalAmount;
    let checkoutUrl = '';
    let selectedUrlVar = '';

    if (isCouponValid && discountAmount > 0) {
      amount = Math.max(0, originalAmount - discountAmount);
    } else {
      amount = originalAmount;
      discountAmount = 0;
    }

    if (amount === 99) {
      checkoutUrl = uropayLink99;
      selectedUrlVar = 'UROPAY_LINK_99';
    } else {
      checkoutUrl = uropayLink110;
      selectedUrlVar = 'UROPAY_LINK_110';
    }

    // Server-side logging
    console.log(`[Payment Order Created] Coupon supplied: ${hasCouponSupplied} | Coupon valid: ${isCouponValid} | Selected price: ₹${amount} | Selected URL Var: ${selectedUrlVar}`);

    const buttonId = isCouponValid ? 'NOVEMBER206527' : 'UNIFORM888325';
    const coinsToCredit = 100;

    let transaction = await Transaction.findOne({
      userId,
      type: 'subscription',
      status: 'pending',
      amount
    });

    if (!transaction) {
      transaction = await Transaction.create({
        userId,
        refCode: isCouponValid && promo ? promo.code : null,
        amount,
        type: 'subscription',
        coins: coinsToCredit,
        status: 'pending',
        affiliateId: isCouponValid && affiliate ? affiliate._id : null,
        originalAmount,
        discountAmount: isCouponValid ? discountAmount : 0
      });
    } else {
      transaction.refCode = isCouponValid && promo ? promo.code : null;
      transaction.affiliateId = isCouponValid && affiliate ? affiliate._id : null;
      transaction.originalAmount = originalAmount;
      transaction.discountAmount = isCouponValid ? discountAmount : 0;
      await transaction.save();
    }

    // Create a secure PaymentSession mapped to the transaction._id
    const PaymentSession = mongoose.model('PaymentSession');
    await PaymentSession.findOneAndUpdate(
      { paymentSessionId: transaction._id.toString() },
      {
        paymentSessionId: transaction._id.toString(),
        userId: user._id,
        planId: targetPackageName,
        amount,
        currency: 'INR',
        status: 'pending',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 mins
      },
      { upsert: true }
    );

    res.status(200).json({
      success: true,
      transactionId: transaction._id,
      amount,
      buttonId,
      checkoutUrl,
      couponApplied: isCouponValid,
      couponMessage: hasCouponSupplied && !isCouponValid ? 'Invalid referral code. Standard ₹110 plan applied.' : undefined
    });
  } catch (err) {
    console.error('[Payment Create Order Error]:', err);
    res.status(500).json({ error: 'Failed to initialize payment order.' });
  }
});

// POST /api/payment/test-activate
app.post('/api/payment/test-activate', authenticateToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.isSubscriptionActive = true;
    user.paymentStatus = 'paid';
    user.subscription = {
      active: true,
      plan: 'Premium Dating Pass',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    };

    const coinsToAdd = 100;
    const currentCoins = user.coins !== undefined ? user.coins : (user.credits || 0);
    user.coins = currentCoins + coinsToAdd;
    user.credits = user.coins;
    await user.save();

    res.status(200).json({ success: true, message: 'Subscription activated!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function verifyTransactionWithUroPay(tx) {
  const apiKey = process.env.UROPAY_API_KEY || 'T575R9PTG5BNIGTMC2PSWP396IJCYR2E';

  if (apiKey === 'T575R9PTG5BNIGTMC2PSWP396IJCYR2E') {
    return { status: 'SUCCESS', email: 'dummy_pay@example.com' };
  }

  try {
    const response = await axios.get('https://uropay.in/api/v1/order/status', {
      params: { key: apiKey, note: `Order_${tx._id}` }
    });

    if (response.data && (response.data.status === 'SUCCESS' || response.data.status === 'success')) {
      return response.data;
    }
  } catch (err) {
    console.error('[UroPay API Status Check Error]:', err.message);
  }
  return false;
}

async function activateSubscription(transactionId, paymentEmail, paymentId) {
  if (!mongoose.Types.ObjectId.isValid(transactionId)) {
    console.error(`[Subscription Activation] Invalid transactionId format: ${transactionId}`);
    return false;
  }

  const User = mongoose.model('User');
  const Transaction = mongoose.model('Transaction');
  const Subscription = mongoose.model('Subscription');
  const Payment = mongoose.model('Payment');
  const PaymentSession = mongoose.model('PaymentSession');

  const tx = await Transaction.findById(transactionId);
  if (!tx) {
    console.error(`[Subscription Activation] Transaction ${transactionId} not found.`);
    return false;
  }

  // Idempotency check: unique constraint on transactionId
  const existingSub = await Subscription.findOne({ transactionId: tx._id.toString() });
  if (existingSub) {
    console.log(`[Subscription Activation] Transaction ${transactionId} already processed.`);
    return true;
  }

  // Find payment session using paymentSessionId (transactionId)
  const session = await PaymentSession.findOne({ paymentSessionId: tx._id.toString() });
  const userId = session ? session.userId : tx.userId; // fallback to transaction.userId

  tx.status = 'completed';
  await tx.save();

  // Create Payment record, saving the payment email separately
  await Payment.create({
    transactionId: tx._id.toString(),
    paymentId: paymentId || 'uropay_pay_' + Date.now(),
    userId,
    amount: tx.amount,
    email: paymentEmail || null,
    status: 'completed'
  });

  // Create Subscription record
  const planId = session ? session.planId : 'Premium Dating Pass';
  const durationDays = 30; // 30 days
  const startDate = new Date();
  const endDate = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

  const sub = await Subscription.create({
    userId,
    planId,
    paymentId: paymentId || 'uropay_pay_' + Date.now(),
    transactionId: tx._id.toString(),
    amount: tx.amount,
    status: 'active',
    startDate,
    endDate
  });

  // Sync Mongoose User record status
  const user = await User.findById(userId);
  if (user) {
    user.paymentStatus = 'paid';
    user.isSubscriptionActive = true;
    user.subscription = {
      active: true,
      plan: planId,
      startedAt: startDate,
      expiresAt: endDate
    };

    // Sync payment email to user info
    if (paymentEmail) {
      user.email = paymentEmail.toLowerCase().trim();
      user.emailVerified = true;
    }

    // Credit coins
    const currentCoins = user.coins !== undefined ? user.coins : user.credits;
    user.coins = currentCoins + tx.coins;
    user.credits = user.coins;
    await user.save();
  }

  // Track affiliate commission
  await processAffiliateConversion(tx);

  console.log(`[Subscription Activation] Success for user ${userId}, plan ${planId}`);
  return true;
}

// GET /api/payment/callback
app.get('/api/payment/callback', async (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
    return res.status(400).send('<h3>Invalid checkout callback query configuration.</h3>');
  }

  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).send('<h3>Payment transaction reference not found.</h3>');

    const user = await User.findById(tx.userId);
    if (!user) return res.status(404).send('<h3>User profile not found.</h3>');

    let isCompleted = tx.status === 'completed';

    if (!isCompleted && tx.status === 'pending') {
      const uropayData = await verifyTransactionWithUroPay(tx);
      if (uropayData) {
        const paymentEmail = uropayData.email || uropayData.customer_email || uropayData.payer_email || null;
        await activateSubscription(tx._id.toString(), paymentEmail, null);
        isCompleted = true;
      }
    }

    if (!isCompleted) {
      return res.status(402).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Verification Pending</title>
          <style>
            body { background-color: #0f051e; color: #ffffff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #150d2a; border: 2px solid #ff4a4a; border-radius: 12px; padding: 40px; text-align: center; }
            .btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #ff2a75; color: #fff; text-decoration: none; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>PAYMENT VERIFICATION PENDING</h2>
            <p>We are waiting for payment confirmation from UroPay.</p>
            <a href="/chat.html" class="btn">Back to Chat</a>
          </div>
        </body>
        </html>
      `);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Hub</title>
        <style>
          body { background-color: #0f051e; color: #ffffff; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #150d2a; border: 2px solid #ff4da6; border-radius: 12px; padding: 40px; text-align: center; }
        </style>
        <script>
          localStorage.setItem("paymentStatus", "${user.paymentStatus}");
          localStorage.setItem("credits", "${user.credits}");
          localStorage.setItem("coins", "${user.coins}");
          localStorage.setItem("isSubscriptionActive", "${user.isSubscriptionActive}");
          setTimeout(() => { window.location.href = '/chat.html?payment=success'; }, 2000);
        </script>
      </head>
      <body>
        <div class="card">
          <h2>TRANSACTION COMPLETED</h2>
          <p>Processing transaction tokens into your wallet registry...</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[Payment callback system error]:', err);
    res.status(500).send('<h3>Payment processing error in database registry.</h3>');
  }
});

// POST /api/payment/webhook
app.post('/api/payment/webhook', async (req, res) => {
  const { status, note, email, payment_id } = req.body;

  if (!note || !note.startsWith('Order_')) {
    return res.status(400).json({ error: 'Invalid note parameter.' });
  }

  const transactionId = note.split('_')[1];
  if (!transactionId || !mongoose.Types.ObjectId.isValid(transactionId)) {
    return res.status(400).json({ error: 'Invalid transaction ID format.' });
  }

  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found.' });

    // Verify webhook authenticity via server-side status check
    const uropayData = await verifyTransactionWithUroPay(tx);
    if (!uropayData) {
      return res.status(400).json({ error: 'Webhook payment verification failed.' });
    }

    if (status === 'SUCCESS' || status === 'success') {
      const paymentEmail = email || uropayData.email || uropayData.customer_email || uropayData.payer_email || null;
      await activateSubscription(tx._id.toString(), paymentEmail, payment_id);
      return res.status(200).json({ success: true });
    } else {
      tx.status = 'failed';
      await tx.save();
      return res.status(200).json({ success: true, message: 'Transaction marked failed.' });
    }
  } catch (err) {
    console.error('[Payment Webhook Error]:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/logout
app.post('/api/logout', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    mixpanelService.track('Session Ended', userId);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Logout track error]:', err);
    res.status(500).json({ error: 'Failed to track logout.' });
  }
});

// POST /api/track-click
app.post('/api/track-click', async (req, res) => {
  const { refCode, sessionId } = req.body;
  if (!refCode) {
    return res.status(400).json({ error: 'Referral tracking code is required.' });
  }

  try {
    const promo = await PromoCode.findOne({ code: refCode.toUpperCase().trim() });
    const affiliateId = promo ? promo.affiliateId : null;

    let userId = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.split(' ')[1]) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
      } catch (err) { }
    }

    await TrafficLog.create({
      refCode: refCode.toUpperCase().trim(),
      ip: req.ip || req.headers['x-forwarded-for'],
      affiliateId,
      userId,
      sessionId: sessionId || null
    });

    if (affiliateId) {
      await AffiliatePartner.findByIdAndUpdate(affiliateId, { $inc: { totalClicks: 1 } });
    }

    res.status(200).json({ success: true, message: 'Click tracked.', affiliateId });
  } catch (err) {
    console.error('[Track click error]:', err);
    res.status(500).json({ error: 'Failed to record referral click.' });
  }
});

// -------------------------------------------------------------
// Admin Affiliate Tracking API Endpoints
// -------------------------------------------------------------

app.get('/api/admin/affiliates/dashboard', authenticateAdmin, async (req, res) => {
  const { range } = req.query;

  try {
    const totalAffiliates = await AffiliatePartner.countDocuments();
    const clickQuery = getDateFilterQuery(range, 'timestamp');
    const totalClicks = await TrafficLog.countDocuments({ ...clickQuery, affiliateId: { $ne: null } });

    const codeUseQuery = getDateFilterQuery(range, 'timestamp');
    const totalCodeUses = await AffiliateCodeUse.countDocuments(codeUseQuery);

    const conversionQuery = getDateFilterQuery(range, 'createdAt');
    const activeConversions = await AffiliateConversion.find({
      ...conversionQuery,
      status: { $ne: 'reversed' }
    });

    const paidConversions = await AffiliateConversion.find({
      ...conversionQuery,
      status: 'paid'
    });

    const pendingConversions = await AffiliateConversion.find({
      ...conversionQuery,
      status: { $in: ['earned', 'pending'] }
    });

    const totalSuccessfulPurchases = activeConversions.length;
    const totalRevenue = activeConversions.reduce((sum, c) => sum + c.amountPaid, 0);
    const totalCommissionEarned = activeConversions.reduce((sum, c) => sum + c.commissionAmount, 0);
    const totalCommissionPaid = paidConversions.reduce((sum, c) => sum + c.commissionAmount, 0);
    const totalCommissionPending = pendingConversions.reduce((sum, c) => sum + c.commissionAmount, 0);

    res.status(200).json({
      totalAffiliates,
      totalClicks,
      totalCodeUses,
      totalSuccessfulPurchases,
      totalRevenue,
      totalCommissionEarned,
      totalCommissionPaid,
      totalCommissionPending
    });
  } catch (err) {
    console.error('[Admin Dashboard Stats Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve admin dashboard stats.' });
  }
});

app.get('/api/admin/affiliates', authenticateAdmin, async (req, res) => {
  const { range } = req.query;

  try {
    const partners = await AffiliatePartner.find({}).sort({ createdAt: -1 }).lean();
    const resultPartners = [];

    for (const partner of partners) {
      const codes = await PromoCode.find({ affiliateId: partner._id });
      const codeNames = codes.map(c => c.code);

      const clickQuery = getDateFilterQuery(range, 'timestamp');
      const clicks = await TrafficLog.countDocuments({ ...clickQuery, affiliateId: partner._id });

      const codeUseQuery = getDateFilterQuery(range, 'timestamp');
      const uniqueUsersList = await AffiliateCodeUse.distinct('customerUserId', {
        ...codeUseQuery,
        affiliateId: partner._id
      });

      const conversionQuery = getDateFilterQuery(range, 'createdAt');
      const partnerConversions = await AffiliateConversion.find({
        ...conversionQuery,
        affiliateId: partner._id,
        status: { $ne: 'reversed' }
      });

      const partnerPaidConversions = await AffiliateConversion.find({
        ...conversionQuery,
        affiliateId: partner._id,
        status: 'paid'
      });

      const partnerPendingConversions = await AffiliateConversion.find({
        ...conversionQuery,
        affiliateId: partner._id,
        status: { $in: ['earned', 'pending'] }
      });

      resultPartners.push({
        ...partner,
        codes: codeNames,
        totalClicks: clicks,
        totalCodeUses: uniqueUsersList.length,
        totalSuccessfulPurchases: partnerConversions.length,
        totalRevenue: partnerConversions.reduce((sum, c) => sum + c.amountPaid, 0),
        totalCommissionEarned: partnerConversions.reduce((sum, c) => sum + c.commissionAmount, 0),
        totalCommissionPaid: partnerPaidConversions.reduce((sum, c) => sum + c.commissionAmount, 0),
        totalCommissionPending: partnerPendingConversions.reduce((sum, c) => sum + c.commissionAmount, 0)
      });
    }

    res.status(200).json(resultPartners);
  } catch (err) {
    console.error('[Admin Get Affiliates Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve affiliate partners.' });
  }
});

app.post('/api/admin/affiliates', authenticateAdmin, async (req, res) => {
  const { name, instagramUsername, instagramUrl, email, phone, commissionPercent, status, notes, userId } = req.body;
  if (!name || !instagramUsername || !instagramUrl || !email) {
    return res.status(400).json({ error: 'Name, Instagram Username, Instagram URL, and Email are required.' });
  }

  try {
    const partner = await AffiliatePartner.create({
      name,
      instagramUsername,
      instagramUrl,
      email,
      phone: phone || null,
      commissionPercent: commissionPercent || 0,
      status: status || 'active',
      notes: notes || "",
      userId: userId || null
    });
    res.status(201).json(partner);
  } catch (err) {
    console.error('[Admin Create Affiliate Error]:', err);
    res.status(500).json({ error: 'Failed to create affiliate partner.' });
  }
});

app.get('/api/admin/affiliates/:id', authenticateAdmin, async (req, res) => {
  try {
    const partner = await AffiliatePartner.findById(req.params.id).lean();
    if (!partner) return res.status(404).json({ error: 'Affiliate partner not found.' });

    const codes = await PromoCode.find({ affiliateId: partner._id });
    const payouts = await AffiliatePayout.find({ affiliateId: partner._id }).sort({ createdAt: -1 });
    const conversions = await AffiliateConversion.find({ affiliateId: partner._id }).sort({ createdAt: -1 }).lean();

    for (const conv of conversions) {
      const client = await User.findById(conv.customerUserId).select('username email');
      conv.customer = client ? { username: client.username, email: client.email } : { username: 'Unknown User', email: '' };
    }

    async function getPeriodMetrics(affiliateId, range) {
      const clickQuery = getDateFilterQuery(range, 'timestamp');
      const codeUseQuery = getDateFilterQuery(range, 'timestamp');
      const conversionQuery = getDateFilterQuery(range, 'createdAt');

      const uniqueUsersList = await AffiliateCodeUse.distinct('customerUserId', { ...codeUseQuery, affiliateId });
      const activeConversions = await AffiliateConversion.find({ ...conversionQuery, affiliateId, status: { $ne: 'reversed' } });

      return {
        users: uniqueUsersList.length,
        purchases: activeConversions.length,
        revenue: activeConversions.reduce((sum, c) => sum + c.amountPaid, 0)
      };
    }

    const performanceSummary = {
      today: await getPeriodMetrics(partner._id, 'today'),
      last7: await getPeriodMetrics(partner._id, '7days'),
      last30: await getPeriodMetrics(partner._id, '30days'),
      allTime: await getPeriodMetrics(partner._id, 'all')
    };

    res.status(200).json({
      partner,
      codes: codes.map(c => c.code),
      payouts,
      conversions,
      performanceSummary
    });
  } catch (err) {
    console.error('[Admin Get Affiliate Detail Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve affiliate details.' });
  }
});

app.get('/api/admin/promocodes', authenticateAdmin, async (req, res) => {
  try {
    const promocodes = await PromoCode.find({}).sort({ createdAt: -1 }).lean();
    for (const pc of promocodes) {
      if (pc.affiliateId) {
        const partner = await AffiliatePartner.findById(pc.affiliateId);
        pc.partner = partner ? {
          name: partner.name,
          instagramUsername: partner.instagramUsername,
          commissionPercent: partner.commissionPercent
        } : null;
      } else {
        pc.partner = null;
      }
    }
    res.status(200).json(promocodes);
  } catch (err) {
    console.error('[Admin Get Promo Codes Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve promo codes.' });
  }
});

app.post('/api/admin/promocodes', authenticateAdmin, async (req, res) => {
  const { code, discount, affiliateId, commissionPercent, isActive } = req.body;
  if (!code || discount === undefined) {
    return res.status(400).json({ error: 'Promo code and discount amount are required.' });
  }

  try {
    let targetCommission = commissionPercent;
    if (affiliateId && targetCommission === undefined) {
      const partner = await AffiliatePartner.findById(affiliateId);
      if (partner) targetCommission = partner.commissionPercent;
    }

    const newPromo = await PromoCode.findOneAndUpdate(
      { code: code.toUpperCase().trim() },
      {
        code: code.toUpperCase().trim(),
        discount,
        affiliateId: affiliateId || null,
        commissionPercent: targetCommission || 0,
        isActive: isActive !== undefined ? isActive : true,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.status(200).json(newPromo);
  } catch (err) {
    console.error('[Admin Create/Assign Promo Error]:', err);
    res.status(500).json({ error: 'Failed to create or assign promo code.' });
  }
});

app.post('/api/admin/promocodes/:code/toggle', authenticateAdmin, async (req, res) => {
  const { code } = req.params;
  const { isActive } = req.body;

  try {
    const promo = await PromoCode.findOneAndUpdate(
      { code: code.toUpperCase().trim() },
      { isActive: !!isActive, updatedAt: new Date() },
      { new: true }
    );
    if (!promo) return res.status(404).json({ error: 'Promo code not found.' });
    res.status(200).json(promo);
  } catch (err) {
    console.error('[Admin Toggle Promo Code Error]:', err);
    res.status(500).json({ error: 'Failed to toggle promo code state.' });
  }
});

app.post('/api/admin/payouts', authenticateAdmin, async (req, res) => {
  const { affiliateId, amount, notes } = req.body;
  if (!affiliateId || amount === undefined || amount <= 0) {
    return res.status(400).json({ error: 'Affiliate ID and a positive payout amount are required.' });
  }

  try {
    const partner = await AffiliatePartner.findById(affiliateId);
    if (!partner) return res.status(404).json({ error: 'Affiliate partner not found.' });

    const payout = await AffiliatePayout.create({
      affiliateId,
      amount,
      notes: notes || "",
      status: 'pending'
    });

    res.status(201).json(payout);
  } catch (err) {
    console.error('[Admin Create Payout Error]:', err);
    res.status(500).json({ error: 'Failed to create payout record.' });
  }
});

app.post('/api/admin/payouts/:id/pay', authenticateAdmin, async (req, res) => {
  const { paymentMethod, paymentReference } = req.body;

  try {
    const payout = await AffiliatePayout.findById(req.params.id);
    if (!payout) return res.status(404).json({ error: 'Payout record not found.' });

    if (payout.status === 'paid') {
      return res.status(400).json({ error: 'Payout is already completed.' });
    }

    payout.status = 'paid';
    payout.paymentMethod = paymentMethod || 'UPI';
    payout.paymentReference = paymentReference || '';
    payout.paidAt = new Date();
    await payout.save();

    const partner = await AffiliatePartner.findById(payout.affiliateId);
    if (partner) {
      partner.totalCommissionPending = Math.max(0, partner.totalCommissionPending - payout.amount);
      partner.totalCommissionPaid += payout.amount;
      await partner.save();
    }

    res.status(200).json(payout);
  } catch (err) {
    console.error('[Admin Complete Payout Error]:', err);
    res.status(500).json({ error: 'Failed to complete payout processing.' });
  }
});

app.post('/api/admin/conversions/:transactionId/reverse', authenticateAdmin, async (req, res) => {
  const { transactionId } = req.params;
  const { reason } = req.body;

  try {
    await reverseAffiliateConversion(transactionId, reason || 'Refund/Reversal requested by Admin.');
    res.status(200).json({ success: true, message: 'Commission conversion reversed successfully.' });
  } catch (err) {
    console.error('[Admin Reverse Conversion Error]:', err);
    res.status(500).json({ error: 'Failed to reverse commission conversion.' });
  }
});

// GET /api/user/dashboard
app.get('/api/user/dashboard', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    // Look up active subscription in database
    const Subscription = mongoose.model('Subscription');
    const activeSub = await Subscription.findOne({
      userId: user._id,
      status: 'active',
      endDate: { $gt: new Date() }
    });

    const isSubActive = !!activeSub;
    const planName = activeSub ? activeSub.planId : (user.subscription && user.subscription.active ? user.subscription.plan : 'None');
    const startDate = activeSub ? activeSub.startDate : (user.subscription && user.subscription.active ? user.subscription.startedAt : null);
    const endDate = activeSub ? activeSub.endDate : (user.subscription && user.subscription.active ? user.subscription.expiresAt : null);

    res.status(200).json({
      success: true,
      username: user.username,
      email: user.email || 'None',
      emailVerified: user.emailVerified,
      plan: planName || 'None',
      subscriptionStatus: isSubActive ? 'Active' : 'Inactive',
      startDate: startDate ? new Date(startDate).toISOString().split('T')[0] : 'N/A',
      endDate: endDate ? new Date(endDate).toISOString().split('T')[0] : 'N/A'
    });
  } catch (err) {
    console.error('[Get Dashboard Error]:', err);
    res.status(500).json({ error: 'Failed to retrieve account dashboard statistics.' });
  }
});

// GET /api/admin/payments/search (Admin Payment Recovery Search)
app.get('/api/admin/payments/search', authenticateAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Search query parameter (q) is required.' });
  }

  try {
    const queryStr = String(q).trim();
    
    // Find matching users if q is a username
    const matchedUsers = await User.find({
      username: { $regex: new RegExp(queryStr, 'i') }
    });
    const matchedUserIds = matchedUsers.map(u => u._id);

    const Payment = mongoose.model('Payment');
    const Subscription = mongoose.model('Subscription');

    // Search payments
    const payments = await Payment.find({
      $or: [
        { transactionId: queryStr },
        { paymentId: queryStr },
        { email: { $regex: new RegExp(queryStr, 'i') } },
        { userId: { $in: matchedUserIds } }
      ]
    }).populate('userId', 'username email');

    // Search subscriptions
    const subscriptions = await Subscription.find({
      $or: [
        { transactionId: queryStr },
        { paymentId: queryStr },
        { userId: { $in: matchedUserIds } }
      ]
    }).populate('userId', 'username email');

    res.status(200).json({ success: true, payments, subscriptions });
  } catch (err) {
    console.error('[Admin Payment Search Error]:', err);
    res.status(500).json({ error: 'Failed to query payments registry.' });
  }
});

// POST /api/admin/payments/associate (Admin Manual Payment Linkage)
app.post('/api/admin/payments/associate', authenticateAdmin, async (req, res) => {
  const { transactionId, targetUserId } = req.body;
  if (!transactionId || !targetUserId) {
    return res.status(400).json({ error: 'Transaction ID and Target User ID are required.' });
  }

  try {
    const user = await User.findById(targetUserId);
    if (!user) return res.status(404).json({ error: 'Target user not found.' });

    const Payment = mongoose.model('Payment');
    const Subscription = mongoose.model('Subscription');
    const PaymentSession = mongoose.model('PaymentSession');

    // Update payment
    const payment = await Payment.findOneAndUpdate(
      { transactionId },
      { $set: { userId: user._id } },
      { new: true }
    );

    // Update or create subscription
    let subscription = await Subscription.findOne({ transactionId });
    if (subscription) {
      subscription.userId = user._id;
      subscription.status = 'active';
      await subscription.save();
    } else {
      const session = await PaymentSession.findOne({ paymentSessionId: transactionId });
      const amount = session ? session.amount : 110;
      const planId = session ? session.planId : 'Premium Dating Pass';

      subscription = await Subscription.create({
        userId: user._id,
        planId,
        transactionId,
        amount,
        status: 'active',
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      });
    }

    // Sync User record status
    user.paymentStatus = 'paid';
    user.isSubscriptionActive = true;
    user.subscription = {
      active: true,
      plan: subscription.planId,
      startedAt: subscription.startDate,
      expiresAt: subscription.endDate
    };
    await user.save();

    res.status(200).json({ success: true, message: 'Payment associated successfully.', payment, subscription });
  } catch (err) {
    console.error('[Admin Payment Association Error]:', err);
    res.status(500).json({ error: 'Failed to associate payment.' });
  }
});

// POST /api/admin/login (Admin Portal Login)
app.post('/api/admin/login', rateLimiter(10, 60 * 1000, 'Too many login attempts. Please try again in a minute.'), async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const safeUsername = String(username).trim();
  const safePassword = String(password);

  try {
    const User = mongoose.model('User');
    const user = await User.findOne({ username: safeUsername });

    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Access denied. Incorrect administrator credentials.' });
    }

    const isMatch = await bcrypt.compare(safePassword, user.passwordHash || '');
    if (!isMatch) {
      return res.status(401).json({ error: 'Access denied. Incorrect administrator credentials.' });
    }

    const token = jwt.sign(
      { userId: user._id, username: user.username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.setHeader('Set-Cookie', `token=${token}; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax`);

    res.status(200).json({
      success: true,
      token,
      redirect: '/admin/dashboard'
    });
  } catch (err) {
    console.error('[Admin Login Error]:', err);
    res.status(500).json({ error: 'System failure processing admin authentication.' });
  }
});

// POST /api/admin/logout (Admin Logout API)
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token');
  res.setHeader('Set-Cookie', 'token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax');
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

// POST /api/admin/change-password (Admin Password Management)
app.post('/api/admin/change-password', authenticateAdmin, async (req, res) => {
  const { newPassword, confirmPassword } = req.body;

  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: 'New password and confirm password are required.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'New passwords do not match.' });
  }

  try {
    const User = mongoose.model('User');
    const user = await User.findById(req.user.userId);

    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Admin password updated successfully.'
    });
  } catch (err) {
    console.error('[Admin Password Change Error]:', err);
    res.status(500).json({ error: 'System failure updating admin password.' });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Cyber Server listening at: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});