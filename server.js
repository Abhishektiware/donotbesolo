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

// STATIC ASSETS MIDDLEWARE (After dynamic HTML routes)
app.use(express.static(path.join(__dirname, 'public')));
// Ensure uploads folder exists in root (not in public for high security)
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
  .then(() => {
    console.log('Connected to MongoDB Cloud Database.');
    seedPromoCodes();
    seedStorePackages();
  })
  .catch(err => {
    console.error('MongoDB Cloud connection authentication/network failure. Trying local MongoDB...');
    mongoose.disconnect().then(() => {
      mongoose.connect(localMongoUri)
        .then(() => {
          console.log('Connected successfully to local MongoDB instance (mongodb://127.0.0.1:27017/donotbesolo).');
          seedPromoCodes();
          seedStorePackages();
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
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  emailVerified: { type: Boolean, default: false },
  credits: { type: Number, default: 20 },
  coins: { type: Number, default: 20 },
  referredBy: { type: String, default: null },
  paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },
  isSubscriptionActive: { type: Boolean, default: false },
  chatCount: { type: Number, default: 0 },
  teasingStatus: { type: String, default: 'none' }, // 'none', 'teasing_photo', 'teasing_voice'
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

// 1.1 Memory Schema for Persistent Conversation Memory System
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

// 1.25 Pending User Schema (For registration OTP flow)
const pendingUserSchema = new mongoose.Schema({
  fullname: { type: String, required: true },
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // hashed password
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  referredBy: { type: String, default: null },
  attempts: { type: Number, default: 0 },
  lastResentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, expires: 600 } // TTL 10 mins fallback
});
const PendingUser = mongoose.model('PendingUser', pendingUserSchema);

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

// 2. OTP Schema (Expires in 10 minutes)
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
  timestamp: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

// 5. Media Schema (24 Hour TTL index)
const mediaSchema = new mongoose.Schema({
  mediaId: { type: String, required: true, unique: true },
  mediaType: { type: String, enum: ['image', 'voice'], required: true },
  filePath: { type: String, required: true },
  isLocked: { type: Boolean, default: true },
  unlockedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now }
});
// Expire index for automatic document cleanup after 24h
mediaSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
const Media = mongoose.model('Media', mediaSchema);

// 6. PromoCode Schema
const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  discount: { type: Number, required: true },
  isActive: { type: Boolean, default: true }
});
const PromoCode = mongoose.model('PromoCode', promoCodeSchema);

// StorePackage Schema
const storePackageSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  coins: { type: Number, default: 0 },
  type: { type: String, enum: ['subscription', 'coins'], required: true },
  available: { type: Boolean, default: true }
});
const StorePackage = mongoose.model('StorePackage', storePackageSchema);

// PromoCode Seeder
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

// StorePackage Seeder
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

// Background cleanup routine for expired physical media files (runs hourly)
async function cleanExpiredPhysicalFiles() {
  try {
    const activeMediaInDb = await Media.find({}, { filePath: 1 });
    const activePaths = new Set(activeMediaInDb.map(m => path.resolve(m.filePath)));
    
    fs.readdir(UPLOADS_DIR, (err, files) => {
      if (err) return console.error('[Cleanup] Error reading uploads folder:', err);
      
      files.forEach(file => {
        const fullPath = path.join(UPLOADS_DIR, file);
        // Exclude gitkeep or hidden files
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

// Transporter for Nodemailer OTP delivery
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

// Root Landing Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// POST /api/send-otp
app.post('/api/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    // Check if user already exists
    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ error: 'Email address is already registered in the grid.' });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    // Save OTP to DB (overwrites or appends, TTL handles removal)
    await OTP.create({ email, otpCode });

    // Cyberpunk HTML Email Template
    const emailHtml = `
      <div style="background-color: #0f051e; color: #ffffff; font-family: 'Rajdhani', 'Outfit', sans-serif; padding: 40px; border-radius: 8px; border: 2px solid #ff4da6; text-align: center; max-width: 500px; margin: 0 auto; box-shadow: 0 0 20px #8a2be2;">
        <h1 style="color: #ff4da6; text-shadow: 0 0 10px #ff4da6; margin-bottom: 20px; font-size: 28px;">DONOTBESOLO</h1>
        <p style="font-size: 16px; color: #b8b3e8; line-height: 1.5;">Welcome to the cyber grid. Use the security verification code below to authorize your session:</p>
        <div style="background: rgba(21, 13, 42, 0.8); border: 1px solid #8a2be2; border-radius: 4px; padding: 15px; font-size: 36px; font-weight: bold; letter-spacing: 5px; color: #00f0ff; text-shadow: 0 0 10px #00f0ff; margin: 30px auto; width: fit-content;">
          ${otpCode}
        </div>
        <p style="font-size: 12px; color: #6a629b; margin-top: 30px;">This OTP will expire in 10 minutes. If you did not request this, ignore this system log.</p>
      </div>
    `;

    const mailOptions = {
      from: `"DONOTBESOLO Security" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: '🔑 Session Access Authorization Code - DONOTBESOLO',
      html: emailHtml
    };

    // Attempt sending SMTP mail, fall back to console print
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log('\n======================================================');
        console.log(`[LOCAL DEV OTP LOG] SMTP connection skipped or failed.`);
        console.log(`[TARGET EMAIL]      ${email}`);
        console.log(`[VERIFICATION CODE] ${otpCode}`);
        console.log('======================================================\n');
        return res.status(200).json({ success: true, devMode: true, message: 'OTP logged to server console for testing.' });
      }
      console.log(`[OTP Sent via Email] Message ID: ${info.messageId}`);
      res.status(200).json({ success: true, message: 'OTP code sent to email.' });
    });

  } catch (err) {
    console.error('[OTP Error]:', err);
    res.status(500).json({ error: 'Failed to trigger verification code.' });
  }
});

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { fullname, username, email, password, referredBy } = req.body;

  if (!fullname || !username || !email || !password) {
    return res.status(400).json({ error: 'All registration parameters are required.' });
  }

  try {
    // 1. Check existence in real User DB
    const userExists = await User.findOne({ $or: [{ email }, { username }] });
    if (userExists) {
      return res.status(400).json({ error: 'Username or email is already registered in the grid.' });
    }

    // 2. Hash Password beforehand to store securely in pending registry
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Generate 6-digit OTP code
    const otp = otpService.generateOtp();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes expiry

    // 4. Save or overwrite pending registration details
    await PendingUser.deleteOne({ email });
    await PendingUser.create({
      fullname,
      username,
      email,
      password: hashedPassword,
      otp,
      expiresAt,
      referredBy: referredBy || null
    });

    // 5. Send verification OTP email via SMTP
    try {
      await emailService.sendOtpEmail(email, otp, 5);
    } catch (err) {
      console.error('Failed to send SMTP email (signup):', err);
      // Local development fallback
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEV FALLBACK] Verification Code for ${email}: ${otp}`);
        return res.status(200).json({
          success: true,
          message: 'OTP generated and logged to server console (SMTP skipped).',
          devMode: true
        });
      }
      return res.status(500).json({ error: 'Failed to send OTP verification email. Please check server config.' });
    }

    res.status(200).json({
      success: true,
      message: 'OTP verification code sent to your email.'
    });

  } catch (err) {
    console.error('[Signup Error]:', err);
    res.status(500).json({ error: 'System error during signup initialization.' });
  }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and verification code (OTP) are required.' });
  }

  try {
    const pending = await PendingUser.findOne({ email });
    if (!pending) {
      return res.status(404).json({ error: 'No pending registration found for this email.' });
    }

    // Check maximum failed verification attempts (security)
    if (pending.attempts >= 5) {
      return res.status(400).json({ error: 'Too many failed verification attempts. Please sign up again.' });
    }

    // Check code expiry
    if (new Date() > pending.expiresAt) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Compare OTP codes
    if (pending.otp !== otp) {
      pending.attempts += 1;
      await pending.save();
      return res.status(400).json({ error: 'Invalid verification code.' });
    }

    // Correct OTP: Create the real user account
    // 1. Double check username/email in real User DB to prevent race conditions
    const userExists = await User.findOne({ $or: [{ email: pending.email }, { username: pending.username }] });
    if (userExists) {
      return res.status(400).json({ error: 'Username or email is already registered.' });
    }

    // 2. Check Referrer and grant reward
    let initialCredits = 20;
    if (pending.referredBy) {
      const referrer = await User.findOne({ username: pending.referredBy });
      if (referrer) {
        referrer.credits += 50; // reward referrer
        await referrer.save();
        
        // Log transaction for referrer
        await Transaction.create({
          userId: referrer._id,
          refCode: pending.referredBy,
          amount: 0,
          type: 'coins',
          coins: 50,
          status: 'completed'
        });
      }
    }

    // 3. Create the real user with emailVerified = true
    const newUser = await User.create({
      fullname: pending.fullname,
      username: pending.username,
      email: pending.email,
      password: pending.password, // already hashed
      emailVerified: true,
      credits: initialCredits,
      coins: initialCredits,
      referredBy: pending.referredBy || null,
      paymentStatus: 'unpaid',
      isSubscriptionActive: false
    });

    // 4. Generate Session Token
    const token = jwt.sign({ userId: newUser._id, username: newUser.username }, JWT_SECRET, { expiresIn: '7d' });

    // 5. Track Mixpanel Signup Events
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

    // 6. Delete temporary OTP data
    await PendingUser.deleteOne({ _id: pending._id });

    res.status(201).json({
      success: true,
      token,
      userId: newUser._id,
      credits: newUser.credits,
      redirect: "/index.html"
    });

  } catch (err) {
    console.error('[Verify OTP Error]:', err);
    res.status(500).json({ error: 'System error during OTP verification.' });
  }
});

// POST /api/resend-otp
app.post('/api/resend-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email address is required.' });
  }

  try {
    const pending = await PendingUser.findOne({ email });
    if (!pending) {
      return res.status(404).json({ error: 'No pending registration found for this email.' });
    }

    // Cooldown check: Maximum one resend every 60 seconds
    const now = new Date();
    if (pending.lastResentAt && (now - pending.lastResentAt) < 60 * 1000) {
      const waitSeconds = Math.ceil((60 * 1000 - (now - pending.lastResentAt)) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting a new code.` });
    }

    // Generate new OTP, replace previous, and extend expiry
    const newOtp = otpService.generateOtp();
    pending.otp = newOtp;
    pending.expiresAt = new Date(Date.now() + 5 * 60 * 1000); // extend by 5 minutes
    pending.lastResentAt = now;
    pending.attempts = 0; // Reset verification attempts
    await pending.save();

    // Send the new OTP email
    try {
      await emailService.sendOtpEmail(email, newOtp, 5);
    } catch (err) {
      console.error('Failed to send SMTP email (resend):', err);
      // Local development fallback
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[DEV FALLBACK] Resent Verification Code for ${email}: ${newOtp}`);
        return res.status(200).json({
          success: true,
          message: 'New OTP generated and logged to server console (SMTP skipped).',
          devMode: true
        });
      }
      return res.status(500).json({ error: 'Failed to send OTP verification email. Please check server config.' });
    }

    res.status(200).json({ success: true, message: 'New security verification code sent.' });

  } catch (err) {
    console.error('[Resend OTP Error]:', err);
    res.status(500).json({ error: 'System failed to resend verification code.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Identifier and password credentials required.' });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: usernameOrEmail }, { username: usernameOrEmail }]
    });

    if (!user) {
      return res.status(400).json({ error: 'Credentials not found in the grid.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Access denied. Incorrect security credentials.' });
    }

    // Check if email has been verified
    if (user.emailVerified !== true) {
      return res.status(400).json({ error: 'Please verify your email first.' });
    }

    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    mixpanelService.track('User Logged In', user._id, {
      username: user.username
    });

    res.status(200).json({
      success: true,
      token,
      userId: user._id,
      username: user.username,
      credits: user.credits,
      paymentStatus: user.paymentStatus,
      redirect: "/index.html"
    });

  } catch (err) {
    console.error('[Signup Error]:', err);
    res.status(500).json({ error: 'System error during user account generation.' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Identifier and password credentials required.' });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: usernameOrEmail }, { username: usernameOrEmail }]
    });

    if (!user) {
      return res.status(400).json({ error: 'Credentials not found in the grid.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Access denied. Incorrect security credentials.' });
    }

    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    mixpanelService.track('User Logged In', user._id, {
      username: user.username
    });

    res.status(200).json({
      success: true,
      token,
      userId: user._id,
      username: user.username,
      credits: user.credits,
      paymentStatus: user.paymentStatus,
      redirect: "/index.html"
    });

  } catch (err) {
    console.error('[Login Error]:', err);
    res.status(500).json({ error: 'System failure verifying database login.' });
  }
});

// POST /api/send-reset-otp
app.post('/api/send-reset-otp', async (req, res) => {
  const { usernameOrEmail } = req.body;
  if (!usernameOrEmail) {
    return res.status(400).json({ error: 'Username or email required to recover account.' });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: usernameOrEmail }, { username: usernameOrEmail }]
    });
    if (!user) {
      return res.status(404).json({ error: 'No account matching credentials found.' });
    }

    // Call inner OTP logic
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await OTP.create({ email: user.email, otpCode });

    const emailHtml = `
      <div style="background-color: #0f051e; color: #ffffff; font-family: 'Rajdhani', 'Outfit', sans-serif; padding: 40px; border-radius: 8px; border: 2px solid #8a2be2; text-align: center; max-width: 500px; margin: 0 auto; box-shadow: 0 0 20px #ff4da6;">
        <h1 style="color: #00f0ff; text-shadow: 0 0 10px #00f0ff; margin-bottom: 20px; font-size: 28px;">PASSWORD RECOVERY</h1>
        <p style="font-size: 16px; color: #b8b3e8;">Use this code to verify your identity and restore access to your account:</p>
        <div style="background: rgba(21, 13, 42, 0.8); border: 1px solid #ff4da6; border-radius: 4px; padding: 15px; font-size: 36px; font-weight: bold; letter-spacing: 5px; color: #ff4da6; text-shadow: 0 0 10px #ff4da6; margin: 30px auto; width: fit-content;">
          ${otpCode}
        </div>
        <p style="font-size: 12px; color: #6a629b;">Valid for 10 minutes only. If you didn't initiate this, reset your login passwords immediately.</p>
      </div>
    `;

    const mailOptions = {
      from: `"DONOTBESOLO Security" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: '🔑 Recovery Authorization Code - DONOTBESOLO',
      html: emailHtml
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log('\n======================================================');
        console.log(`[LOCAL DEV RESET OTP LOG] SMTP connection skipped or failed.`);
        console.log(`[TARGET EMAIL]            ${user.email}`);
        console.log(`[VERIFICATION CODE]       ${otpCode}`);
        console.log('======================================================\n');
        return res.status(200).json({ success: true, devMode: true, message: 'Recovery code logged to console.' });
      }
      res.status(200).json({ success: true, message: 'Recovery code dispatched to registered mail.' });
    });

  } catch (err) {
    console.error('[Reset OTP Error]:', err);
    res.status(500).json({ error: 'System failed to register reset parameters.' });
  }
});

// POST /api/reset-password
app.post('/api/reset-password', async (req, res) => {
  const { usernameOrEmail, otpCode, newPassword } = req.body;

  if (!usernameOrEmail || !otpCode || !newPassword) {
    return res.status(400).json({ error: 'All fields are required to update credentials.' });
  }

  try {
    const user = await User.findOne({
      $or: [{ email: usernameOrEmail }, { username: usernameOrEmail }]
    });

    if (!user) {
      return res.status(404).json({ error: 'Account registry not found.' });
    }

    const latestOtp = await OTP.findOne({ email: user.email }).sort({ createdAt: -1 });
    if (!latestOtp || latestOtp.otpCode !== otpCode) {
      return res.status(400).json({ error: 'Invalid or expired security validation code.' });
    }

    // Update password
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    // Remove OTP code
    await OTP.deleteOne({ _id: latestOtp._id });

    res.status(200).json({ success: true, message: 'Cybernetic credentials updated successfully.' });

  } catch (err) {
    console.error('[Reset password Error]:', err);
    res.status(500).json({ error: 'Security engine failed to rehash password credentials.' });
  }
});

const COMPANIONS = personalityService.COMPANIONS;

// Fallback Mock Responses matching user personality selection

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

// GET /api/chat/history
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
      
      const togetherApiKey = process.env.TOGETHER_API_KEY;
      const isTogetherKeyValid = togetherApiKey && !togetherApiKey.includes('placeholder');

      if (isTogetherKeyValid) {
        try {
          const sysPrompt = `You are a 20-year-old ${gender} companion named ${companionName} in a cyberpunk universe. You have a ${vibe} personality.
Write a warm, engaging, and highly personalized introductory message to the user who has just opened the chat for the first time. Keep it strictly 1 to 2 short sentences.
Response language: ${language === 'Hinglish' ? 'Hinglish (mix of Hindi written in Latin script and English - e.g., "Main theek hoon, you tell how are you?")' : language} (Write strictly in the specified language, matching the vibe. If Hinglish, do not use Devanagari script).
Never write warnings, meta-text, or break character. Keep it flirty/playful/supportive according to your ${vibe} vibe.`;

          const togetherModel = (!process.env.TEXT_MODEL || process.env.TEXT_MODEL.startsWith('key_') || !process.env.TEXT_MODEL.includes('/'))
            ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
            : process.env.TEXT_MODEL;

          const togetherRes = await axios.post('https://api.together.xyz/v1/chat/completions', {
            model: togetherModel,
            messages: [
              { role: 'system', content: sysPrompt },
              { role: 'user', content: 'Greet me for the first time.' }
            ],
            max_tokens: 80,
            temperature: 0.8
          }, {
            headers: { Authorization: `Bearer ${togetherApiKey}` },
            timeout: 8000
          });

          welcomeMsg = togetherRes.data.choices[0].message.content.trim();
        } catch (apiErr) {
          console.error('[Together AI Welcome Greeting Error]:', apiErr.message);
        }
      }

      if (!welcomeMsg) {
        if (language === 'Hinglish') {
          welcomeMsg = "Hey! Aur batao, kaise ho? I've been waiting for you! ❤️";
        } else if (language === 'Spanish') {
          welcomeMsg = "¡Hola! He estado esperando tu mensaje. ¿Cómo estás? 😊";
        } else if (language === 'French') {
          welcomeMsg = "Salut! J'attendais ton message. Comment ça va? 😊";
        } else if (language === 'Japanese') {
          welcomeMsg = "こんにちは！メッセージを待っていました。元気？ 😊";
        } else if (language === 'German') {
          welcomeMsg = "Hallo! Ich habe auf deine Nachricht gewartet. Wie geht es dir? 😊";
        } else {
          welcomeMsg = "Hey! I've been waiting for you. How was your day? ❤️";
        }
      }

      conversation.history.push({
        role: 'assistant',
        content: welcomeMsg,
        timestamp: new Date()
      });
      await conversation.save();
    }

    // Resolve media items
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

// Mounting Memory routes
const memoryRoutes = require('./services/memory.routes');
app.use('/api/memory', authenticateToken, memoryRoutes);

// POST /api/preferences/update
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

// POST /api/user/preferences
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

// POST /api/chat/settings
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

// POST /api/chat/upload-image
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

// GET /api/chat/images/:filename
app.get('/api/chat/images/:filename', authenticateToken, async (req, res) => {
  const { filename } = req.params;
  const safeFilename = path.basename(filename);
  const filePath = path.join(CHAT_IMAGES_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Image file not found.');
  }

  res.sendFile(filePath);
});

// POST /api/chat
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
    res.status(err.statusCode || 500).json({ error: err.message || 'The AI processor grid encountered a communication glitch. Please check API keys and connection.' });
  }
});

// POST /api/generate-image
app.post('/api/generate-image', authenticateToken, async (req, res) => {
  const { history } = req.body;
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User registry error.' });

    // Gate feature: active subscription required
    if (!user.isSubscriptionActive) {
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

    // Load active settings context from database
    const userPref = await preferencesService.loadPreferences(userId);
    const activeCompanionName = userPref.selectedCompanion;
    const activeVibe = userPref.selectedVibe;
    const relationshipLevel = userPref.relationshipLevel;
    const summaryText = userPref.conversationSummary;

    const personalityData = personalityService.getPersonalityPrompt(activeCompanionName, activeVibe);
    const companionGender = personalityData.gender;

    // Deduct 40 coins
    user.coins = currentCoins - 40;
    user.credits = user.coins;
    await user.save();

    mixpanelService.track('Coins Spent', userId, {
      amount: 40,
      purpose: 'image_generation'
    });

    await Transaction.create({
      userId,
      amount: 0,
      type: 'image_generation',
      coins: 40,
      status: 'completed'
    });

    const mediaId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(UPLOADS_DIR, `media-${mediaId}.jpg`);
    let imageWritten = false;

    let imgPrompt = `A beautiful cyberpunk close up selfie of a gorgeous 20-year-old ${companionGender || 'female'} companion named ${activeCompanionName}, showing off a ${activeVibe || 'flirty'} look, highly detailed photorealistic photography, neon glowing backgrounds.`;

    const togetherApiKey = process.env.TOGETHER_API_KEY;
    const isTogetherKeyValid = togetherApiKey && !togetherApiKey.includes('placeholder');

    if (history && isTogetherKeyValid) {
      try {
        const togetherModel = (!process.env.TEXT_MODEL || process.env.TEXT_MODEL.startsWith('key_') || !process.env.TEXT_MODEL.includes('/'))
          ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
          : process.env.TEXT_MODEL;

        const promptGenRes = await axios.post('https://api.together.xyz/v1/chat/completions', {
          model: togetherModel,
          messages: [
            {
              role: 'system',
              content: `You are an expert AI prompt engineer. Write a highly detailed image generation prompt (1-2 sentences) for a cyberpunk-style close-up selfie of a 20-year-old ${companionGender || 'female'} companion named ${activeCompanionName} with a ${activeVibe} vibe. 
The relationship level is ${relationshipLevel.toFixed(1)}/10.0 and the current conversation summary context is: "${summaryText}".
The photo should reflect the mood, actions, or topic of the following chat history:
"${history}"
Make the prompt describe their clothing, expression, pose, and cyberpunk setting. Do not write introductory text, markdown, or notes. Just output the prompt string.`
            }
          ],
          max_tokens: 100,
          temperature: 0.7
        }, {
          headers: { Authorization: `Bearer ${togetherApiKey}` },
          timeout: 6000
        });

        const generatedPrompt = promptGenRes.data.choices[0].message.content.trim();
        if (generatedPrompt) {
          imgPrompt = generatedPrompt;
        }
      } catch (err) {
        console.error('[Together AI image prompt generation failed, using static fallback]:', err.message);
      }
    }

    if (isTogetherKeyValid) {
      try {
        const imageRes = await axios.post('https://api.together.xyz/v1/images/generations', {
          model: process.env.IMAGE_MODEL || 'black-forest-labs/FLUX.1-schnell',
          prompt: imgPrompt,
          width: 512,
          height: 512,
          steps: 4,
          n: 1,
          response_format: 'b64_json'
        }, {
          headers: { Authorization: `Bearer ${togetherApiKey}` },
          timeout: 12000
        });

        const b64Data = imageRes.data.data[0].b64_json;
        fs.writeFileSync(filePath, Buffer.from(b64Data, 'base64'));
        imageWritten = true;
      } catch (err) {
        console.error('[Together Image generation failed]:', err.message);
      }
    }

    if (!imageWritten) {
      // Fallback local SVG mock
      const svg = `
        <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#150d2a" />
          <circle cx="256" cy="256" r="100" fill="none" stroke="#ff4da6" stroke-width="4" />
          <text x="50%" y="270" text-anchor="middle" fill="#ff4da6" font-size="20">Selfie Generation Fallback</text>
        </svg>
      `;
      fs.writeFileSync(filePath, svg);
    }

    await Media.create({
      mediaId,
      mediaType: 'image',
      filePath,
      isLocked: true,
      unlockedBy: []
    });

    mixpanelService.track('Image Generated', userId, {
      media_id: mediaId,
      companion: activeCompanionName,
      vibe: activeVibe,
      relationship_level: relationshipLevel
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

// POST /api/request-voice-note
app.post('/api/request-voice-note', authenticateToken, async (req, res) => {
  const { text, history } = req.body;
  const userId = req.user.userId;

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile mapping error.' });

    // Gate feature: active subscription required
    if (!user.isSubscriptionActive) {
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

    // Load active settings context from database
    const userPref = await preferencesService.loadPreferences(userId);
    const activeCompanionName = userPref.selectedCompanion;
    const activeVibe = userPref.selectedVibe;
    const activeLanguage = userPref.selectedLanguage;
    const relationshipLevel = userPref.relationshipLevel;
    const summaryText = userPref.conversationSummary;

    const personalityData = personalityService.getPersonalityPrompt(activeCompanionName, activeVibe);
    const companionGender = personalityData.gender;

    // Deduct 40 coins
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

    const togetherApiKey = process.env.TOGETHER_API_KEY;
    const isTogetherKeyValid = togetherApiKey && !togetherApiKey.includes('placeholder');

    let speechText = text;
    if (!speechText && history && isTogetherKeyValid) {
      try {
        const togetherModel = (!process.env.TEXT_MODEL || process.env.TEXT_MODEL.startsWith('key_') || !process.env.TEXT_MODEL.includes('/'))
          ? 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
          : process.env.TEXT_MODEL;

        const voiceGenRes = await axios.post('https://api.together.xyz/v1/chat/completions', {
          model: togetherModel,
          messages: [
            {
              role: 'system',
              content: `You are ${activeCompanionName}, a 20-year-old ${companionGender || 'female'} companion in a cyberpunk universe. You have a ${activeVibe} personality.
The relationship level is ${relationshipLevel.toFixed(1)}/10.0 and the current conversation summary context is: "${summaryText}".
Review the recent chat history with the user:
"${history}"
Write a warm, highly personal custom voice message to say to the user right now (strictly 1 to 2 short sentences). 
Response language: ${activeLanguage === 'Hinglish' ? 'Hinglish (mix of Hindi written in Latin script and English - e.g., "Main theek hoon, you tell how are you?")' : activeLanguage}. Write strictly in this language. If Hinglish, do not use Devanagari script.
Do not write warnings, notes, or meta-text. Just output the spoken text.`
            }
          ],
          max_tokens: 80,
          temperature: 0.8
        }, {
          headers: { Authorization: `Bearer ${togetherApiKey}` },
          timeout: 6000
        });

        speechText = voiceGenRes.data.choices[0].message.content.trim();
      } catch (err) {
        console.error('[Together AI voice text generation failed]:', err.message);
      }
    }

    if (!speechText) {
      speechText = text || "Hey baby, I'm thinking of you. Let's stay connected! ❤️";
    }

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
      // Mock minimal MP3 buffer
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

    // Check if already unlocked
    if (media.unlockedBy.includes(userId)) {
      return res.status(200).json({ success: true, message: 'Media already unlocked.', mediaType: media.mediaType });
    }

    const cost = 40;
    if (user.credits < cost) {
      return res.status(402).json({ error: `Insufficient credits. Unlocking this requires ${cost} coins.`, credits: user.credits });
    }

    // Deduct coins & Save
    user.credits -= cost;
    await user.save();

    // Mark media as unlocked for this specific user
    media.unlockedBy.push(userId);
    await media.save();

    // Log Transaction
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

// GET /api/media/:mediaId (Highly secure media provider)
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

    // Check lock permission
    if (media.isLocked && !media.unlockedBy.includes(userId)) {
      return res.status(403).json({ error: 'Access denied. Premium resource is locked.' });
    }

    // Stream out the file securely
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
// Payments & Referrals Integration (UroPay + Traffic Logs)
// -------------------------------------------------------------

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
  if (!refCode) {
    return res.status(400).json({ valid: false, message: 'Referral code is required.' });
  }
  try {
    const promo = await PromoCode.findOne({ code: refCode.toUpperCase().trim(), isActive: true });
    if (promo) {
      res.status(200).json({ valid: true, discount: promo.discount });
    } else {
      res.status(200).json({ valid: false, discount: 0, message: 'Invalid referral code.' });
    }
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
      subscriptionActive: !!user.isSubscriptionActive,
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
  if (!refCode) {
    return res.status(200).json({ valid: false, discountPrice: 110 });
  }
  try {
    const promo = await PromoCode.findOne({ code: refCode.toUpperCase().trim(), isActive: true });
    if (promo) {
      return res.status(200).json({ valid: true, discountPrice: 99 });
    } else {
      return res.status(200).json({ valid: false, discountPrice: 110 });
    }
  } catch (err) {
    console.error('[Promo Validate Error]:', err);
    return res.status(200).json({ valid: false, discountPrice: 110 });
  }
});

app.post('/api/payment/create-order', authenticateToken, async (req, res) => {
  const { refCode, packageName } = req.body;
  const userId = req.user.userId;

  const targetPackageName = packageName || "Premium Dating Pass";

  try {
    const StorePackage = mongoose.model('StorePackage');
    const pack = await StorePackage.findOne({ name: targetPackageName });
    if (!pack) {
      return res.status(404).json({ error: 'Selected package not found.' });
    }
    if (!pack.available) {
      return res.status(400).json({ error: 'This package is currently unavailable for purchase.' });
    }

    if (pack.type !== 'subscription') {
      return res.status(400).json({ error: 'Coin purchases are currently disabled.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User profile not found.' });

    // Double purchase protection
    if (user.isSubscriptionActive || user.paymentStatus === 'paid') {
      return res.status(400).json({ error: 'Subscription is already active.' });
    }

    // 1. Discount/promo code validation against DB
    const promo = refCode ? await PromoCode.findOne({ code: refCode.toUpperCase().trim(), isActive: true }) : null;
    const amount = promo ? 99 : 110;
    const buttonId = promo ? 'NOVEMBER206527' : 'UNIFORM888325';
    const coinsToCredit = 100; // base pass gives 100 coins initially!

    // 2. Duplicate payment protection: check for existing pending transaction
    let transaction = await Transaction.findOne({
      userId,
      type: 'subscription',
      status: 'pending',
      amount
    });

    if (!transaction) {
      transaction = await Transaction.create({
        userId,
        refCode: promo ? promo.code : null,
        amount,
        type: 'subscription',
        coins: coinsToCredit,
        status: 'pending'
      });
    }

    const callbackUrl = `http://localhost:${PORT}/api/payment/callback?transactionId=${transaction._id}`;
    const apiKey = process.env.UROPAY_API_KEY || 'T575R9PTG5BNIGTMC2PSWP396IJCYR2E';
    const vpa = process.env.UROPAY_VPA || 'abhishektiware@naviaxis';

    // Construct valid UroPay payment URL
    const checkoutUrl = `https://uropay.in/pay?key=${apiKey}&vpa=${vpa}&amount=${amount}&note=Order_${transaction._id}&redirect_url=${encodeURIComponent(callbackUrl)}`;

    console.log(`[UroPay Order Generated] Transaction: ${transaction._id} | Amount: ₹${amount} | Button: ${buttonId}`);

    mixpanelService.track('Payment Started', userId, {
      transaction_id: transaction._id,
      amount: amount,
      promo_code: promo ? promo.code : null
    });

    res.status(200).json({
      success: true,
      transactionId: transaction._id,
      amount,
      buttonId,
      checkoutUrl
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

// UroPay status verification helper
async function verifyTransactionWithUroPay(tx) {
  const apiKey = process.env.UROPAY_API_KEY || 'T575R9PTG5BNIGTMC2PSWP396IJCYR2E';
  
  // Dev sandbox/bypass logic for default developer key
  if (apiKey === 'T575R9PTG5BNIGTMC2PSWP396IJCYR2E') {
    console.log(`[UroPay Dev Mock Verify]: Transaction ${tx._id} verified successfully.`);
    return true;
  }

  try {
    const response = await axios.get('https://uropay.in/api/v1/order/status', {
      params: {
        key: apiKey,
        note: `Order_${tx._id}`
      }
    });

    if (response.data && (response.data.status === 'SUCCESS' || response.data.status === 'success')) {
      return true;
    }
  } catch (err) {
    console.error('[UroPay API Status Check Error]:', err.message);
  }
  return false;
}

// GET /api/payment/callback (UPI callback landing page redirection)
app.get('/api/payment/callback', async (req, res) => {
  const { transactionId } = req.query;

  if (!transactionId) {
    return res.status(400).send('<h3>Invalid checkout callback query configuration.</h3>');
  }

  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx) {
      return res.status(404).send('<h3>Payment transaction reference not found.</h3>');
    }

    const user = await User.findById(tx.userId);
    if (!user) {
      return res.status(404).send('<h3>User profile not found.</h3>');
    }

    let isCompleted = tx.status === 'completed';

    // Verify transaction status securely if still pending
    if (!isCompleted && tx.status === 'pending') {
      const isVerified = await verifyTransactionWithUroPay(tx);
      if (isVerified) {
        tx.status = 'completed';
        await tx.save();

        if (tx.type === 'subscription') {
          user.paymentStatus = 'paid';
          user.isSubscriptionActive = true;
        }
        // credit coins to user wallet
        const currentCoins = user.coins !== undefined ? user.coins : user.credits;
        user.coins = currentCoins + tx.coins;
        user.credits = user.coins;
        await user.save();
        
        mixpanelService.track('Payment Successful', user._id, {
          transaction_id: tx._id,
          amount: tx.amount,
          promo_code: tx.refCode
        });
        mixpanelService.track('Coins Purchased', user._id, {
          amount: tx.coins,
          transaction_id: tx._id,
          payment_amount: tx.amount
        });

        isCompleted = true;
      }
    }

    if (!isCompleted) {
      return res.status(402).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Verification Pending</title>
          <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
          <style>
            body {
              background-color: #0f051e;
              color: #ffffff;
              font-family: 'Outfit', sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .card {
              background: linear-gradient(135deg, #150d2a 0%, #0d061c 100%);
              border: 2px solid #ff4a4a;
              border-radius: 12px;
              padding: 40px;
              text-align: center;
              box-shadow: 0 0 30px rgba(255, 74, 74, 0.4);
              max-width: 400px;
            }
            h2 {
              font-family: 'Rajdhani', sans-serif;
              color: #ff4a4a;
              text-shadow: 0 0 10px #ff4a4a;
              margin-top: 0;
            }
            p { color: #b8b3e8; font-size: 14px; }
            .btn {
              display: inline-block;
              margin-top: 20px;
              padding: 10px 20px;
              background: #ff2a75;
              color: #fff;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>PAYMENT VERIFICATION PENDING</h2>
            <p>We are waiting for payment confirmation from UroPay. If you have already paid, your wallet will be credited shortly.</p>
            <a href="/chat.html" class="btn">Back to Chat</a>
          </div>
        </body>
        </html>
      `);
    }

    // Render an automated landing template that stores payment status and redirects back to platform
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authorization Hub</title>
        <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600&family=Outfit:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body {
            background-color: #0f051e;
            color: #ffffff;
            font-family: 'Outfit', sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            overflow: hidden;
          }
          .card {
            background: linear-gradient(135deg, #150d2a 0%, #0d061c 100%);
            border: 2px solid #ff4da6;
            border-radius: 12px;
            padding: 40px;
            text-align: center;
            box-shadow: 0 0 30px rgba(138, 43, 226, 0.4);
            max-width: 400px;
            backdrop-filter: blur(10px);
          }
          h2 {
            font-family: 'Rajdhani', sans-serif;
            color: #00f0ff;
            text-shadow: 0 0 10px #00f0ff;
            margin-top: 0;
          }
          .loader {
            border: 4px solid rgba(255, 77, 166, 0.2);
            border-top: 4px solid #ff4da6;
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 25px auto;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          p { color: #b8b3e8; font-size: 14px; }
        </style>
        <script>
          // Synchronize local state with validated backend session
          localStorage.setItem("paymentStatus", "${user.paymentStatus}");
          localStorage.setItem("credits", "${user.credits}");
          localStorage.setItem("coins", "${user.coins}");

          setTimeout(() => {
            // Signal localized interfaces to update wallet/status
            window.location.href = '/chat.html?payment=success';
          }, 3000);
        </script>
      </head>
      <body>
        <div class="card">
          <h2>TRANSACTION COMPLETED</h2>
          <div class="loader"></div>
          <p>Processing transaction tokens into your wallet registry...</p>
          <p style="font-size: 12px; color: #6a629b;">Redirecting back to Chat Companion Dashboard...</p>
        </div>
      </body>
      </html>
    `);

  } catch (err) {
    console.error('[Payment callback system error]:', err);
    res.status(500).send('<h3>Payment processing error in database registry.</h3>');
  }
});

// POST /api/payment/webhook (UroPay Webhook)
app.post('/api/payment/webhook', async (req, res) => {
  const { status, amount, note } = req.body;

  if (!note || !note.startsWith('Order_')) {
    return res.status(400).json({ error: 'Invalid note parameter.' });
  }

  const transactionId = note.split('_')[1];

  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    if (tx.status !== 'pending') {
      return res.status(200).json({ success: true, message: 'Transaction already processed.' });
    }

    if (status === 'SUCCESS' || status === 'success') {
      tx.status = 'completed';
      await tx.save();

      const user = await User.findById(tx.userId);
      if (user) {
        user.paymentStatus = 'paid';
        user.isSubscriptionActive = true;
        const currentCoins = user.coins !== undefined ? user.coins : user.credits;
        user.coins = currentCoins + tx.coins;
        user.credits = user.coins;
        await user.save();
        console.log(`[Webhook Success] Subscription activated for User ${user._id} through Tx ${tx._id}`);

        mixpanelService.track('Payment Successful', user._id, {
          transaction_id: tx._id,
          amount: tx.amount,
          promo_code: tx.refCode
        });
        mixpanelService.track('Coins Purchased', user._id, {
          amount: tx.coins,
          transaction_id: tx._id,
          payment_amount: tx.amount
        });
      }
      return res.status(200).json({ success: true });
    } else {
      tx.status = 'failed';
      await tx.save();

      mixpanelService.track('Payment Failed', tx.userId, {
        transaction_id: tx._id,
        amount: tx.amount,
        reason: status
      });

      return res.status(200).json({ success: true, message: 'Transaction marked failed.' });
    }
  } catch (err) {
    console.error('[Payment Webhook Error]:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /api/logout (Session Ended)
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
  const { refCode } = req.body;
  if (!refCode) {
    return res.status(400).json({ error: 'Referral tracking code is required.' });
  }

  try {
    await TrafficLog.create({
      refCode,
      ip: req.ip || req.headers['x-forwarded-for']
    });
    res.status(200).json({ success: true, message: 'Click tracked.' });
  } catch (err) {
    console.error('[Track click error]:', err);
    res.status(500).json({ error: 'Failed to record referral click.' });
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Cyber Server listening at: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
