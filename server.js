#!/usr/bin/env node
require('dotenv').config();
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const pty = require('node-pty');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const Database = require('better-sqlite3');
const { getLocalContext } = require('./rag.js');

// =====================================================================
// --- 1. CROSS-PLATFORM OS DETECTION ---
// =====================================================================
let hostOS = os.platform();

if (hostOS === 'linux') {
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const match = osRelease.match(/^ID=([^\n]+)/m);
    if (match) hostOS = match[1].replace(/"/g, '');
  } catch (e) {}
}

console.log(`[SYSTEM]: Detected Host OS as '${hostOS}'`);

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows ? 'powershell.exe' : (process.env.SHELL || 'bash');
const defaultHome = isWindows ? process.env.USERPROFILE : process.env.HOME;

// =====================================================================
// --- 2. DUAL-CACHE SQLITE INITIALIZATION ---
// =====================================================================
const dbPath = path.join(__dirname, 'cache.db');
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS translation_cache (
    query TEXT, os_name TEXT, command TEXT,
    PRIMARY KEY (query, os_name)
  );
  CREATE TABLE IF NOT EXISTS autofix_cache (
    error_signature TEXT, os_name TEXT, fixed_command TEXT,
    PRIMARY KEY (error_signature, os_name)
  );
`);

const checkTranslation = db.prepare('SELECT command FROM translation_cache WHERE query = ? AND os_name = ?');
const saveTranslation = db.prepare('INSERT OR REPLACE INTO translation_cache (query, os_name, command) VALUES (?, ?, ?)');
const checkAutofix = db.prepare('SELECT fixed_command FROM autofix_cache WHERE error_signature = ? AND os_name = ?');
const saveAutofix = db.prepare('INSERT OR REPLACE INTO autofix_cache (error_signature, os_name, fixed_command) VALUES (?, ?, ?)');

// =====================================================================
// --- 3. MULTI-SESSION PTY MANAGER ---
// =====================================================================
const sessions = new Map(); // sessionId -> { pty, buffer, debounceTimer }
let sessionCounter = 0;

function createSession(cols = 80, rows = 30) {
  const sessionId = `term-${++sessionCounter}`;
  const ptyProc = pty.spawn(defaultShell, [], {
    name: 'xterm-color',
    cols,
    rows,
    cwd: defaultHome,
    env: process.env
  });

  const session = {
    id: sessionId,
    pty: ptyProc,
    buffer: '',
    debounceTimer: null,
    suppressAutoFix: false,
    autoFixInFlight: false,
    createdAt: Date.now()
  };

  // Error sniffer for this session
  ptyProc.onData(data => {
    // Broadcast to all connected sockets for this session
    io.emit('output', { sessionId, data });

    // Rolling buffer
    session.buffer += data;
    if (session.buffer.length > 2500) {
      session.buffer = session.buffer.slice(-2500);
    }

    // Sniff for errors (but NOT if suppressed by recent user cancellation)
    const errorPatterns = /command not found|command not f ound|is not recognized|cannot be loaded|ERR!|Traceback|Exception/i;
    if (!session.suppressAutoFix && errorPatterns.test(data)) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = setTimeout(() => {
        // Skip if user cancelled during the debounce window
        if (session.suppressAutoFix) {
          console.log(`[AUTO-FIX SKIPPED] User cancellation during debounce in session ${sessionId}`);
          session.buffer = '';
          return;
        }
        console.log(`[AUTO-FIX TRIGGERED] Session ${sessionId}`);
        const currentDir = getCurrentDirectory(ptyProc);
        session.autoFixInFlight = true;
        session.autoFixJustSuggested = false;
        autoFixError(session.buffer, currentDir, sessionId);
        session.buffer = '';
      }, 1200);
    }
  });

  ptyProc.onExit(() => {
    console.log(`[PTY] Session ${sessionId} exited`);
    io.emit('session-exited', { sessionId });
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, session);
  console.log(`[PTY] Created session ${sessionId} (total: ${sessions.size})`);
  return session;
}

function destroySession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try { session.pty.kill(); } catch (e) {}
    clearTimeout(session.debounceTimer);
    sessions.delete(sessionId);
    console.log(`[PTY] Destroyed session ${sessionId} (remaining: ${sessions.size})`);
  }
}

// =====================================================================
// --- 4. CROSS-PLATFORM CWD DETECTION ---
// =====================================================================
function getCurrentDirectory(ptyProc) {
  if (os.platform() === 'linux') {
    try { return fs.readlinkSync(`/proc/${ptyProc.pid}/cwd`); } catch (e) {}
  }
  return defaultHome || process.cwd();
}

// =====================================================================
// --- 5. AI AUTO-FIXER ENGINE ---
// =====================================================================
async function autoFixError(errorBuffer, currentDirectory, sessionId) {
  let cleanBuffer = errorBuffer.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  cleanBuffer = cleanBuffer.replace(/\r/g, '');

  const cleanLines = cleanBuffer.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const errorPattern = /command not found|is not recognized|cannot be loaded|Error:|ERR!|fatal:|Traceback|Exception/i;
  const errorLines = cleanLines.filter(l => errorPattern.test(l));
  const errorSignature = errorLines.length > 0 ? errorLines[0].slice(0, 150) : cleanBuffer.trim().slice(-150);

  const session = sessions.get(sessionId);
  if (!session) return;

  const finishAutoFix = (cmd) => {
    session.autoFixInFlight = false;
    if (cmd && cmd !== 'NONE') session.autoFixJustSuggested = true;
  };

  // Check cache
  const cachedFix = checkAutofix.get(errorSignature, hostOS);
  if (cachedFix) {
    if (!session.autoFixInFlight) return; // Aborted by user
    console.log(`[AUTO-FIX CACHE HIT]: "${errorSignature.slice(0, 60)}..."`);
    io.emit('output', { sessionId, data: `\r\n\x1b[36m✨ AI Auto-Fix Suggestion (Cached):\x1b[0m\r\n` });
    session.pty.write(cachedFix.fixed_command);
    finishAutoFix(cachedFix.fixed_command);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { finishAutoFix(); return; }

  try {
    console.log(`[AUTO-FIX CACHE MISS]: "${errorSignature.slice(0, 60)}..."`);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `You are an AI auto-fixer running on ${hostOS}. Analyze the terminal buffer. Focus ONLY on the most recent error. Provide ONLY the raw terminal command to fix it. No explanations. If unfixable, output: NONE` }]
        },
        contents: [{ parts: [{ text: `Directory: ${currentDirectory}\nTerminal Output:\n${cleanBuffer}` }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    if (!session.autoFixInFlight) {
      console.log(`[AUTO-FIX ABORTED]: User pressed Ctrl+C during API call`);
      return;
    }

    if (!response.ok) { finishAutoFix(); return; }
    const data = await response.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) { finishAutoFix(); return; }

    let fixCommand = data.candidates[0].content.parts[0].text.trim();
    fixCommand = fixCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();

    if (fixCommand !== 'NONE' && fixCommand !== '') {
      saveAutofix.run(errorSignature, hostOS, fixCommand);
      io.emit('output', { sessionId, data: `\r\n\x1b[36m✨ AI Auto-Fix Suggestion:\x1b[0m\r\n` });
      session.pty.write(fixCommand);
      finishAutoFix(fixCommand);
    } else {
      finishAutoFix();
    }
  } catch (error) {
    finishAutoFix();
    console.error("[AUTO-FIX FAILED]:", error.message);
  }
}

// =====================================================================
// --- 6. GEMINI STREAMING HELPERS ---
// =====================================================================
function extractTextFromStreamChunk(chunkString) {
  const parts = [];
  try {
    const jsonArray = JSON.parse(chunkString);
    if (Array.isArray(jsonArray)) {
      for (const item of jsonArray) {
        if (item.candidates) {
          for (const c of item.candidates) {
            if (c.content?.parts) {
              for (const p of c.content.parts) {
                if (p.text) parts.push(p.text);
              }
            }
          }
        }
      }
    }
  } catch (e) {
    const textMatches = chunkString.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g);
    if (textMatches) {
      for (const match of textMatches) {
        try {
          const parsed = JSON.parse(`{${match}}`);
          if (parsed.text) parts.push(parsed.text);
        } catch (pe) {
          let textPart = match.replace(/"text":\s*"/, '').slice(0, -1);
          textPart = textPart.replace(/\\n/g, '\n').replace(/\\"/g, '"');
          parts.push(textPart);
        }
      }
    }
  }
  return parts;
}

// =====================================================================
// --- 7. WEBSOCKET CONNECTION ---
// =====================================================================
io.on('connection', (socket) => {
  console.log('Frontend connected');

  // Create a terminal session
  socket.on('create-terminal', ({ cols, rows } = {}, callback) => {
    const session = createSession(cols || 80, rows || 30);
    if (typeof callback === 'function') {
      callback({ sessionId: session.id });
    }
  });

  // Destroy a terminal session
  socket.on('close-terminal', ({ sessionId }) => {
    destroySession(sessionId);
  });

  // Input to a specific session
  socket.on('input', ({ sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (session) {
      // ONLY suppress on explicit cancellation (Ctrl+C = \x03)
      if (data.includes('\x03')) {
        // If an auto-fix was just suggested and is sitting at the prompt, visually erase it
        if (session.autoFixJustSuggested) {
          io.emit('output', { sessionId, data: '\x1b[2K\r' });
        }

        if (session.debounceTimer) {
          clearTimeout(session.debounceTimer);
          session.debounceTimer = null;
        }
        
        session.suppressAutoFix = true;
        session.autoFixInFlight = false;
        session.autoFixJustSuggested = false;
        session.buffer = '';
        clearTimeout(session._suppressTimer);
        // Suppress for 2 seconds after a Ctrl+C
        session._suppressTimer = setTimeout(() => { session.suppressAutoFix = false; }, 2000);
      } else if (data.trim() !== '') {
        // Normal typing clears the "just suggested" state so backspace doesn't clear the whole line unexpectedly
        session.autoFixJustSuggested = false;
      }

      session.pty.write(data);
    }
  });

  // Resize a specific session
  socket.on('resize', ({ sessionId, cols, rows }) => {
    const session = sessions.get(sessionId);
    if (session) {
      try { session.pty.resize(cols, rows); } catch (e) {}
    }
  });

  // AI request for a specific session
  socket.on('ai-request', async ({ sessionId, query }) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    console.log(`[AI Request]: "${query}" → session ${sessionId}`);
    const normalizedQuery = query.trim().toLowerCase();

    const cachedResult = checkTranslation.get(normalizedQuery, hostOS);
    if (cachedResult) {
      console.log(`[CACHE HIT]: ${normalizedQuery}`);
      session.pty.write(cachedResult.command);
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      session.pty.write(`echo "Error: GEMINI_API_KEY missing"\r`);
      return;
    }

    try {
      const currentDir = getCurrentDirectory(session.pty);
      const localContext = await getLocalContext(query, currentDir);
      const augmentedQuery = `Context: Host OS is ${hostOS}.\nUser Query: ${query}${localContext}`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are an expert terminal assistant. Provide the exact command for the user's OS. Output ONLY the raw command. No formatting, backticks, or explanations." }]
          },
          contents: [{ parts: [{ text: augmentedQuery }] }],
          generationConfig: { temperature: 0.1 }
        })
      });

      if (!response.ok) {
        session.pty.write(`echo 'API Error: HTTP ${response.status}'\r`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullCmd = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const textParts = extractTextFromStreamChunk(decoder.decode(value, { stream: true }));
        for (const t of textParts) {
          session.pty.write(t);
          fullCmd += t;
        }
      }

      fullCmd = fullCmd.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();
      if (fullCmd) {
        saveTranslation.run(normalizedQuery, hostOS, fullCmd);
        console.log(`[CACHED]: "${normalizedQuery}" for '${hostOS}'`);
      }
    } catch (error) {
      console.error("API Error:", error.message);
      session.pty.write(`echo 'API Failed: ${error.message}'\r`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Frontend disconnected');
  });
});

// =====================================================================
// --- 8. EXPRESS SERVER STARTUP & AUTO-LAUNCH ---
// =====================================================================
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`✨ AI Terminal Engine running on http://localhost:${PORT}`);

  const url = `http://localhost:${PORT}`;
  const startCommand = process.platform === 'darwin' ? 'open'
                     : process.platform === 'win32' ? 'start'
                     : 'xdg-open';

  exec(`${startCommand} ${url}`, (err) => {
    if (err) console.log(`[SYSTEM] Open ${url} manually.`);
    else console.log(`[SYSTEM] Auto-launching browser...`);
  });
});

// Cleanup all sessions on exit
process.on('exit', () => {
  for (const [id] of sessions) destroySession(id);
});