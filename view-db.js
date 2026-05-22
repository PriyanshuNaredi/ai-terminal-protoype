const Database = require('better-sqlite3');

// Connect to your cache file
const db = new Database('cache.db');

// Fetch everything from the v2 table
const rows = db.prepare('SELECT * FROM command_cache_v2').all();

// Print it as a beautiful table
console.log("\n--- AI TERMINAL CACHE ---");
console.table(rows);