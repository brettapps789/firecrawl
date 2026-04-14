# Project Builder MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets AI agents scaffold, configure, and build software projects from a workspace directory.

## Features

| Tool | Description |
|---|---|
| `list_templates` | List all project and file-snippet templates |
| `scaffold_project` | Create a full project skeleton from a named template |
| `add_file` | Add a single config file from a snippet template |
| `add_dependency` | Add dependencies to package.json / requirements.txt |
| `remove_dependency` | Remove a dependency from the manifest |
| `add_script` | Add/update an npm script in package.json |
| `get_project_info` | Return parsed project metadata (name, version, deps, scripts) |
| `run_command` | Run a whitelisted build/test/install command |
| `list_commands` | Show all runnable command keys |
| `list_projects` | List all project directories in the workspace |
| `get_workspace_info` | Show workspace root and allowed commands |

## Project Templates

| Template | Description |
|---|---|
| `node-commonjs` | Minimal Node.js CommonJS project |
| `node-esm` | Node.js ESM project |
| `typescript-library` | TypeScript library with Jest, ESLint, Prettier |
| `react-app` | React + TypeScript + Vite SPA |
| `express-api` | Express REST API with TypeScript |
| `python-script` | Simple Python script with requirements.txt |
| `python-package` | Python package with pyproject.toml and pytest |
| `go-module` | Go module with main package and tests |
| `rust-binary` | Rust binary crate with Cargo |
| `monorepo-npm` | npm workspaces monorepo with shared lib + app |

## File Snippet Templates

| Snippet | Default path |
|---|---|
| `gitignore_node` | `.gitignore` |
| `gitignore_python` | `.gitignore` |
| `gitignore_rust` | `.gitignore` |
| `gitignore_go` | `.gitignore` |
| `dockerfile_node` | `Dockerfile` |
| `dockerfile_python` | `Dockerfile` |
| `dockercompose` | `docker-compose.yml` |
| `eslint_ts` | `eslint.config.js` |
| `prettier` | `.prettierrc` |
| `jest_ts` | `jest.config.ts` |
| `github_ci_node` | `.github/workflows/ci.yml` |
| `github_ci_python` | `.github/workflows/ci.yml` |
| `env_example` | `.env.example` |
| `mit_license` | `LICENSE` |

## Security

All file and project operations are sandboxed to the workspace root you specify at startup. Directory traversal attempts (e.g. `../../etc/passwd`, `/etc/passwd`) are rejected with an `InvalidParams` error.

Shell commands are restricted to an explicit whitelist — arbitrary shell execution is not possible.

## Usage

### Build

```bash
cd apps/mcp-project-builder-server
npm install
npm run build
```

### Run

```bash
node dist/index.js /path/to/your/workspace
```

If no workspace root is supplied, the current working directory is used.

### Integrate with Claude Desktop

```json
{
  "mcpServers": {
    "project-builder": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-project-builder-server/dist/index.js",
        "/path/to/workspace"
      ]
    }
  }
}
```

## Example agent interaction

```
User: Create a new Express TypeScript API called "my-api" and add the "zod" validation library.

Agent calls:
1. scaffold_project  { name: "my-api", template: "express-api" }
2. add_dependency    { projectPath: "my-api", dependencies: ["zod@^3.22.0"] }
3. run_command       { projectPath: "my-api", command: "npm_install" }
4. run_command       { projectPath: "my-api", command: "npm_build" }
```

## Development

```bash
# Run directly (no build required)
npm run dev /path/to/workspace

# Rebuild on change
npm run build -- --watch
```
