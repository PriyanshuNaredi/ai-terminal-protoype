#!/usr/bin/env node
require('dotenv').config();
const os = require('os');
const fs = require('fs');
const { exec } = require('child_process');
const pty = require('node-pty');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const Database = require('better-sqlite3');
const { getLocalContext } = require('./rag.js');

// =====================================================================
// --- 1. SYSTEM OS DETECTION ---
// =====================================================================
let hostOS = 'linux';
try {
  // Sniff the true Linux distribution from the system files
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  const match = osRelease.match(/^ID=([^\n]+)/m);
  if (match) hostOS = match[1].replace(/"/g, ''); // e.g., 'manjaro', 'ubuntu'
} catch (e) {}

console.log(`[SYSTEM]: Detected Host OS as '${hostOS}'`);

// =====================================================================
// --- 2. DUAL-CACHE SQLITE INITIALIZATION ---
// =====================================================================
const db = new Database('cache.db');

db.exec(`
  -- Table 1: The Cross-Distro & Query Cache
  CREATE TABLE IF NOT EXISTS translation_cache (
    query TEXT,
    os_name TEXT,
    command TEXT,
    PRIMARY KEY (query, os_name)
  );

  -- Table 2: The Typo & Auto-Fix Ledger
  CREATE TABLE IF NOT EXISTS autofix_cache (
    error_signature TEXT,
    os_name TEXT,
    fixed_command TEXT,
    PRIMARY KEY (error_signature, os_name)
  );
`);

// Prepared statements for Translations (Intentional Questions)
const checkTranslation = db.prepare('SELECT command FROM translation_cache WHERE query = ? AND os_name = ?');
const saveTranslation = db.prepare('INSERT OR REPLACE INTO translation_cache (query, os_name, command) VALUES (?, ?, ?)');

// Prepared statements for Auto-Fixes (Accidental Typos)
const checkAutofix = db.prepare('SELECT fixed_command FROM autofix_cache WHERE error_signature = ? AND os_name = ?');
const saveAutofix = db.prepare('INSERT OR REPLACE INTO autofix_cache (error_signature, os_name, fixed_command) VALUES (?, ?, ?)');

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
// --- 4. AI AUTO-FIXER ENGINE (WITH SANITIZATION) ---
// =====================================================================
async function autoFixError(errorBuffer, currentDirectory, io) {
  // 1. NUKE ALL INVISIBLE TERMINAL GHOSTS (ANSI Codes & Carriage Returns)
  let cleanBuffer = errorBuffer.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ''); // Strip colors
  cleanBuffer = cleanBuffer.replace(/\r/g, ''); // Strip carriage returns

  // 2. CREATE A BULLETPROOF CACHE KEY
  const cleanLines = cleanBuffer.split('\n').map(line => line.trim());
  const errorLines = cleanLines.filter(line => /command not found|command not f ound|Error:|ERR!|fatal:|Traceback|Exception/i.test(line));
  
  // Extract ONLY the exact line containing the error to ignore sudo noise
  const errorSignature = errorLines.length > 0 ? errorLines.pop() : cleanBuffer.trim().slice(-100);

  // 3. CHECK THE TYPO CACHE FIRST
  const cachedFix = checkAutofix.get(errorSignature, hostOS);
  if (cachedFix) {
    console.log(`[AUTO-FIX CACHE HIT]: Resolving known error: "${errorSignature}"`);
    io.emit('output', `\r\n\x1b[36m✨ AI Auto-Fix Suggestion (Cached):\x1b[0m\r\n`);
    ptyProcess.write(cachedFix.fixed_command);
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  try {
    console.log(`[AUTO-FIX CACHE MISS]: Asking Gemini to fix: "${errorSignature}"`);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: `You are an AI auto-fixer running on ${hostOS}. 
            Analyze the provided terminal buffer and focus ONLY on the most recent error at the very bottom.
            Provide ONLY the raw, exact terminal command to fix this final error.
            Do NOT provide explanations.
            If the error is unfixable via command line or not a real error, output EXACTLY the word: NONE.`
          }]
        },
        contents: [{ parts: [{ text: `Directory: ${currentDirectory}\nTerminal Output:\n${cleanBuffer}` }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const data = await response.json();
    let fixCommand = data.candidates[0].content.parts[0].text.trim();
    fixCommand = fixCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();

    if (fixCommand !== 'NONE' && fixCommand !== '') {
      // SAVE TO TYPO LEDGER
      saveAutofix.run(errorSignature, hostOS, fixCommand);
      console.log(`[AUTO-FIX SAVED]: Logged "${errorSignature}" into Typo Ledger`);
      
      // Inject UI styling directly to browser, then type command into shell
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
  // Broadcast terminal output to any connected browser tab
  io.emit('output', data);

  // Maintain a rolling buffer of the last 2500 characters
  terminalBuffer += data;
  if (terminalBuffer.length > 2500) {
    terminalBuffer = terminalBuffer.slice(-2500);
  }

  // Sniff for common error patterns
  const errorPatterns = /command not found|command not f ound|Error:|ERR!|fatal:|Traceback|Exception/i;

  if (errorPatterns.test(data)) {
    clearTimeout(errorDebounceTimer);

    // Wait 800ms for the error trace to finish printing
    errorDebounceTimer = setTimeout(() => {
      console.log("[AUTO-FIX TRIGGERED] Analyzing error buffer...");

      // Grab the true directory so the AI knows where the error happened
      let currentDir = process.env.HOME;
      try {
        currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
      } catch (e) {}

      // Fire the auto-fixer
      autoFixError(terminalBuffer, currentDir, io);

      // WIPE THE MEMORY BUFFER so the AI doesn't hallucinate past errors
      terminalBuffer = "";
    }, 800);
  }
});

// =====================================================================
// --- 6. WEBSOCKET CONNECTION (CLIENT UI) ---
// =====================================================================
io.on('connection', (socket) => {
  console.log('Frontend connected to PTY');
  
  // Simulate pressing 'Enter' to force a fresh prompt line on refresh
  ptyProcess.write('clear\r');

  socket.on('input', data => { ptyProcess.write(data); });

  // --- THE INTENTIONAL AI QUERY ROUTE ---
  socket.on('ai-request', async (query) => {
    console.log(`[AI Request Captured]: "${query}"`);
    const normalizedQuery = query.trim().toLowerCase();

    // 1. CHECK THE TRANSLATION CACHE
    const cachedResult = checkTranslation.get(normalizedQuery, hostOS);
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

      // Get True Directory
      let currentDir = process.env.HOME;
      try {
        currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
      } catch (e) {}

      // Fetch RAG Context
      const localContext = await getLocalContext(query, currentDir);
      const augmentedQuery = `Context: Host OS is ${hostOS}.\nUser Query: ${query}${localContext}`;

      // Call Streaming API
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are an expert Linux terminal assistant. Translate or provide the exact command requested for the user's specific OS. Output ONLY the raw, valid terminal command. Do not use formatting, backticks, or explanations." }]
          },
          contents: [{ parts: [{ text: augmentedQuery }] }],
          generationConfig: { temperature: 0.1 }
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullGeneratedCommand = "";

      // Process live token stream
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

      // 2. CLEANUP AND SAVE TO TRANSLATION CACHE
      fullGeneratedCommand = fullGeneratedCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();
      saveTranslation.run(normalizedQuery, hostOS, fullGeneratedCommand);
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

  // Cross-platform browser auto-launch
  const url = 'http://localhost:3000';
  const startCommand = process.platform === 'darwin' ? 'open'
                     : process.platform === 'win32' ? 'start'
                     : 'xdg-open';

  exec(`${startCommand} ${url}`, (err) => {
    if (err) {
      console.log(`[SYSTEM] Could not auto-launch browser. Please open ${url} manually.`);
    } else {
      console.log(`[SYSTEM] Auto-launching browser UI...`);
    }
  });
});