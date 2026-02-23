# Shai VS Code Extension

A VS Code extension that integrates Shai AI assistant directly into your editor with a chat interface.

## Features

- **Chat Interface**: Interactive chat panel in VS Code sidebar
- **Shell Integration**: Executes Shai AI commands directly through your system shell
- **Workspace Aware**: Runs commands in your current workspace context
- **Customizable**: Configure the Shai command path in settings

## Installation

1. Install the extension from the `.vsix` file:
   ```bash
   code --install-extension shai-vscode-0.0.1.vsix
   ```

2. Or build from source:
   ```bash
   npm install
   npm run compile
   ```

## Prerequisites

- VS Code version 1.74.0 or higher
- Shai AI command-line tool installed and accessible in your PATH

## Configuration

Open VS Code Settings (Ctrl+,) and search for "Shai VS Code":

- **shai-vscode.shaiCommand**: Shell command to execute Shai AI
  - Default: `shai`
  - Examples: `/usr/local/bin/shai`, `python /path/to/shai.py`, `./shai`

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

### Watch Mode

```bash
npm run watch
```

### Package Extension

```bash
npx vsce package
```

## Troubleshooting

**Error: Command not found**
- Ensure Shai AI is installed and in your PATH
- Configure the full path in settings: `shai-vscode.shaiCommand`

**No output from commands**
- Check that your Shai command is working in terminal
- Verify workspace folder permissions

## Repository

[https://github.com/Sam9682/shai-vscode](https://github.com/Sam9682/shai-vscode)

## License

See [LICENSE](LICENSE) file for details.

## Version

0.0.1 - Initial release
