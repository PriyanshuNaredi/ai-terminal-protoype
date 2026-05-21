require('dotenv').config();
const { getLocalContext } = require('./rag.js');
const os = require('os');
const pty = require('node-pty');
const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server);


//////////////////////////
const Database = require('better-sqlite3');

// Initialize SQLite database (this creates a 'cache.db' file in your folder)
const db = new Database('cache.db');

// Create the cache table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS command_cache (
    query TEXT PRIMARY KEY,
    command TEXT
  )
`);

// Prepare our SQL statements for blazing-fast read/writes
const checkCache = db.prepare('SELECT command FROM command_cache WHERE query = ?');
const saveToCache = db.prepare('INSERT OR IGNORE INTO command_cache (query, command) VALUES (?, ?)');


//////////////////////////





// Manjaro defaults to zsh, but bash is universally safe. 
// You can change this to 'zsh' if you prefer.
const shell = 'bash'; 


// Create the Pseudo-Terminal
const ptyProcess = pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});


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
  ptyProcess.onData(data => { socket.emit('output', data); });
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
  socket.on('ai-request', async (query) => {
    console.log(`[AI Request Captured]: "${query}"`);
    const normalizedQuery = query.trim().toLowerCase();

    // 1. CHECK THE SQLITE CACHE FIRST
    const cachedResult = checkCache.get(normalizedQuery);
    if (cachedResult) {
      console.log(`[CACHE HIT]: Returning saved command...`);
      ptyProcess.write(cachedResult.command);
      return; // Exit early, no API call needed
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      ptyProcess.write(`echo "Error: GEMINI_API_KEY environment variable is missing."\r`);
      return;
    }

    try {
      console.log(`[CACHE MISS]: Asking Gemini with Stream...`);
      
      // 2. GET RAG CONTEXT
      const currentDir = ptyProcess.cwd || process.env.HOME; 
      const localContext = await getLocalContext(query, currentDir);
      const augmentedQuery = `User Query: ${query}${localContext}`;

      // 3. CALL GEMINI STREAMING API
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are an expert Linux terminal assistant running on Manjaro (Arch Linux). Translate or provide the exact command requested. Output ONLY the raw, valid terminal command. Do not use formatting, backticks, or explanations." }]
          },
          contents: [{ parts: [{ text: augmentedQuery }] }],
          generationConfig: { temperature: 0.1 }
        })
      });

      // 4. PROCESS THE STREAM
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
               
               // Type the chunk directly into the terminal immediately!
               ptyProcess.write(textPart);
               
               fullGeneratedCommand += textPart;
           }
        }
      }

      // 5. CLEANUP AND SAVE TO CACHE
      fullGeneratedCommand = fullGeneratedCommand.replace(/^```[a-z]*\n/gi, '').replace(/\n```$/g, '').trim();
      saveToCache.run(normalizedQuery, fullGeneratedCommand);
      console.log(`[SAVED TO CACHE]: Mapped "${normalizedQuery}" -> "${fullGeneratedCommand}"`);

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