const Database = require('better-sqlite3');

// Connect to your cache file
const db = new Database('cache.db');

// Fetch everything from the v2 table
const rows = db.prepare('SELECT * FROM translation_cache').all();

// Print it as a beautiful table
console.log("\n--- AI TERMINAL CACHE ---");
console.table(rows);

// // Fetch everything from the v2 table
// const rows1 = db.prepare('SELECT * FROM autofix_cache').all();

// // Print it as a beautiful table
// console.log("\n---  CACHE ---");
// console.table(rows1);