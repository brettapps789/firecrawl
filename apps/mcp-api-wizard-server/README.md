# API Wizard MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that acts as an **API Wizard** — letting AI agents design, document, validate, mock, and interact with REST APIs entirely from conversation.

## Features

| Tool | Description |
|---|---|
| `create_spec` | Create a new in-memory OpenAPI 3.1 spec |
| `load_spec` | Load an OpenAPI spec from a JSON file |
| `save_spec` | Persist an in-memory spec to a JSON file |
| `export_spec` | Return a spec as a JSON string |
| `list_specs` | List all in-memory specs |
| `add_endpoint` | Add/replace an endpoint (path + method + schemas) |
| `remove_endpoint` | Remove an endpoint from a spec |
| `list_endpoints` | List endpoints with optional tag filter |
| `get_endpoint` | Get the full definition of one endpoint |
| `validate_spec` | Check for structural & semantic errors |
| `diff_specs` | Compare two specs and report added/removed/changed endpoints |
| `add_schema` | Add a reusable `components/schemas` entry |
| `add_security_scheme` | Add API key, Bearer, or OAuth2 security scheme |
| `make_request` | Execute a live HTTP request |
| `inspect_api` | Hit a live endpoint and auto-infer its OpenAPI schema |
| `import_from_curl` | Parse (and optionally execute) a curl command |
| `generate_client_code` | Generate TypeScript, Python, or curl client code |
| `mock_server_start` | Start an in-process HTTP mock server from a spec |
| `mock_server_stop` | Stop a running mock server |
| `list_mock_servers` | List running mock servers |

## Security

- **Workspace sandboxing**: All file read/write operations are validated against the workspace root. Relative traversals (`../../etc`) and absolute paths outside the workspace are rejected.
- **No code execution**: No arbitrary shell or script execution. HTTP requests are made directly via Node's built-in `http`/`https` modules.

## Usage

### Build

```bash
cd apps/mcp-api-wizard-server
npm install
npm run build
```

### Run

```bash
# Use current directory as workspace
node dist/index.js

# Specify a workspace directory for spec files
node dist/index.js --workspace /path/to/workspace
```

### Integrate with Claude Desktop

```json
{
  "mcpServers": {
    "api-wizard": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-api-wizard-server/dist/index.js",
        "--workspace",
        "/path/to/your/api/specs"
      ]
    }
  }
}
```

## Example agent workflow

```
User: Design a Users REST API with CRUD endpoints, add Bearer auth, generate TypeScript clients, and start a mock server.

Agent calls:
1. create_spec          { title: "Users API", version: "1.0.0", serverUrl: "https://api.example.com" }
2. add_security_scheme  { specId: "users-api", name: "bearerAuth", type: "http", scheme: "bearer", bearerFormat: "JWT" }
3. add_schema           { specId: "users-api", name: "User", schema: { type: "object", properties: { id: {type:"integer"}, name: {type:"string"}, email: {type:"string", format:"email"} } } }
4. add_endpoint         { specId: "users-api", path: "/users", method: "get", summary: "List users", ... }
5. add_endpoint         { specId: "users-api", path: "/users", method: "post", summary: "Create user", ... }
6. add_endpoint         { specId: "users-api", path: "/users/{id}", method: "get", summary: "Get user", ... }
7. add_endpoint         { specId: "users-api", path: "/users/{id}", method: "put", summary: "Update user", ... }
8. add_endpoint         { specId: "users-api", path: "/users/{id}", method: "delete", summary: "Delete user", ... }
9. validate_spec        { specId: "users-api" }
10. generate_client_code { specId: "users-api", language: "typescript" }
11. mock_server_start   { specId: "users-api", port: 4010 }
12. make_request        { method: "GET", url: "http://127.0.0.1:4010/users" }
13. save_spec           { specId: "users-api", filePath: "users-api.openapi.json" }
```

## In-memory vs. persistent specs

Specs live in memory for the lifetime of the server process. Use `save_spec` to persist to disk and `load_spec` to reload in a future session.

## Supported OpenAPI version

The server generates **OpenAPI 3.1.0** specs. Loaded files that use 3.0.x are accepted but not upgraded automatically.

## Development

```bash
# Run without building
npm run dev -- --workspace /path/to/workspace

# Rebuild
npm run build
```
