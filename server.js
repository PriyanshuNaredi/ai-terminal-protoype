#!/usr/bin/env node
require('dotenv').config();
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const Database = require('better-sqlite3');
const { getLocalContext } = require('./rag.js');
const { exec } = require('child_process');

// =====================================================================
// --- 1. SYSTEM OS DETECTION ---
// =====================================================================
let hostOS = 'linux';
try {
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  const match = osRelease.match(/^ID=([^\n]+)/m);
  if (match) hostOS = match[1].replace(/"/g, '');
} catch (e) {}

console.log(`[SYSTEM]: Detected Host OS as '${hostOS}'`);

// =====================================================================
// --- 2. SQLITE CACHE (v2) INITIALIZATION ---
// =====================================================================
const db = new Database('cache.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS command_cache_v2 (
    query TEXT,
    os_name TEXT,
    command TEXT,
    PRIMARY KEY (query, os_name)
  )
`);

const checkCache = db.prepare('SELECT command FROM command_cache_v2 WHERE query = ? AND os_name = ?');
const saveToCache = db.prepare('INSERT OR REPLACE INTO command_cache_v2 (query, os_name, command) VALUES (?, ?, ?)');

// =====================================================================
// --- 3. PTY MASTER PROCESS ---
// =====================================================================
const shell = 'bash';
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

// =====================================================================
// --- 4. AI AUTO-FIXER ENGINE ---
// =====================================================================
async function autoFixError(errorBuffer, currentDirectory, io) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are an AI auto-fixer running on ${hostOS}. The user just encountered an error in their terminal.
            Analyze the provided terminal buffer.
            Provide ONLY the raw, exact terminal command to fix the error.
            Do NOT provide explanations.
            If the error is unfixable via command line (like a pure syntax error in a code file) or if it's not a real error, output EXACTLY the word: NONE.`
          }]
        },
        contents: [{ parts: [{ text: `Directory: ${currentDirectory}\nTerminal Output:\n${errorBuffer}` }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const data = await response.json();
    let fixCommand = data.candidates[0].content.parts[0].text.trim();
    fixCommand = fixCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();

    if (fixCommand !== 'NONE' && fixCommand !== '') {
      console.log(`[AUTO-FIX]: Suggesting -> ${fixCommand}`);
      io.emit('output', `\r\n\x1b[36m✨ AI Auto-Fix Suggestion:\x1b[0m\r\n`);
      ptyProcess.write(fixCommand);
    }
  } catch (error) {
    console.error("[AUTO-FIX FAILED]:", error.message);
  }
}

// =====================================================================
// --- 5. PTY DATA STREAM (ERROR SNIFFER) ---
// =====================================================================
let terminalBuffer = "";
let errorDebounceTimer = null;

ptyProcess.onData(data => {
  io.emit('output', data);

  terminalBuffer += data;
  if (terminalBuffer.length > 2500) {
    terminalBuffer = terminalBuffer.slice(-2500);
  }

  const errorPatterns = /command not found|command not f ound|Error:|ERR!|fatal:|Traceback|Exception/i;

  if (errorPatterns.test(data)) {
    clearTimeout(errorDebounceTimer);

    errorDebounceTimer = setTimeout(() => {
      console.log("[AUTO-FIX TRIGGERED] Analyzing error buffer...");

      let currentDir = process.env.HOME;
      try {
        currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
      } catch (e) {}

      autoFixError(terminalBuffer, currentDir, io);
    }, 800);
  }
});

// =====================================================================
// --- 6. WEBSOCKET CONNECTION (CLIENT UI) ---
// =====================================================================
io.on('connection', (socket) => {
  console.log('Frontend connected to PTY');
  ptyProcess.write('clear\r');

  socket.on('input', data => { ptyProcess.write(data); });

  socket.on('ai-request', async (query) => {
    console.log(`[AI Request Captured]: "${query}"`);
    const normalizedQuery = query.trim().toLowerCase();

    // Cache Check
    const cachedResult = checkCache.get(normalizedQuery, hostOS);
    if (cachedResult) {
      console.log(`[CACHE HIT]: Returning saved command for ${hostOS}...`);
      ptyProcess.write(cachedResult.command);
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      ptyProcess.write(`echo "Error: GEMINI_API_KEY environment variable is missing."\r`);
      return;
    }

    try {
      console.log(`[CACHE MISS]: Asking Gemini with Stream...`);

      let currentDir = process.env.HOME;
      try {
        currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
      } catch (e) {}

      const localContext = await getLocalContext(query, currentDir);
      const augmentedQuery = `Context: Host OS is ${hostOS}.\nUser Query: ${query}${localContext}`;

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
          parts: [{ text: `You are an expert Linux terminal assistant running on ${hostOS}. Translate or provide the exact command requested. Output ONLY the raw, valid terminal command. Do not use formatting, backticks, or explanations.` }]
        },
          contents: [{ parts: [{ text: augmentedQuery }] }],
          generationConfig: { temperature: 0.1 }
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullGeneratedCommand = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkString = decoder.decode(value, { stream: true });

        const textMatches = chunkString.match(/"text":\s*"([^"]+)"/g);
        if (textMatches) {
           for (const match of textMatches) {
               let textPart = match.replace(/"text":\s*"/, '').slice(0, -1);
               textPart = textPart.replace(/\\n/g, '\n').replace(/\\"/g, '"');

               ptyProcess.write(textPart);
               fullGeneratedCommand += textPart;
           }
        }
      }

      fullGeneratedCommand = fullGeneratedCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();
      saveToCache.run(normalizedQuery, hostOS, fullGeneratedCommand);
      console.log(`[SAVED TO CACHE]: Mapped "${normalizedQuery}" for OS '${hostOS}'`);

    } catch (error) {
      console.error("API Error:", error.message);
      ptyProcess.write(`echo 'API Failed: ${error.message}'\r`);
    }
  });
});

// =====================================================================
// --- 7. EXPRESS SERVER STARTUP & AUTO-LAUNCH ---
// =====================================================================
app.use(express.static('public'));

server.listen(3000, () => {
  console.log('✨ AI Terminal Engine running on http://localhost:3000');
  
  // Cross-platform browser launch
  const url = 'http://localhost:3000';
  const startCommand = process.platform === 'darwin' ? 'open'
                     : process.platform === 'win32' ? 'start'
                     : 'xdg-open'; // Standard for Manjaro/Linux

  exec(`${startCommand} ${url}`, (err) => {
    if (err) {
      console.log(`[SYSTEM] Could not auto-launch browser. Please open ${url} manually.`);
    } else {
      console.log(`[SYSTEM] Auto-launching browser...`);
    }
  });
});