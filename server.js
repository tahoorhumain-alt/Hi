const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let waiting = null; // one socket waiting for a stranger

io.on('connection', (socket) => {
  socket.data.peerId = null;
  socket.data.busy = false;
  socket.data.partner = null;

  socket.on('ready', ({ peerId }) => {
    if (!peerId) return;
    socket.data.peerId = peerId;
    socket.data.busy = false;
  });

  socket.on('find', () => {
    if (!socket.data.peerId || socket.data.busy) return;

    if (waiting && waiting.id === socket.id) {
      socket.emit('waiting');
      return;
    }
    tryMatch(socket);
  });

  socket.on('skip', () => {
    leaveCurrent(socket);
    if (!socket.data.peerId) return;
    tryMatch(socket);
  });

  socket.on('leave', () => {
    leaveCurrent(socket);
    if (waiting && waiting.id === socket.id) waiting = null;
  });

  socket.on('disconnect', () => {
    leaveCurrent(socket);
    if (waiting && waiting.id === socket.id) waiting = null;
  });
});

function tryMatch(socket) {
  if (!socket.connected || !socket.data.peerId || socket.data.busy) return;

  if (waiting && waiting.id !== socket.id && waiting.connected) {
    const a = waiting;
    waiting = null;

    a.data.busy = true;
    socket.data.busy = true;
    a.data.partner = socket.id;
    socket.data.partner = a.id;

    // One side initiates the WebRTC call
    a.emit('matched', {
      partnerPeerId: socket.data.peerId,
      initiator: true
    });

    socket.emit('matched', {
      partnerPeerId: a.data.peerId,
      initiator: false
    });
  } else {
    waiting = socket;
    socket.emit('waiting');
  }
}

function leaveCurrent(socket) {
  if (waiting && waiting.id === socket.id) waiting = null;

  const partnerId = socket.data.partner;
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.data.partner = null;
      partner.data.busy = false;
      partner.emit('partner-left');
    }
    socket.data.partner = null;
    socket.data.busy = false;
  }
}

server.listen(3000, () => {
  console.log('Open http://localhost:3000');
});