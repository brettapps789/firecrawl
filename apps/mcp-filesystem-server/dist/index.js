#!/usr/bin/env node
/**
 * File System MCP Server
 *
 * Exposes file system operations as MCP tools so that AI agents can read,
 * write, search, and manage files within an allowed set of directories.
 *
 * Allowed base directories are provided as command-line arguments:
 *   node dist/index.js /path/to/dir1 /path/to/dir2
 *
 * If no directories are provided, the current working directory is used.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
// ---------------------------------------------------------------------------
// Allowed directories
// ---------------------------------------------------------------------------
function normalizePath(p) {
    return path.normalize(path.resolve(p));
}
const rawDirs = process.argv.slice(2);
const allowedDirs = rawDirs.length > 0
    ? rawDirs.map(normalizePath)
    : [normalizePath(process.cwd())];
/**
 * Validate that the resolved target path is inside one of the allowed
 * directories to prevent directory-traversal attacks.
 */
function validatePath(target) {
    const resolved = normalizePath(target);
    const allowed = allowedDirs.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));
    if (!allowed) {
        throw new McpError(ErrorCode.InvalidParams, `Access denied: "${resolved}" is not within an allowed directory (${allowedDirs.join(", ")})`);
    }
    return resolved;
}
// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const server = new Server({ name: "filesystem", version: "0.1.0" }, { capabilities: { tools: {} } });
// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "read_file",
            description: "Read the complete contents of a file. Returns the file content as a string. Use this to inspect source code, configuration files, logs, etc.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to the file to read.",
                    },
                    encoding: {
                        type: "string",
                        enum: ["utf8", "base64"],
                        description: 'Text encoding to use. Defaults to "utf8". Use "base64" for binary files.',
                        default: "utf8",
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "write_file",
            description: "Create or overwrite a file with the supplied content. Parent directories are created automatically if they do not exist.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path of the file to write.",
                    },
                    content: {
                        type: "string",
                        description: "Content to write to the file.",
                    },
                    encoding: {
                        type: "string",
                        enum: ["utf8", "base64"],
                        description: 'Encoding of the supplied content. Defaults to "utf8".',
                        default: "utf8",
                    },
                },
                required: ["path", "content"],
            },
        },
        {
            name: "append_file",
            description: "Append content to the end of an existing file. Creates the file if it does not exist.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path of the file to append to.",
                    },
                    content: {
                        type: "string",
                        description: "Content to append.",
                    },
                },
                required: ["path", "content"],
            },
        },
        {
            name: "list_directory",
            description: "List the contents of a directory. Returns an array of entries with name, type (file/directory), size, and last-modified date.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to the directory to list.",
                    },
                    recursive: {
                        type: "boolean",
                        description: "If true, list all descendants recursively. Defaults to false.",
                        default: false,
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "create_directory",
            description: "Create a directory (and any missing parent directories).",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path of the directory to create.",
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "delete_file",
            description: "Delete a file or an empty directory.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path of the file or directory to delete.",
                    },
                    recursive: {
                        type: "boolean",
                        description: "If true, delete directory and all its contents recursively. Defaults to false.",
                        default: false,
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "move_file",
            description: "Move or rename a file or directory. Overwrites the destination if it already exists and is a file.",
            inputSchema: {
                type: "object",
                properties: {
                    source: {
                        type: "string",
                        description: "Absolute or relative source path.",
                    },
                    destination: {
                        type: "string",
                        description: "Absolute or relative destination path.",
                    },
                },
                required: ["source", "destination"],
            },
        },
        {
            name: "copy_file",
            description: "Copy a file to a new location. Parent directories are created automatically.",
            inputSchema: {
                type: "object",
                properties: {
                    source: {
                        type: "string",
                        description: "Absolute or relative source path.",
                    },
                    destination: {
                        type: "string",
                        description: "Absolute or relative destination path.",
                    },
                },
                required: ["source", "destination"],
            },
        },
        {
            name: "get_file_info",
            description: "Return metadata about a file or directory: size, creation time, modification time, type, and permissions.",
            inputSchema: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to inspect.",
                    },
                },
                required: ["path"],
            },
        },
        {
            name: "search_files",
            description: "Recursively search for files whose names match a glob-style pattern within a directory.",
            inputSchema: {
                type: "object",
                properties: {
                    directory: {
                        type: "string",
                        description: "Root directory to search in.",
                    },
                    pattern: {
                        type: "string",
                        description: "Case-insensitive substring or glob-style pattern to match against file names. e.g. \"*.ts\", \"config\".",
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of results to return. Defaults to 100.",
                        default: 100,
                    },
                },
                required: ["directory", "pattern"],
            },
        },
        {
            name: "search_file_contents",
            description: "Search for files whose contents contain the given text (case-insensitive). Returns file paths and matching lines.",
            inputSchema: {
                type: "object",
                properties: {
                    directory: {
                        type: "string",
                        description: "Root directory to search in.",
                    },
                    query: {
                        type: "string",
                        description: "Text to search for within file contents.",
                    },
                    filePattern: {
                        type: "string",
                        description: "Optional pattern to restrict which file names are searched. e.g. \"*.ts\".",
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of matching files to return. Defaults to 20.",
                        default: 20,
                    },
                },
                required: ["directory", "query"],
            },
        },
        {
            name: "list_allowed_directories",
            description: "Return the list of directories that this server is allowed to access.",
            inputSchema: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    ],
}));
// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
        switch (name) {
            // -----------------------------------------------------------------------
            case "read_file": {
                const filePath = validatePath(args.path);
                const encoding = args.encoding ?? "utf8";
                const content = await fs.readFile(filePath, encoding);
                return {
                    content: [{ type: "text", text: content }],
                };
            }
            // -----------------------------------------------------------------------
            case "write_file": {
                const filePath = validatePath(args.path);
                const content = args.content;
                const encoding = args.encoding ?? "utf8";
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                const buffer = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
                await fs.writeFile(filePath, buffer);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Successfully wrote ${buffer.length} bytes to "${filePath}".`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "append_file": {
                const filePath = validatePath(args.path);
                const content = args.content;
                await fs.mkdir(path.dirname(filePath), { recursive: true });
                await fs.appendFile(filePath, content, "utf8");
                return {
                    content: [
                        { type: "text", text: `Successfully appended to "${filePath}".` },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "list_directory": {
                const dirPath = validatePath(args.path);
                const recursive = args.recursive ?? false;
                const entries = await listDirectory(dirPath, recursive);
                return {
                    content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
                };
            }
            // -----------------------------------------------------------------------
            case "create_directory": {
                const dirPath = validatePath(args.path);
                await fs.mkdir(dirPath, { recursive: true });
                return {
                    content: [
                        {
                            type: "text",
                            text: `Directory "${dirPath}" created (or already existed).`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "delete_file": {
                const target = validatePath(args.path);
                const recursive = args.recursive ?? false;
                await fs.rm(target, { recursive, force: false });
                return {
                    content: [
                        { type: "text", text: `Successfully deleted "${target}".` },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "move_file": {
                const src = validatePath(args.source);
                const dest = validatePath(args.destination);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.rename(src, dest);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Moved "${src}" → "${dest}".`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "copy_file": {
                const src = validatePath(args.source);
                const dest = validatePath(args.destination);
                await fs.mkdir(path.dirname(dest), { recursive: true });
                await fs.copyFile(src, dest);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Copied "${src}" → "${dest}".`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "get_file_info": {
                const target = validatePath(args.path);
                const stat = await fs.stat(target);
                const info = {
                    path: target,
                    type: stat.isDirectory()
                        ? "directory"
                        : stat.isFile()
                            ? "file"
                            : "other",
                    size: stat.size,
                    createdAt: stat.birthtime.toISOString(),
                    modifiedAt: stat.mtime.toISOString(),
                    permissions: (stat.mode & 0o777).toString(8).padStart(3, "0"),
                    isReadable: true,
                    isWritable: !!(stat.mode & 0o200),
                };
                return {
                    content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
                };
            }
            // -----------------------------------------------------------------------
            case "search_files": {
                const dirPath = validatePath(args.directory);
                const pattern = args.pattern;
                const maxResults = args.maxResults ?? 100;
                const matches = await searchFiles(dirPath, pattern, maxResults);
                return {
                    content: [
                        {
                            type: "text",
                            text: matches.length > 0
                                ? matches.join("\n")
                                : "No files matched the pattern.",
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "search_file_contents": {
                const dirPath = validatePath(args.directory);
                const query = args.query.toLowerCase();
                const filePattern = args.filePattern ?? "";
                const maxResults = args.maxResults ?? 20;
                const results = await searchFileContents(dirPath, query, filePattern, maxResults);
                return {
                    content: [
                        {
                            type: "text",
                            text: results.length > 0
                                ? results
                                    .map(r => `--- ${r.file} ---\n${r.lines.map(l => `  L${l.lineNumber}: ${l.text}`).join("\n")}`)
                                    .join("\n\n")
                                : "No matches found.",
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "list_allowed_directories": {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ allowedDirectories: allowedDirs }, null, 2),
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
    }
    catch (err) {
        if (err instanceof McpError)
            throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new McpError(ErrorCode.InternalError, message);
    }
});
async function listDirectory(dir, recursive) {
    const entries = [];
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
        const fullPath = path.join(dir, item.name);
        let stat;
        try {
            stat = await fs.stat(fullPath);
        }
        catch {
            continue;
        }
        const type = item.isDirectory()
            ? "directory"
            : item.isFile()
                ? "file"
                : item.isSymbolicLink()
                    ? "symlink"
                    : "other";
        entries.push({
            name: item.name,
            path: fullPath,
            type,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
        });
        if (recursive && item.isDirectory()) {
            const children = await listDirectory(fullPath, true);
            entries.push(...children);
        }
    }
    return entries;
}
// ---------------------------------------------------------------------------
// Helper: file name search
// ---------------------------------------------------------------------------
function matchesPattern(name, pattern) {
    const lower = name.toLowerCase();
    const pat = pattern.toLowerCase();
    // Simple glob: only supports leading/trailing/middle `*` wildcards
    if (!pat.includes("*")) {
        return lower.includes(pat);
    }
    const parts = pat.split("*");
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "")
            continue;
        const idx = lower.indexOf(part, pos);
        if (idx === -1)
            return false;
        if (i === 0 && idx !== 0)
            return false; // must start with
        pos = idx + part.length;
    }
    // If pattern ends without *, the string must end with the last non-empty part
    if (!pat.endsWith("*") && parts[parts.length - 1] !== "") {
        const last = parts[parts.length - 1];
        if (!lower.endsWith(last))
            return false;
    }
    return true;
}
async function searchFiles(dir, pattern, maxResults) {
    const results = [];
    async function walk(current) {
        if (results.length >= maxResults)
            return;
        let items;
        try {
            items = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const item of items) {
            if (results.length >= maxResults)
                break;
            if (matchesPattern(item.name, pattern)) {
                results.push(path.join(current, item.name));
            }
            if (item.isDirectory()) {
                await walk(path.join(current, item.name));
            }
        }
    }
    await walk(dir);
    return results;
}
async function searchFileContents(dir, query, filePattern, maxResults) {
    const results = [];
    async function walk(current) {
        if (results.length >= maxResults)
            return;
        let items;
        try {
            items = await fs.readdir(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const item of items) {
            if (results.length >= maxResults)
                break;
            const fullPath = path.join(current, item.name);
            if (item.isDirectory()) {
                await walk(fullPath);
            }
            else if (item.isFile()) {
                if (filePattern && !matchesPattern(item.name, filePattern))
                    continue;
                try {
                    const text = await fs.readFile(fullPath, "utf8");
                    const lines = text.split("\n");
                    const matching = [];
                    lines.forEach((line, idx) => {
                        if (line.toLowerCase().includes(query)) {
                            matching.push({ lineNumber: idx + 1, text: line });
                        }
                    });
                    if (matching.length > 0) {
                        results.push({ file: fullPath, lines: matching });
                    }
                }
                catch {
                    // Skip unreadable files (binary, permissions, etc.)
                }
            }
        }
    }
    await walk(dir);
    return results;
}
// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Log to stderr so it doesn't interfere with the MCP stdio protocol
    process.stderr.write(`[mcp-filesystem-server] started. Allowed directories: ${allowedDirs.join(", ")}\n`);
}
main().catch(err => {
    process.stderr.write(`[mcp-filesystem-server] fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map