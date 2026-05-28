# ⚡ AI Terminal Engine (`aiterm`)

A context-aware, self-healing, cross-platform AI terminal emulator built with Node.js, Electron, and the Gemini API.

This is not just an AI wrapper; it is a native pseudo-terminal (PTY) that actively monitors your standard output, reads your local files to understand your project structure, instantly translates commands across operating systems, and autonomously fixes your typos before you even have to ask.

## ✨ Core Features

* **🧠 Deep-Indexing RAG:** The terminal has "eyes." It actively scans your current working directory for `package.json`, `requirements.txt`, `Makefile`, and other config files to understand the specific project you are working in.
* **🩹 Self-Learning Auto-Fixer:** Actively monitors your `stderr` stream. If you trigger an error (e.g., `command not found`), the engine intercepts the traceback, generates the correct command, and injects it directly onto your prompt.
* **🌍 Cross-Platform Translator:** Type an Ubuntu command (`apt`) on Arch Linux, or a Fedora command (`dnf`) on macOS. The AI detects your host OS and instantly translates the syntax.
* **💾 Dual-Cache SQLite Brain:** Zero-latency retrieval. The engine stores successful translations and fixed typos locally. If you make the same mistake twice, it fixes it instantly offline without hitting the API.
* **🌊 Live Token Streaming:** Responses pipe directly from Google's neural network to your screen character-by-character for a hyper-responsive UI.
* **🖥️ Desktop Application:** Packaged as a cross-platform Electron application for a native desktop experience.

## 🛠️ Tech Stack

* **Desktop Framework:** Electron
* **Backend:** Node.js, Express.js
* **System Integration:** `node-pty` (Native shell bridging), `child_process`
* **Data Layer:** `better-sqlite3`
* **AI & Embeddings:** Google Gemini (`gemini-3.1-flash-lite`), LangChain
* **Real-time Comms:** Socket.io
* **Frontend:** xterm.js (terminal renderer)

## 📦 Installation & Setup

### 1. Clone the repository and install dependencies

```bash
git clone https://github.com/PriyanshuNaredi/ai-terminal.git
cd ai-terminal
npm install
```

### 2. Configure your Environment

The app will prompt you for an API key in the UI, or you can create a `.env` file in the root directory and add your Google Gemini API key:

```env
GEMINI_API_KEY=your_google_api_key_here
PORT=3000
```

### 3. Run the App Locally

To start the Electron application in development mode:

```bash
npm start
```

### 4. Build for Production

You can build standalone executable binaries for your operating system using `electron-builder`:

```bash
# For Windows
npm run build:win

# For Linux
npm run build:linux

# For macOS
npm run build:mac
```

## 💻 Usage

When the application launches, you will see a native terminal window connected to your current environment.

### Intentional Queries

Hit `Ctrl+Space` (or your configured hotkey) to intercept the prompt and ask a natural language question. The AI will read your local directory context and stream the exact terminal command back to you.

```
User: "install python and git"
AI:   sudo pacman -S python git
```

### Autonomous Auto-Fixing

Just type normally. If you make a typo or trigger a standard traceback, the background engine will catch it, sanitize the buffer, and drop the fix on your screen.

```
User:  gitt init
Bash:  bash: gitt: command not found
UI:    ✨ AI Auto-Fix Suggestion: git init
```

## 🏗️ Architecture

1. **The Desktop Shell:** Electron provisions the native window and spawns the Express backend.
2. **The Shell Bridge:** `node-pty` spawns a master shell process (bash on Linux/macOS, PowerShell on Windows).
3. **The Error Sniffer:** A rolling 2,500-character buffer constantly sanitizes ANSI color codes and carriage returns, searching for regex error signatures.
4. **The Semantic Cache:**
   * `translation_cache`: Stores intentional queries and their OS-specific command translations.
   * `autofix_cache`: Stores error signatures and their resolutions.
5. **The RAG Engine:** Scans local project files, chunks and embeds them via LangChain, then retrieves the most relevant context for AI prompts.

## 📝 License

MIT License