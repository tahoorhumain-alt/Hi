const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
// Add this AFTER `app.use(cors());` and BEFORE `const server = http.createServer(app);`

app.get('/', (req, res) => {
    res.send('OK');
});
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// ========== DATA STORE ==========
const onlineUsers = new Map(); // socketId -> { peerId, socketId, username, ip }
const reportCounts = new Map(); // ip -> number of reports
const blockedIPs = new Set(); // ip -> blocked

// Friend system
const friends = new Map(); // peerId -> Set of peerId (friends)
const pendingRequests = new Map(); // receiverPeerId -> [{ senderPeerId, senderUsername, timestamp }]

const REPORT_LIMIT = 3;

// ========== HELPERS ==========
function getClientIP(socket) {
    const ip = socket.handshake.address || socket.conn.remoteAddress;
    return ip.replace(/^::ffff:/, '');
}

function getSocketIdByPeerId(peerId) {
    for (const [socketId, user] of onlineUsers) {
        if (user.peerId === peerId) {
            return socketId;
        }
    }
    return null;
}

// ========== SOCKET EVENTS ==========
io.on('connection', (socket) => {
    console.log('✅ Client connected:', socket.id);

    const clientIP = getClientIP(socket);
    console.log(`📡 Client IP: ${clientIP}`);

    if (blockedIPs.has(clientIP)) {
        console.log(`🚫 Blocked IP attempted: ${clientIP}`);
        socket.emit('blocked', { message: '⚠️ You have been blocked.' });
        socket.disconnect();
        return;
    }

    // ---------- REGISTER ----------
    socket.on('register', (data) => {
        const { peerId, username } = data;
        onlineUsers.set(socket.id, {
            peerId,
            socketId: socket.id,
            username: username || 'Anonymous',
            ip: clientIP
        });
        io.emit('online_count', onlineUsers.size);

        const allPeerIds = [...onlineUsers.values()].map(u => u.peerId);
        socket.emit('online_list', allPeerIds);

        // Send friend list
        if (friends.has(peerId)) {
            socket.emit('friend_list', { friends: [...friends.get(peerId)] });
        } else {
            socket.emit('friend_list', { friends: [] });
        }

        // Send pending requests
        if (pendingRequests.has(peerId)) {
            socket.emit('pending_requests', { requests: pendingRequests.get(peerId) });
        } else {
            socket.emit('pending_requests', { requests: [] });
        }

        console.log(`📝 Registered: ${username || 'Anonymous'} (${peerId})`);
    });

    // ---------- FIND STRANGER ----------
    socket.on('find_stranger', () => {
        const me = onlineUsers.get(socket.id);
        if (!me) return;

        const others = [...onlineUsers.values()].filter(u => u.socketId !== socket.id);
        if (others.length === 0) {
            socket.emit('no_stranger', { message: 'No one online right now.' });
            return;
        }

        const stranger = others[Math.floor(Math.random() * others.length)];
        socket.emit('stranger_found', { peerId: stranger.peerId, username: stranger.username });
        console.log(`🔗 Matched ${me.username} with ${stranger.username}`);
    });

    // ---------- REPORT USER ----------
    socket.on('report_user', (data) => {
        const { strangerPeerId, reason } = data;
        const reporter = onlineUsers.get(socket.id);
        if (!reporter) {
            socket.emit('report_error', { message: 'You are not registered.' });
            return;
        }

        const reporterIP = clientIP;

        if (blockedIPs.has(reporterIP)) {
            socket.emit('report_error', { message: '⚠️ You are already blocked.' });
            return;
        }

        const currentCount = (reportCounts.get(reporterIP) || 0) + 1;
        reportCounts.set(reporterIP, currentCount);

        console.log(`📢 Report from ${reporter.username} (${reporterIP}) - count: ${currentCount}/${REPORT_LIMIT}`);

        if (currentCount >= REPORT_LIMIT) {
            blockedIPs.add(reporterIP);
            console.log(`🚫 BLOCKED IP: ${reporterIP} (${reporter.username})`);
            socket.emit('blocked', {
                message: `⚠️ You have been blocked after ${REPORT_LIMIT} reports.`
            });
            setTimeout(() => {
                socket.disconnect();
            }, 2000);
            onlineUsers.delete(socket.id);
            io.emit('online_count', onlineUsers.size);
            return;
        }

        socket.emit('report_success', {
            message: `✅ Report sent. (${currentCount}/${REPORT_LIMIT} used)`,
            count: currentCount,
            limit: REPORT_LIMIT
        });

        let strangerSocketId = null;
        for (const [sid, user] of onlineUsers) {
            if (user.peerId === strangerPeerId) {
                strangerSocketId = sid;
                break;
            }
        }
        if (strangerSocketId) {
            io.to(strangerSocketId).emit('you_were_reported', {
                reporter: reporter.username,
                message: `⚠️ ${reporter.username} reported you. Please be respectful.`
            });
        }
    });

    // ---------- LIKE USER ----------
    socket.on('like_user', (data) => {
        const { strangerPeerId } = data;
        const liker = onlineUsers.get(socket.id);
        if (!liker) return;

        const targetSocketId = getSocketIdByPeerId(strangerPeerId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('like_notification', {
                from: liker.username
            });
        }
    });

    // ============================================================
    //  FRIEND SYSTEM
    // ============================================================

    socket.on('send_friend_request', ({ targetPeerId }) => {
        const sender = onlineUsers.get(socket.id);
        if (!sender) {
            socket.emit('friend_request_error', { message: 'You are not registered.' });
            return;
        }
        const senderPeerId = sender.peerId;
        const senderUsername = sender.username;

        if (friends.has(senderPeerId) && friends.get(senderPeerId).has(targetPeerId)) {
            socket.emit('friend_request_error', { message: 'You are already friends!' });
            return;
        }

        if (pendingRequests.has(targetPeerId)) {
            const existing = pendingRequests.get(targetPeerId).find(req => req.senderPeerId === senderPeerId);
            if (existing) {
                socket.emit('friend_request_error', { message: 'Friend request already sent!' });
                return;
            }
        }

        if (!pendingRequests.has(targetPeerId)) {
            pendingRequests.set(targetPeerId, []);
        }
        pendingRequests.get(targetPeerId).push({
            senderPeerId,
            senderUsername,
            timestamp: Date.now()
        });

        const targetSocketId = getSocketIdByPeerId(targetPeerId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('friend_request_received', {
                from: senderPeerId,
                username: senderUsername,
                timestamp: Date.now()
            });
            io.to(targetSocketId).emit('pending_requests', { requests: pendingRequests.get(targetPeerId) });
        }

        socket.emit('friend_request_sent', { target: targetPeerId });
        console.log(`📨 Friend request from ${senderUsername} (${senderPeerId}) to ${targetPeerId}`);
    });

    socket.on('accept_friend_request', ({ senderPeerId }) => {
        const receiver = onlineUsers.get(socket.id);
        if (!receiver) {
            socket.emit('friend_request_error', { message: 'You are not registered.' });
            return;
        }
        const receiverPeerId = receiver.peerId;

        if (!pendingRequests.has(receiverPeerId)) {
            socket.emit('friend_request_error', { message: 'No request from this user.' });
            return;
        }
        const requests = pendingRequests.get(receiverPeerId);
        const requestIndex = requests.findIndex(req => req.senderPeerId === senderPeerId);
        if (requestIndex === -1) {
            socket.emit('friend_request_error', { message: 'No request from this user.' });
            return;
        }

        requests.splice(requestIndex, 1);
        if (requests.length === 0) {
            pendingRequests.delete(receiverPeerId);
        }

        if (!friends.has(receiverPeerId)) friends.set(receiverPeerId, new Set());
        if (!friends.has(senderPeerId)) friends.set(senderPeerId, new Set());
        friends.get(receiverPeerId).add(senderPeerId);
        friends.get(senderPeerId).add(receiverPeerId);

        const senderSocketId = getSocketIdByPeerId(senderPeerId);
        if (senderSocketId) {
            io.to(senderSocketId).emit('friend_request_accepted', {
                by: receiverPeerId,
                username: receiver.username
            });
            io.to(senderSocketId).emit('friend_list', { friends: [...friends.get(senderPeerId)] });
        }

        socket.emit('friend_list', { friends: [...friends.get(receiverPeerId)] });
        socket.emit('pending_requests', { requests: pendingRequests.get(receiverPeerId) || [] });

        let senderUsername = 'Stranger';
        for (const [, user] of onlineUsers) {
            if (user.peerId === senderPeerId) {
                senderUsername = user.username;
                break;
            }
        }
        socket.emit('friend_request_accepted', {
            by: senderPeerId,
            username: senderUsername
        });

        console.log(`🤝 ${receiver.username} accepted friend request from ${senderUsername}`);
    });

    socket.on('reject_friend_request', ({ senderPeerId }) => {
        const receiver = onlineUsers.get(socket.id);
        if (!receiver) return;
        const receiverPeerId = receiver.peerId;

        if (!pendingRequests.has(receiverPeerId)) return;
        const requests = pendingRequests.get(receiverPeerId);
        const requestIndex = requests.findIndex(req => req.senderPeerId === senderPeerId);
        if (requestIndex === -1) return;

        requests.splice(requestIndex, 1);
        if (requests.length === 0) {
            pendingRequests.delete(receiverPeerId);
        }

        const senderSocketId = getSocketIdByPeerId(senderPeerId);
        if (senderSocketId) {
            io.to(senderSocketId).emit('friend_request_rejected', {
                by: receiverPeerId
            });
        }

        socket.emit('pending_requests', { requests: pendingRequests.get(receiverPeerId) || [] });
        console.log(`❌ ${receiver.username} rejected friend request from ${senderPeerId}`);
    });

    socket.on('get_friend_list', () => {
        const user = onlineUsers.get(socket.id);
        if (!user) return;
        const peerId = user.peerId;
        if (friends.has(peerId)) {
            socket.emit('friend_list', { friends: [...friends.get(peerId)] });
        } else {
            socket.emit('friend_list', { friends: [] });
        }
    });

    socket.on('get_pending_requests', () => {
        const user = onlineUsers.get(socket.id);
        if (!user) return;
        const peerId = user.peerId;
        if (pendingRequests.has(peerId)) {
            socket.emit('pending_requests', { requests: pendingRequests.get(peerId) });
        } else {
            socket.emit('pending_requests', { requests: [] });
        }
    });

    socket.on('check_friend_status', ({ targetPeerId }) => {
        const user = onlineUsers.get(socket.id);
        if (!user) return;
        const peerId = user.peerId;
        const isFriend = friends.has(peerId) && friends.get(peerId).has(targetPeerId);
        socket.emit('friend_status', { targetPeerId, isFriend });
    });

    // ---------- DISCONNECT ----------
    socket.on('disconnect', () => {
        const user = onlineUsers.get(socket.id);
        if (user) {
            console.log(`❌ ${user.username} disconnected`);
        }
        onlineUsers.delete(socket.id);
        io.emit('online_count', onlineUsers.size);
    });
});

// ========== SERVER START ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 VibeTalk server running on port ${PORT}`);
    console.log(`📊 Report limit: ${REPORT_LIMIT} per IP`);
    console.log(`👥 Friend system active!`);
});