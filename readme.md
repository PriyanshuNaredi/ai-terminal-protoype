# ⚡ AI Terminal Engine (`aiterm`)

A context-aware, self-healing, cross-distro AI terminal emulator built with Node.js and the Gemini API. 

This is not just an AI wrapper; it is a native pseudo-terminal (PTY) that actively monitors your standard output, reads your local files to understand your project structure, instantly translates commands across operating systems, and autonomously fixes your typos before you even have to ask.

## ✨ Core Features

* **🧠 Deep-Indexing RAG:** The terminal has "eyes." It actively scans your current working directory for `package.json`, `requirements.txt`, `Makefile`, and other config files to understand the specific project you are working in.
* **🩹 Self-Learning Auto-Fixer:** Actively monitors your `stderr` stream. If you trigger an error (e.g., `command not found`), the engine intercepts the traceback, generates the correct command, and injects it directly onto your prompt.
* **🌍 Cross-Distro Translator:** Type an Ubuntu command (`apt`) on Arch Linux, or a Fedora command (`dnf`) on macOS. The AI detects your host OS via `/etc/os-release` and instantly translates the syntax.
* **💾 Dual-Cache SQLite Brain:** Zero-latency retrieval. The engine stores successful translations and fixed typos locally. If you make the same mistake twice, it fixes it instantly offline without hitting the API.
* **🌊 Live Token Streaming:** Responses pipe directly from Google's neural network to your screen character-by-character for a hyper-responsive UI.
* **🚀 Global Execution:** Packaged as a global binary. Type `aiterm` in any directory to instantly boot the backend and auto-launch the UI in your browser.

## 🛠️ Tech Stack

* **Backend:** Node.js, Express.js
* **System Integration:** `node-pty` (Native shell bridging), `child_process`
* **Data Layer:** `better-sqlite3`
* **AI & Embeddings:** Google Gemini (`gemini-3.1-flash-lite`), LangChain
* **Real-time Comms:** Socket.io

## 📦 Installation

**1. Clone the repository and install dependencies:**
```bash
git clone [https://github.com/yourusername/ai-terminal.git](https://github.com/yourusername/ai-terminal.git)
cd ai-terminal
npm install
2. Configure your Environment:
Create a .env file in the root directory and add your Google Gemini API key:

Code snippet


GEMINI_API_KEY=your_google_api_key_here
PORT=3000
3. Link the Global Binary:
Make the terminal accessible from anywhere on your machine:

Bash


sudo npm link
💻 Usage
Once installed globally, you can launch the AI Terminal from any directory on your machine.

Bash


aiterm
This command spins up the local Express server, connects the native PTY to your current working directory, and automatically opens the terminal UI in your default web browser.

Intentional Queries
Hit Ctrl+Space (or your configured hotkey) to intercept the prompt and ask a natural language question. The AI will read your local directory context and stream the exact terminal command back to you.

User: "install python and git"
AI: sudo pacman -S python git

Autonomous Auto-Fixing
Just type normally. If you make a typo or trigger a standard traceback, the background engine will catch it, sanitize the buffer, and drop the fix on your screen.

User: gitt init
Bash: bash: gitt: command not found
UI: ✨ AI Auto-Fix Suggestion: git init

🏗️ Architecture
The Shell Bridge: node-pty spawns a master bash process.

The Error Sniffer: A rolling 2,500-character buffer constantly sanitizes ANSI color codes and carriage returns, searching for regex error signatures.

The Semantic Cache: * translation_cache: Stores intentional queries.

autofix_cache: Stores error signatures and their resolutions.

📝 License
MIT License