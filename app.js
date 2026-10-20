const socket = io();

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const startBtn = document.getElementById('startBtn');
const skipBtn = document.getElementById('skipBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const messages = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

let peer = null;
let localStream = null;
let currentCall = null;
let dataConn = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = 'msg' + (who ? '' : ' system');
  div.innerHTML = who
    ? `<b>${escapeHtml(who)}:</b> ${escapeHtml(text)}`
    : escapeHtml(text);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function closeCurrent() {
  if (currentCall) {
    try { currentCall.close(); } catch {}
    currentCall = null;
  }
  if (dataConn) {
    try { dataConn.close(); } catch {}
    dataConn = null;
  }
  remoteVideo.srcObject = null;
}

function attachCall(call) {
  if (currentCall && currentCall !== call) {
    try { currentCall.close(); } catch {}
  }
  currentCall = call;

  call.on('stream', (stream) => {
    remoteVideo.srcObject = stream;
    remoteVideo.play().catch(() => {});
    setStatus('Connected');
  });

  call.on('close', () => {
    if (currentCall === call) {
      currentCall = null;
      remoteVideo.srcObject = null;
      setStatus('Stranger disconnected. Click Skip.');
    }
  });

  call.on('error', (err) => {
    console.warn('Call error', err);
    setStatus('Call error. Click Skip.');
  });
}

function setupData(conn) {
  if (dataConn && dataConn !== conn) {
    try { dataConn.close(); } catch {}
  }
  dataConn = conn;

  conn.on('open', () => addMessage('', 'Text chat connected.'));
  conn.on('data', (data) => {
    if (data && data.type === 'chat') {
      addMessage('Stranger', String(data.text).slice(0, 500));
    }
  });
  conn.on('close', () => {
    if (dataConn === conn) dataConn = null;
  });
}

function ensurePeer() {
  return new Promise((resolve, reject) => {
    if (peer && peer.open) return resolve(peer.id);

    if (peer) {
      peer.once('open', () => resolve(peer.id));
      return;
    }

    peer = new Peer(undefined, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
          // For production add a TURN server here
        ]
      }
    });

    peer.on('open', (id) => resolve(id));
    peer.on('error', (err) => {
      console.warn('Peer error', err);
      reject(err);
    });

    peer.on('call', (call) => {
      if (!localStream) {
        call.close();
        return;
      }
      call.answer(localStream);
      attachCall(call);
    });

    peer.on('connection', (conn) => {
      setupData(conn);
    });
  });
}

startBtn.onclick = async () => {
  startBtn.disabled = true;

  try {
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });
      localVideo.srcObject = localStream;
      localVideo.play().catch(() => {});
    }

    const peerId = await ensurePeer();

    socket.emit('ready', { peerId });
    socket.emit('find');

    setStatus('Searching for a stranger...');
    skipBtn.disabled = false;
    stopBtn.disabled = false;
  } catch (err) {
    setStatus('Camera/mic error: ' + err.message);
    startBtn.disabled = false;
  }
};

skipBtn.onclick = () => {
  closeCurrent();
  socket.emit('skip');
  setStatus('Searching for a stranger...');
};

stopBtn.onclick = () => {
  closeCurrent();
  socket.emit('leave');

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;

  if (peer) {
    try { peer.destroy(); } catch {}
    peer = null;
  }

  setStatus('Stopped');
  startBtn.disabled = false;
  skipBtn.disabled = true;
  stopBtn.disabled = true;
};

socket.on('waiting', () => {
  setStatus('Waiting for a stranger...');
});

socket.on('matched', ({ partnerPeerId, initiator }) => {
  closeCurrent();
  setStatus(initiator ? 'Matched! Calling...' : 'Matched! Waiting for video...');

  if (initiator && peer && localStream) {
    const call = peer.call(partnerPeerId, localStream);
    if (call) attachCall(call);

    const conn = peer.connect(partnerPeerId);
    setupData(conn);
  }
});

socket.on('partner-left', () => {
  closeCurrent();
  setStatus('Stranger left. Click Skip.');
});

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim().slice(0, 500);
  if (!text) return;

  if (dataConn && dataConn.open) {
    dataConn.send({ type: 'chat', text });
    addMessage('You', text);
    chatInput.value = '';
  } else {
    addMessage('', 'Not connected to a stranger yet.');
  }
};