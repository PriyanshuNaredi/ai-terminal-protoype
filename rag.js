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
