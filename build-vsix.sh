#!/bin/bash

# Build the VSIX file using vsce
echo "Building VSIX file..."

# Check if vsce is installed
if ! command -v vsce &> /dev/null; then
    echo "vsce could not be found. Installing..."
    npm install -g @vscode/vsce
fi

# Package the extension
vsce package

echo "VSIX file created successfully!"