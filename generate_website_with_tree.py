#!/usr/bin/env python3
"""
Script to generate a website with hierarchical folder structure for documentation files.
"""

import os
import sys
from pathlib import Path

def create_folder_tree(root_path):
    """
    Create a hierarchical representation of folders and files.
    
    Args:
        root_path (str): Root directory to scan
        
    Returns:
        dict: Hierarchical structure of folders and files
    """
    tree = {}
    
    # Walk through the directory structure
    for dirpath, dirnames, filenames in os.walk(root_path):
        # Skip certain directories that aren't relevant for documentation
        if any(skip_dir in dirpath for skip_dir in ['.git', '.venv', 'node_modules', '__pycache__', '.vscode']):
            continue
            
        # Get relative path from root
        rel_path = os.path.relpath(dirpath, root_path)
        
        # Skip root directory itself
        if rel_path == '.':
            continue
            
        # Create path segments
        path_parts = rel_path.split(os.sep)
        
        # Navigate to the correct position in the tree
        current_level = tree
        for part in path_parts[:-1]:
            if part not in current_level:
                current_level[part] = {}
            current_level = current_level[part]
        
        # Add the current directory to the tree
        current_dir = path_parts[-1] if path_parts else ''
        if current_dir not in current_level:
            current_level[current_dir] = {}
            
        # Add files to the current directory
        current_level[current_dir]['files'] = []
        for filename in sorted(filenames):
            if filename.endswith('.html') or filename.endswith('.md'):
                current_level[current_dir]['files'].append(filename)
    
    return tree

def generate_html_tree(tree, base_url="", level=0):
    """
    Generate HTML for the folder tree structure.
    
    Args:
        tree (dict): Folder tree structure
        base_url (str): Base URL for links
        level (int): Current nesting level
        
    Returns:
        str: HTML string for the tree structure
    """
    html = ""
    
    # Only add opening tag at top level
    if level == 0:
        html += '        <div class="folder-tree">\n'
        html += '            <h2>Documentation Files by Folder Structure</h2>\n'
    
    for folder_name, content in tree.items():
        # Handle files in this folder
        if 'files' in content:
            files = content['files']
            # Create folder div
            html += f'            <div class="folder-item">\n'
            html += f'                <div class="folder-name">{folder_name}</div>\n'
            html += '                <div class="folder-files">\n'
            
            # Add files as links
            for file in sorted(files):
                # Convert file name to URL-friendly format
                file_url = file.replace('.md', '.html').replace(' ', '%20')
                file_title = file.replace('.md', '').replace('.html', '').replace('_', ' ').title()
                html += f'                    <a href="{base_url}{file_url}" class="file-link">{file_title}</a>\n'
            
            html += '                </div>\n'
            html += '            </div>\n'
        else:
            # Recursive case for nested folders
            html += f'            <div class="folder-item">\n'
            html += f'                <div class="folder-name">{folder_name}</div>\n'
            html += '                <div class="folder-content">\n'
            html += generate_html_tree(content, base_url, level + 1)
            html += '                </div>\n'
            html += '            </div>\n'
    
    # Only add closing tag at top level
    if level == 0:
        html += '        </div>\n'
    
    return html

def create_index_page_with_tree():
    """
    Create an index page with hierarchical folder structure.
    """
    # Define the root directory to scan for documentation files
    root_dir = "/home/slepetre/workspace/shai-vscode"
    
    # Create the folder tree
    tree = create_folder_tree(root_dir)
    
    # Generate the HTML content
    html_content = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OPCP Documentation Index with Tree Structure</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 1000px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            color: #333;
            background-color: #f8f9fa;
        }
        .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 2px solid #dee2e6;
            margin-bottom: 30px;
        }
        h1 {
            color: #2c3e50;
            margin-bottom: 10px;
        }
        .subtitle {
            color: #6c757d;
            font-size: 1.1em;
        }
        .page-links {
            background-color: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .page-link {
            display: block;
            padding: 15px;
            margin: 10px 0;
            background-color: #e9ecef;
            border-radius: 5px;
            text-decoration: none;
            color: #2c3e50;
            transition: background-color 0.3s;
            border-left: 4px solid #007bff;
        }
        .page-link:hover {
            background-color: #d1d9e6;
            transform: translateX(5px);
        }
        .page-title {
            font-weight: bold;
            font-size: 1.1em;
            margin-bottom: 5px;
        }
        .page-description {
            font-size: 0.9em;
            color: #6c757d;
        }
        .folder-tree {
            margin-top: 20px;
        }
        .folder-item {
            margin: 10px 0;
            padding: 10px;
            background-color: #f1f3f5;
            border-radius: 5px;
        }
        .folder-name {
            font-weight: bold;
            color: #2c3e50;
            margin-bottom: 10px;
        }
        .folder-files {
            margin-left: 20px;
        }
        .file-link {
            display: block;
            padding: 5px;
            margin: 3px 0;
            background-color: #e9ecef;
            border-radius: 3px;
            text-decoration: none;
            color: #2c3e50;
        }
        .file-link:hover {
            background-color: #d1d9e6;
        }
        .footer {
            margin-top: 30px;
            text-align: center;
            color: #6c757d;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>OPCP Documentation Index</h1>
        <div class="subtitle">This website contains all extracted documentation from OPCP training materials.</div>
    </div>
    
    <div class="page-links">
        <a href="opcp-wiki.html" class="page-link">
            <div class="page-title">OPC-Wiki: Outdated and Incorrect Documentation</div>
            <div class="page-description">Documents known issues, outdated information, and incorrect documentation found in the project documentation.</div>
        </a>
        
        <a href="content.html" class="page-link">
            <div class="page-title">Main Content Documentation</div>
            <div class="page-description">Comprehensive documentation covering all aspects of the OPCP project.</div>
        </a>
        
        <a href="README.html" class="page-link">
            <div class="page-title">Project README</div>
            <div class="page-description">Overview of the Shai VS Code Extension including features, installation, and usage instructions.</div>
        </a>
        
        <a href="SETUP_GUIDE.html" class="page-link">
            <div class="page-title">Setup Guide</div>
            <div class="page-description">Detailed instructions for setting up and configuring the Shai VS Code Extension.</div>
        </a>
    </div>
    
"""
    
    # Add the tree structure
    html_content += generate_html_tree(tree, "", 0)
    
    # Close the HTML
    html_content += """
    
    <div class="footer">
        <p>Documentation generated on March 5, 2026</p>
    </div>
</body>
</html>"""
    
    # Write to file
    with open("index_with_tree.html", "w") as f:
        f.write(html_content)
    
    print("Generated index_with_tree.html with folder hierarchy")

if __name__ == "__main__":
    create_index_page_with_tree()