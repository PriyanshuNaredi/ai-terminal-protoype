require('dotenv').config();
const os = require('os');
const fs = require('fs'); // ADD THIS
const pty = require('node-pty');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);
const Database = require('better-sqlite3');
const { getLocalContext } = require('./rag.js');


// --- 1. SNIFF THE EXACT LINUX DISTRO ---
let hostOS = 'linux';
try {
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  const match = osRelease.match(/^ID=([^\n]+)/m);
  if (match) hostOS = match[1].replace(/"/g, ''); // e.g., 'manjaro', 'ubuntu', 'fedora'
} catch (e) {}

console.log(`[SYSTEM]: Detected Host OS as '${hostOS}'`);

//////////////////////////
const db = new Database('cache.db');

// Create a v2 table that includes the OS
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


//////////////////////////

const shell = 'bash'; 


// Create the Pseudo-Terminal
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});


//////
// Add 'io' as the third parameter
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
            text: `You are an AI auto-fixer running on Manjaro Linux. The user just encountered an error in their terminal. 
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
      
      // FIX: Emit the color message directly to the frontend UI!
      io.emit('output', `\r\n\x1b[36m✨ AI Auto-Fix Suggestion:\x1b[0m\r\n`);
      
      // Then "type" the actual command into the Linux prompt
      ptyProcess.write(fixCommand);
    }
  } catch (error) {
    console.error("[AUTO-FIX FAILED]:", error.message);
  }
}
//////

// io.on('connection', (socket) => {
//   console.log('Frontend connected to PTY');


//   // 1. Read from the PTY, send to the frontend
//   ptyProcess.onData(data => {
//     socket.emit('output', data);
//   });


//   // 2. Read from the frontend, send to the PTY
//   socket.on('input', data => {
//     ptyProcess.write(data);
//   });
// });

io.on('connection', (socket) => {
  console.log('Frontend connected to PTY');

  // Add this line: Simulate pressing 'Enter' to force a fresh prompt line
  ptyProcess.write('clear\r');

  // Standard PTY routing
  // ptyProcess.onData(data => { socket.emit('output', data); });
  // State variables for the Auto-Fixer
  let terminalBuffer = "";
  let errorDebounceTimer = null;

  // The Upgraded Data Stream
  ptyProcess.onData(data => { 
    socket.emit('output', data); 

    // 1. Maintain a rolling buffer of the last 2500 characters
    terminalBuffer += data;
    if (terminalBuffer.length > 2500) {
      terminalBuffer = terminalBuffer.slice(-2500);
    }

    // 2. Sniff for common error patterns
    const errorPatterns = /command not found|command not f ound|Error:|ERR!|fatal:|Traceback|Exception/i;
    
    if (errorPatterns.test(data)) {
      // Clear the timer if it's still printing
      clearTimeout(errorDebounceTimer);

      // 3. Wait 800ms for the error trace to finish printing
      errorDebounceTimer = setTimeout(() => {
        console.log("[AUTO-FIX TRIGGERED] Analyzing error buffer...");
        
        // Grab the true directory so the AI knows where the error happened
        let currentDir = process.env.HOME;
        try {
          currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
        } catch (e) {}

        // Fire the background fixer
        autoFixError(terminalBuffer, currentDir);
      }, 800);
    }
  });

  socket.on('input', data => { ptyProcess.write(data); });

// --- THE NEW AI INTERCEPT ROUTE ---
//   socket.on('ai-request', async (query) => {
//     console.log(`[AI Request Captured]: "${query}"`);
    
//     // MOCK LLM DELAY (Simulating network request)
//     setTimeout(() => {
//       // 1. Pretend the LLM generated this command based on the query
//       const mockGeneratedCommand = `echo "You asked: ${query}. Imagine I am a real LLM writing a command here."`;
      
//       // 2. Inject it into the PTY Master. 
//       // We do NOT execute it (no \r). We just type it out for the user to see/edit.
//       ptyProcess.write(mockGeneratedCommand);
      
//     }, 500); // 500ms fake latency
//   });

// --- THE GEMINI RAG INTERCEPT ROUTE ---
  // --- THE CACHED GEMINI INTERCEPT ROUTE ---
  // --- THE FULLY LOADED AI ROUTE (RAG + SQLite Cache + Token Streaming) ---
  // --- THE FULLY LOADED, OS-AWARE AI ROUTE ---
  socket.on('ai-request', async (query) => {
    console.log(`[AI Request Captured]: "${query}"`);
    const normalizedQuery = query.trim().toLowerCase();

    // 1. CHECK THE OS-AWARE CACHE FIRST
    const cachedResult = checkCache.get(normalizedQuery, hostOS);
    if (cachedResult) {
      console.log(`[CACHE HIT]: Returning saved command for ${hostOS}...`);
      ptyProcess.write(cachedResult.command);
      return; // Exit early, no API call needed!
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      ptyProcess.write(`echo "Error: GEMINI_API_KEY environment variable is missing."\r`);
      return;
    }

    try {
      console.log(`[CACHE MISS]: Asking Gemini with Stream...`);
      
      // 2. GET THE TRUE CURRENT DIRECTORY (Linux Magic)
      let currentDir = process.env.HOME;
      try {
        // Read the symlink of the shell's PID to find exactly where the user 'cd'd to
        currentDir = fs.readlinkSync(`/proc/${ptyProcess.pid}/cwd`);
      } catch (e) {
        console.error("Could not read real cwd, falling back to home.");
      }

      // 3. FETCH RAG CONTEXT
      const localContext = await getLocalContext(query, currentDir);
      
      // Inject the specific OS into the query to ensure accurate cross-distro translations
      const augmentedQuery = `Context: Host OS is ${hostOS}.\nUser Query: ${query}${localContext}`;

      // 4. CALL GEMINI STREAMING API
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

      // 5. PROCESS THE STREAM
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let fullGeneratedCommand = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunkString = decoder.decode(value, { stream: true });
        
        // Extract text from the stream chunks
        const textMatches = chunkString.match(/"text":\s*"([^"]+)"/g);
        if (textMatches) {
           for (const match of textMatches) {
               let textPart = match.replace(/"text":\s*"/, '').slice(0, -1);
               textPart = textPart.replace(/\\n/g, '\n').replace(/\\"/g, '"');
               
               // Type the chunk directly into the terminal immediately
               ptyProcess.write(textPart);
               
               fullGeneratedCommand += textPart;
           }
        }
      }

      // 6. CLEANUP AND SAVE TO CACHE
      fullGeneratedCommand = fullGeneratedCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();
      saveToCache.run(normalizedQuery, hostOS, fullGeneratedCommand);
      console.log(`[SAVED TO CACHE]: Mapped "${normalizedQuery}" for OS '${hostOS}'`);

    } catch (error) {
      console.error("API Error:", error.message);
      ptyProcess.write(`echo 'API Failed: ${error.message}'\r`);
    }
  });

});

app.use(express.static('public'));


server.listen(3000, () => {
  console.log('AI Terminal Engine running on http://localhost:3000');
});