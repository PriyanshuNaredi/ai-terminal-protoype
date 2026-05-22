const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { MemoryVectorStore } = require('@langchain/classic/vectorstores/memory');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');

async function getLocalContext(query, currentDirectory) {
  // Target files that provide the most context about a project
  const targetFiles = [
    'README.md', 
    'package.json', 
    'Makefile', 
    'docker-compose.yml', 
    'requirements.txt', 
    '.env.example'
  ];
  
  let combinedText = "";

  console.log(`[RAG] Scanning for project files in: ${currentDirectory}`);

  // Loop through and read any target files that exist in the directory
  for (const file of targetFiles) {
    const filePath = path.join(currentDirectory, file);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        // We inject the filename so the LLM knows what it's reading
        combinedText += `\n--- FILE: ${file} ---\n${content}\n`;
        console.log(`[RAG] Added ${file} to context.`);
      } catch (e) {
        console.log(`[RAG] Skipped ${file} (unreadable)`);
      }
    }
  }

  // If no files were found, return an empty string
  if (!combinedText) {
    console.log("[RAG] No target files found. Skipping embedding.");
    return "";
  }

  try {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50 });
    const docs = await splitter.createDocuments([combinedText]);

    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: process.env.GEMINI_API_KEY,
      model: "gemini-embedding-001",
    });

    const vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
    const results = await vectorStore.similaritySearch(query, 3); // Grab the top 3 chunks
    
    const context = results.map(r => r.pageContent).join('\n---\n');
    return `\n\nLOCAL CONTEXT FROM ${currentDirectory}:\n${context}`;

  } catch (error) {
    console.error("RAG Error:", error);
    return "";
  }
}

module.exports = { getLocalContext };



// const fs = require('fs');
// const path = require('path');
// const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
// // const { MemoryVectorStore } = require('langchain/vectorstores/memory');
// // const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
// // The updated modular import paths
// const { MemoryVectorStore } = require('@langchain/classic/vectorstores/memory');
// const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');


// async function getLocalContext(query, currentDirectory) {
//   // 1. Force it to look in the exact directory where this node app is running
//   const readmePath = path.join(__dirname, 'README.md'); 
  
//   console.log(`[RAG DEBUG] Looking for file at: ${readmePath}`); // Add this log!

//   if (!fs.existsSync(readmePath)) {
//     console.log("[RAG DEBUG] File does not exist!"); // Add this log!
//     return ""; 
//   }

//   try {
//     // 2. Read and chunk the file
//     const text = fs.readFileSync(readmePath, 'utf8');
//     const splitter = new RecursiveCharacterTextSplitter({
//       chunkSize: 500,
//       chunkOverlap: 50,
//     });
//     const docs = await splitter.createDocuments([text]);

//     // 3. Create the embedding model using your existing Gemini key
//     const embeddings = new GoogleGenerativeAIEmbeddings({
//       apiKey: process.env.GEMINI_API_KEY,
//       model: "gemini-embedding-001", // <-- Updated to the live 2026 model
//     });

//     // 4. Load the chunks into a temporary vector store
//     const vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);

//     // 5. Search for the most relevant pieces to the user's query
//     const results = await vectorStore.similaritySearch(query, 2);
    
//     // 6. Combine the results into a string
//     const context = results.map(r => r.pageContent).join('\n---\n');
//     return `\n\nLOCAL FILE CONTEXT:\n${context}`;

//   } catch (error) {
//     console.error("RAG Error:", error);
//     return "";
//   }
// }

// module.exports = { getLocalContext };