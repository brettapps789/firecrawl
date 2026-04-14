# File System MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that exposes local file system operations as tools for AI agents.

## Features

| Tool | Description |
|---|---|
| `read_file` | Read file contents (UTF-8 or base64) |
| `write_file` | Create or overwrite a file |
| `append_file` | Append content to a file |
| `list_directory` | List directory contents (optionally recursive) |
| `create_directory` | Create a directory (including parents) |
| `delete_file` | Delete a file or directory |
| `move_file` | Move or rename a file/directory |
| `copy_file` | Copy a file to a new location |
| `get_file_info` | Get file metadata (size, timestamps, permissions) |
| `search_files` | Search for files by name pattern |
| `search_file_contents` | Search file contents for matching text |
| `list_allowed_directories` | Show which directories are accessible |

## Security

All operations are sandboxed to the directories you specify at startup. Any attempt to access a path outside those directories is rejected with an error. This prevents directory traversal attacks.

## Usage

### Build

```bash
pnpm install
pnpm build
```

### Run

Pass one or more allowed directories as arguments:

```bash
node dist/index.js /path/to/project /another/safe/dir
```

If no directories are specified, the current working directory is used.

### Integrate with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-filesystem-server/dist/index.js",
        "/path/to/allowed/dir"
      ]
    }
  }
}
```

### Integrate with Cursor / VS Code

Add to `.cursor/mcp.json` or your editor's MCP config:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js", "${workspaceFolder}"]
    }
  }
}
```

## Development

```bash
# Run directly with tsx (no build required)
pnpm dev /path/to/allowed/dir

# Rebuild on change
pnpm build -- --watch
```

## Tool Reference

### `read_file`
```json
{ "path": "/allowed/dir/file.txt", "encoding": "utf8" }
```

### `write_file`
```json
{ "path": "/allowed/dir/file.txt", "content": "Hello, world!\n" }
```

### `list_directory`
```json
{ "path": "/allowed/dir", "recursive": true }
```

### `search_files`
```json
{ "directory": "/allowed/dir", "pattern": "*.ts", "maxResults": 50 }
```

### `search_file_contents`
```json
{ "directory": "/allowed/dir", "query": "TODO", "filePattern": "*.ts" }
```
