# Shai VS Code Extension

A VS Code extension that integrates Shai AI assistant directly into your editor with a chat interface.

## Installation

1. Install the extension from the `.vsix` file:
   ```bash code --install-extension shai-vscode-0.0.1.vsix```

2. Or build from source:
   ```bash npm install
   npm run compile```

## Prerequisites

- VS Code version 1.74.0 or higher
- Shai AI command-line tool installed and accessible in your PATH

## Configuration

Open VS Code Settings (Ctrl+,) and search for "Shai VS Code":

- **shai-vscode.shaiCommand**: Shell command to execute Shai AI
  - Default: `shai`
  - Examples: `/usr/local/bin/shai`, `python /path/to/shai.py`, `./shai`

- **shai-vscode.useWSL**: Run Shai command in WSL bash environment
  - Default: `null` (auto-detect: uses WSL on Windows, native shell on Linux/Mac)
  - Set to `true` to force WSL usage
  - Set to `false` to force native shell usage

- **shai-vscode.useServer**: When enabled the extension starts a single
  long‑running `shai server` process and communicates with it over HTTP
  using Server‑Sent Events (SSE).  This eliminates the artificial
  "Analyzing…"/"Error…" stages and allows the UI to render partial
  responses as they arrive.  Requires that your `shai` executable support
  a `server` subcommand (or equivalent) and that the URL below matches
  where it listens.
- **shai-vscode.serverUrl**: URL of the local Shai HTTP/SSE server (default
  `http://127.0.0.1:8000`).  Only used when `useServer` is `true`.

## Usage

1. Click the Shai icon in the Activity Bar (left sidebar)
2. Type your question or command in the chat input
3. Press Enter or click Send
4. Shai AI will process your request and display the response

### Example Commands

- `hello` - Greet Shai AI
- `list all files in the current folder` - Execute file listing
- Any command that your Shai AI tool supports

## Development

### Build

```bash
npm run compile
```

### Package Extension

```bash
npx vsce package
```

## Windows Support

The extension automatically detects Windows and runs Shai commands through WSL bash, since Shai AI is only available for Linux/Mac. Windows paths are automatically converted to WSL format (e.g., `C:\Users\user` becomes `/mnt/c/Users/user`).

**Prerequisites for Windows:**
- WSL (Windows Subsystem for Linux) installed
- Shai AI installed in your WSL environment
