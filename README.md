# Shai VS Code Extension

A VS Code extension that integrates the Shai AI assistant directly into your editor with a chat interface, streaming responses, internal reasoning visualization, Docker deployment management, and context-aware conversations.

## Features

- **Chat Interface**: Interactive chat panel in the VS Code sidebar with message history, markdown rendering, and actionable buttons
- **Streaming Responses**: Real-time response streaming via CLI or a long-running HTTP/SSE server mode
- **Internal Reasoning Panel**: Dedicated view that displays the model's thinking process as numbered steps in real time
- **Context Management**: Named conversation contexts with system prompts, auto-summarization, and a visual context editor
- **Docker Deployments**: Discover, deploy, and stop Docker Compose services directly from the sidebar with live log streaming
- **Multi-Provider Auth**: Configure and switch between AI providers (Anthropic, OpenAI, Mistral, OpenRouter, Ollama, OVHcloud, OpenAI-compatible) via a built-in wizard
- **WSL Support**: Automatic Windows ↔ WSL path conversion and command routing

## Installation

1. Install from the `.vsix` file:
   ```bash
   code --install-extension shai-vscode-0.0.5.vsix
   ```

2. Or build from source:
   ```bash
   npm install
   npm run compile
   vsce package
   ```

## Prerequisites

- VS Code 1.74.0 or higher
- Shai AI command-line tool installed and accessible in your PATH
- Docker (for deployment features)
- WSL on Windows (Shai and Docker commands are routed through WSL by default)

## Configuration

Open VS Code Settings (`Ctrl+,`) and search for "Shai VS Code":

| Setting | Default | Description |
|---|---|---|
| `shai-vscode.shaiCommand` | `shai` | Shell command to execute Shai AI (e.g. `/usr/local/bin/shai`, `python /path/to/shai.py`) |
| `shai-vscode.useWSL` | `null` | Run commands in WSL. `null` = auto-detect (WSL on Windows, native elsewhere). Set `true`/`false` to override. |
| `shai-vscode.useServer` | `false` | Start a long-running `shai server` process and communicate over HTTP/SSE instead of spawning a CLI per query. |
| `shai-vscode.serverUrl` | `http://127.0.0.1:8000` | URL of the local Shai HTTP/SSE server (only used when `useServer` is `true`). |

## Usage

### Chat

1. Click the Shai icon in the Activity Bar (left sidebar)
2. Type your question or command in the chat input
3. Press Enter or click Send
4. Streaming progress appears in the Internal Reasoning panel; the final answer is displayed in the chat bubble

### Context Management

Each conversation lives inside a named context. Contexts carry their own system prompt and conversation history (up to 20 turns, auto-summarized when the limit is reached).

- The active context name is shown in the status bar — click it to open the context editor
- Use the context editor to create, switch, or delete contexts and to set a system prompt
- Run `Shai: Open context editor` from the Command Palette

### Internal Reasoning

The reasoning panel extracts `<reasoning>`, `<resolution>`, and thinking blocks from the model output and renders them as numbered steps. It clears automatically before each new request.

Open it with `Shai: Show Internal Reasoning` from the Command Palette.

### Docker Deployments

The Deployments view in the sidebar discovers `docker-compose.yml` / `compose.yml` files at the workspace root.

- **Deploy** runs `docker compose up -d --build`
- **Stop** runs `docker compose down`
- Live logs stream into the panel during deployment
- A 10-minute timeout protects against runaway builds
- Concurrent deploys to the same file are blocked

### Authentication

Run `Shai: Profile configuration (auth.config)` to open the auth wizard. From there you can:

- Add a new provider profile (API key, model, endpoint)
- Activate or delete existing profiles
- Supported providers: Anthropic (Claude), OpenAI, Mistral, OpenRouter, Ollama, OVHcloud AI Endpoints, OpenAI-compatible

Profiles are stored in `~/.config/shai/auth.config` with `0600` permissions.

## Commands

| Command | Description |
|---|---|
| `Shai: Open Chat` | Open the chat panel |
| `Shai: Clear Chat` | Clear chat history for the active context |
| `Shai: Show Internal Reasoning` | Open the reasoning panel |
| `Shai: Profile configuration (auth.config)` | Open the auth wizard |
| `Shai: Open context editor` | Open the context editor |
| `Shai: Open Deployments` | Open the Docker deployments panel |

## Architecture

```
src/
├── extension.ts            # Entry point — registers views, controllers, commands
├── chat/
│   ├── controller.ts       # Manages sessions, contexts, interaction modes
│   ├── session.ts          # Non-streaming CLI execution with history
│   └── streaming.ts        # Streaming execution (CLI + HTTP/SSE server mode)
├── context/
│   ├── contextManager.ts   # Conversation turns, summaries, system prompts
│   └── promptBuilder.ts    # Enriches user messages with context
├── views/
│   ├── chatView.ts         # Chat webview (message rendering, action buttons)
│   ├── reasoningView.ts    # Internal reasoning webview
│   ├── deploymentsView.ts  # Docker deployment UI
│   └── contextEditorPanel.ts # Context editor UI
├── auth/
│   ├── authConfig.ts       # Auth config file I/O, provider definitions
│   └── authWizardPanel.ts  # Auth wizard webview
├── docker/
│   ├── dockerController.ts # Docker Compose lifecycle (deploy, stop, discover)
│   └── types.ts            # TypeScript interfaces
└── commands/
    └── commands.ts         # Command registrations
```

## Windows Support

The extension auto-detects Windows and routes Shai and Docker commands through WSL by default. Windows paths are converted automatically (e.g. `C:\Users\user` → `/mnt/c/Users/user`; WSL UNC paths like `\\wsl.localhost\Distro\home\user` → `/home/user`).

**Prerequisites for Windows:**
- WSL installed and working
- Shai AI installed inside your WSL environment
- Docker accessible from WSL (Docker Desktop with WSL 2 backend, or Docker Engine in WSL)

Set `shai-vscode.useWSL` to `false` if you want to run Docker and Shai natively on Windows.

## Troubleshooting

**Command not found (Windows)**
- Verify WSL: `wsl --version`
- Install Shai in WSL, not Windows
- Test: `wsl bash -c "shai hello"`

**Command not found (Linux/macOS)**
- Ensure Shai is in your PATH
- Set the full path in `shai-vscode.shaiCommand`

**Docker not found**
- Install Docker and ensure it is on the system PATH
- On Windows, make sure Docker Desktop's WSL integration is enabled

**No output / timeout**
- CLI commands time out after 5 minutes; Docker deployments after 10 minutes
- Check that Shai works in your terminal first

## Development

```bash
npm run compile      # Build once
npm run watch        # Rebuild on changes
vsce package         # Create .vsix
```

## Repository

[https://github.com/Sam9682/shai-vscode](https://github.com/Sam9682/shai-vscode)

## License

See [LICENSE](LICENSE) file for details.

## Version

0.0.5
