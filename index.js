const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── ACTIVE SESSIONS MAP ────────────────────────────────────────
const sessions = new Map();

// ── CLEANUP OLD SESSIONS (every 10 mins) ──────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, data] of sessions.entries()) {
    if (now - data.created > 10 * 60 * 1000) {
      try {
        if (data.sock) data.sock.end();
        const tmpPath = path.join(__dirname, 'tmp', id);
        if (fs.existsSync(tmpPath)) {
          fs.rmSync(tmpPath, { recursive: true, force: true });
        }
      } catch (e) {}
      sessions.delete(id);
      console.log('🗑️  Cleaned up session: ' + id);
    }
  }
}, 10 * 60 * 1000);

// ── GENERATE SESSION ID ────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substring(2, 10) +
         Math.random().toString(36).substring(2, 10);
}

// ── ENCODE SESSION TO STRING ───────────────────────────────────
function encodeSession(sessionPath) {
  try {
    const files = fs.readdirSync(sessionPath);
    const sessionData = {};
    for (const file of files) {
      const filePath = path.join(sessionPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      sessionData[file] = content;
    }
    return Buffer.from(JSON.stringify(sessionData)).toString('base64');
  } catch (e) {
    return null;
  }
}

// ── SEND SESSION TO WHATSAPP ───────────────────────────────────
async function sendSessionToWhatsApp(sock, phone, sessionString) {
  try {
    const jid = phone + '@s.whatsapp.net';

    // Message 1: Success notification
    await sock.sendMessage(jid, {
      text: '✅ *ALMEER XMD — Pairing Successful!*\n\n🎉 Your bot has been linked successfully!\n\nYour session string is coming right up 👇\n\n━━━━━━━━━━━━━━━━━━━━'
    });

    await new Promise(r => setTimeout(r, 1500));

    // Message 2: The session string itself
    await sock.sendMessage(jid, {
      text: sessionString
    });

    await new Promise(r => setTimeout(r, 1500));

    // Message 3: Instructions
    await sock.sendMessage(jid, {
      text: '📋 *How to use your session string:*\n\n1️⃣ Go to your *Pterodactyl Panel*\n2️⃣ Open your bot server\n3️⃣ Go to *Startup* tab\n4️⃣ Find *SESSION_DATA* variable\n5️⃣ Paste the string above\n6️⃣ Click *Start* → Bot is live! 🚀\n\n━━━━━━━━━━━━━━━━━━━━\n⚠️ *Keep this string private! Anyone with it can control your bot.*\n\n🤖 *Powered by ALMEER XMD*'
    });

    console.log('📨 Session string sent to WhatsApp: +' + phone);
  } catch (err) {
    console.error('❌ Failed to send WhatsApp message:', err.message);
  }
}

// ── REQUEST PAIRING CODE ───────────────────────────────────────
app.post('/request-code', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.json({ success: false, error: 'Phone number is required!' });
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  if (cleanPhone.length < 7 || cleanPhone.length > 15) {
    return res.json({ success: false, error: 'Invalid phone number!' });
  }

  const sessionId = generateId();
  const tmpPath = path.join(__dirname, 'tmp', sessionId);

  try {
    fs.mkdirSync(tmpPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(tmpPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      browser: ['ALMEER XMD', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000
    });

    sessions.set(sessionId, {
      sock,
      status: 'pending',
      session: null,
      phone: cleanPhone,
      created: Date.now(),
      tmpPath
    });

    // Wait for socket to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    let code;
    try {
      code = await sock.requestPairingCode(cleanPhone);
    } catch (e) {
      sessions.delete(sessionId);
      fs.rmSync(tmpPath, { recursive: true, force: true });
      return res.json({
        success: false,
        error: 'Failed to generate code. Make sure the number is registered on WhatsApp!'
      });
    }

    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
    console.log('✅ Code for +' + cleanPhone + ': ' + formattedCode + ' [' + sessionId + ']');

    // ── LISTEN FOR CONNECTION ────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      const sessionData = sessions.get(sessionId);
      if (!sessionData) return;

      if (connection === 'open') {
        console.log('🎉 WhatsApp connected for: +' + cleanPhone);

        // Save credentials
        await saveCreds();

        // Wait for creds to fully write to disk
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Encode session
        const encoded = encodeSession(tmpPath);

        // Update session map
        sessions.set(sessionId, {
          ...sessionData,
          status: 'connected',
          session: encoded
        });

        // ✅ SEND SESSION STRING TO THEIR WHATSAPP
        await sendSessionToWhatsApp(sock, cleanPhone, encoded);

        // Close sock after 15 seconds
        setTimeout(() => {
          try { sock.end(); } catch (e) {}
        }, 15000);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          const current = sessions.get(sessionId);
          if (current && current.status !== 'connected') {
            sessions.set(sessionId, { ...current, status: 'failed' });
          }
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    res.json({ success: true, sessionId, code: formattedCode });

  } catch (err) {
    console.error('❌ Error:', err.message);
    try { fs.rmSync(tmpPath, { recursive: true, force: true }); } catch (e) {}
    sessions.delete(sessionId);
    res.json({ success: false, error: 'Server error. Please try again!' });
  }
});

// ── CHECK SESSION STATUS ───────────────────────────────────────
app.get('/session-status/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const data = sessions.get(sessionId);

  if (!data) return res.json({ status: 'not_found' });

  if (data.status === 'connected' && data.session) {
    return res.json({ status: 'connected', session: data.session });
  }

  res.json({ status: data.status });
});

// ── MAIN PAGE ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── PING ──────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.send('pong'));

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🤖 ALMEER XMD — Pairing Site');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🌐 Port   : ' + PORT);
  console.log('  🔗 URL    : http://localhost:' + PORT);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});
    
