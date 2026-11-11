require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Filter = require('bad-words');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// --- Middleware Setup ---
app.use(cors());
app.use(express.json());

// Rate limiting for Express API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later."
});
app.use('/api/', apiLimiter);

// --- Socket.io Setup ---
const io = new Server(server, {
  cors: {
    origin: "*", // In production, replace with your WordPress domain
    methods: ["GET", "POST"]
  }
});

// --- Redis Setup (For Matchmaking Queue) ---
// Fallback to localhost if REDIS_URL is not provided
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

redis.on('error', (err) => console.error('Redis error:', err));
redis.on('connect', () => console.log('Connected to Redis successfully'));

// --- Profanity Filter Setup ---
const filter = new Filter();

// --- In-Memory Storage for Demo (Replace with Database later) ---
const usersDB = {}; // { username: { password, friends: [] } }

// ==========================================
// 1. REST API ENDPOINTS
// ==========================================

// Basic Login/Auth to get JWT Token
app.post('/api/auth/login', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  // In production, verify password and fetch from DB
  const token = jwt.sign({ username }, process.env.JWT_SECRET || 'secret', { expiresIn: '24h' });
  res.json({ token, username });
});

// Generate Dynamic TURN Server Credentials
app.get('/api/turn-credentials', (req, res) => {
  const ttl = 86400; // 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = timestamp + ':vibetalk';
  
  // Generate HMAC using your TURN secret
  const hmac = crypto.createHmac('sha1', process.env.TURN_SECRET || 'secret');
  hmac.update(username);
  const credential = hmac.digest('base64');

  res.json({
    urls: process.env.TURN_URL || 'turn:your.turn.server.com:3478',
    username: username,
    credential: credential
  });
});

// Friend System API (Mock Database)
app.post('/api/friends/add', (req, res) => {
  const { user, friend } = req.body;
  if (!usersDB[user]) usersDB[user] = { friends: [] };
  if (!usersDB[user].friends.includes(friend)) {
    usersDB[user].friends.push(friend);
  }
  res.json({ success: true, friends: usersDB[user].friends });
});

app.get('/api/friends/:username', (req, res) => {
  const user = req.params.username;
  res.json({ friends: usersDB[user] ? usersDB[user].friends : [] });
});

// ==========================================
// 2. SOCKET.IO MIDDLEWARE (JWT Auth)
// ==========================================
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    // For testing, allow connection without token, but in production, reject.
    return next(); 
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    socket.username = decoded.username;
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// ==========================================
// 3. SOCKET.IO CONNECTION & MATCHMAKING LOGIC
// ==========================================
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id} (${socket.username || 'Guest'})`);

  socket.data.peerId = null;
  socket.data.partner = null;
  socket.data.interests = [];

  // User is ready with their PeerJS ID and interests
  socket.on('ready', ({ peerId, interests }) => {
    if (!peerId) return;
    socket.data.peerId = peerId;
    socket.data.interests = interests || [];
  });

  // Find Match logic using Redis
  socket.on('find', async () => {
    if (!socket.data.peerId) return;

    // Prevent joining queue if already in one
    const inQueue = await redis.hget('waiting_users', socket.id);
    if (inQueue) return;

    // Add user to Redis queue
    await redis.hset('waiting_users', socket.id, JSON.stringify({
      peerId: socket.data.peerId,
      interests: socket.data.interests,
      socketId: socket.id
    }));

    await tryMatch(socket);
  });

  // Skip current partner
  socket.on('skip', async () => {
    await leaveCurrent(socket);
    socket.emit('find'); // Automatically find next
  });

  // Leave entirely
  socket.on('leave', async () => {
    await leaveCurrent(socket);
    await redis.hdel('waiting_users', socket.id);
  });

  // Text Chat filtering
  socket.on('chat_message', (data) => {
    if (!socket.data.partner) return;
    
    // Clean the text to prevent abuse
    let cleanText = data.text;
    try { cleanText = filter.clean(cleanText); } catch (e) {}

    // Send to partner
    io.to(socket.data.partner).emit('chat_message', {
      text: cleanText.substring(0, 500), // max 500 chars
      sender: socket.username || 'Stranger'
    });
  });

  // Handle Disconnect
  socket.on('disconnect', async () => {
    console.log(`User disconnected: ${socket.id}`);
    await leaveCurrent(socket);
    await redis.hdel('waiting_users', socket.id);
  });
});

// ==========================================
// 4. MATCHMAKING ALGORITHM (Interest-Based)
// ==========================================
async function tryMatch(socket) {
  // Get all waiting users from Redis
  const waitingList = await redis.hgetall('waiting_users');
  
  let matchedUser = null;
  let bestMatchScore = -1;

  for (const [id, dataString] of Object.entries(waitingList)) {
    if (id === socket.id) continue; // Skip self

    const userData = JSON.parse(dataString);
    
    // Calculate interest overlap score
    let score = 0;
    if (socket.data.interests && userData.interests) {
      score = socket.data.interests.filter(i => userData.interests.includes(i)).length;
    }

    // Find the highest score match
    if (score > bestMatchScore) {
      bestMatchScore = score;
      matchedUser = { id, ...userData };
    }
  }

  if (matchedUser) {
    // Remove BOTH from queue atomically
    await redis.hdel('waiting_users', socket.id);
    await redis.hdel('waiting_users', matchedUser.id);

    // Set partners
    socket.data.partner = matchedUser.id;
    const partnerSocket = io.sockets.sockets.get(matchedUser.id);
    if (partnerSocket) {
      partnerSocket.data.partner = socket.id;

      // Emit matched event to both
      socket.emit('matched', {
        partnerPeerId: matchedUser.peerId,
        partnerName: matchedUser.name || 'Stranger',
        initiator: false // This user receives the call
      });

      partnerSocket.emit('matched', {
        partnerPeerId: socket.data.peerId,
        partnerName: socket.username || 'Stranger',
        initiator: true // This user initiates the call
      });
      return;
    }
  }

  // If no match found, tell user they are waiting
  socket.emit('waiting');
}

async function leaveCurrent(socket) {
  const partnerId = socket.data.partner;
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.data.partner = null;
      partner.emit('partner-left');
    }
    socket.data.partner = null;
  }
}

// ==========================================
// 5. START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Viduo/TalkOrbit Server running on port ${PORT}`);
});
