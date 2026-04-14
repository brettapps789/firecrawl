#!/usr/bin/env node
/**
 * Project Builder MCP Server
 *
 * Exposes software-project scaffolding and build operations as MCP tools so
 * that AI agents can create, configure, and build projects from scratch.
 *
 * Usage:
 *   node dist/index.js [workspace-root]
 *
 * If no workspace root is provided the current working directory is used.
 * All project operations are scoped to subdirectories of the workspace root.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
// ---------------------------------------------------------------------------
// Workspace root
// ---------------------------------------------------------------------------
function normalizePath(p) {
    return path.normalize(path.resolve(p));
}
const workspaceRoot = normalizePath(process.argv[2] ?? process.cwd());
/** Resolve a user-supplied project name/path and ensure it stays inside the workspace. */
function resolveProjectPath(projectName) {
    const resolved = path.isAbsolute(projectName)
        ? normalizePath(projectName)
        : normalizePath(path.join(workspaceRoot, projectName));
    if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
        throw new McpError(ErrorCode.InvalidParams, `Access denied: "${resolved}" is outside the workspace root "${workspaceRoot}"`);
    }
    return resolved;
}
// ---------------------------------------------------------------------------
// Allowed shell commands (whitelist)
// ---------------------------------------------------------------------------
const ALLOWED_COMMANDS = {
    npm_install: {
        bin: "npm",
        allowedArgs: ["install"],
        description: "npm install",
    },
    npm_build: {
        bin: "npm",
        allowedArgs: ["run", "build"],
        description: "npm run build",
    },
    npm_test: {
        bin: "npm",
        allowedArgs: ["run", "test"],
        description: "npm run test",
    },
    npm_lint: {
        bin: "npm",
        allowedArgs: ["run", "lint"],
        description: "npm run lint",
    },
    npm_format: {
        bin: "npm",
        allowedArgs: ["run", "format"],
        description: "npm run format",
    },
    pip_install: {
        bin: "pip",
        allowedArgs: ["install", "-r", "requirements.txt"],
        description: "pip install -r requirements.txt",
    },
    poetry_install: {
        bin: "poetry",
        allowedArgs: ["install"],
        description: "poetry install",
    },
    poetry_build: {
        bin: "poetry",
        allowedArgs: ["build"],
        description: "poetry build",
    },
    go_mod_tidy: {
        bin: "go",
        allowedArgs: ["mod", "tidy"],
        description: "go mod tidy",
    },
    go_build: {
        bin: "go",
        allowedArgs: ["build", "./..."],
        description: "go build ./...",
    },
    go_test: {
        bin: "go",
        allowedArgs: ["test", "./..."],
        description: "go test ./...",
    },
    cargo_build: {
        bin: "cargo",
        allowedArgs: ["build"],
        description: "cargo build",
    },
    cargo_test: {
        bin: "cargo",
        allowedArgs: ["test"],
        description: "cargo test",
    },
    git_init: {
        bin: "git",
        allowedArgs: ["init"],
        description: "git init",
    },
};
const PROJECT_TEMPLATES = {
    "node-commonjs": {
        description: "Minimal Node.js CommonJS project with npm",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    version: "1.0.0",
                    description: "",
                    main: "index.js",
                    scripts: { test: 'echo "Error: no test specified" && exit 1' },
                    keywords: [],
                    author: "",
                    license: "MIT",
                }, null, 2) + "\n",
            },
            {
                path: "index.js",
                content: `'use strict';\n\nconsole.log('Hello from ${name}!');\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\n.env\ndist/\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA Node.js project.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnode index.js\n\`\`\`\n`,
            },
        ],
    },
    "node-esm": {
        description: "Node.js ESM (ES Modules) project with npm",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    version: "1.0.0",
                    description: "",
                    type: "module",
                    main: "src/index.js",
                    scripts: { start: "node src/index.js", test: 'echo "no tests" && exit 0' },
                    keywords: [],
                    author: "",
                    license: "MIT",
                }, null, 2) + "\n",
            },
            {
                path: "src/index.js",
                content: `console.log('Hello from ${name}!');\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\n.env\ndist/\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA Node.js ESM project.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\`\n`,
            },
        ],
    },
    "typescript-library": {
        description: "TypeScript library with tsc, Jest, and ESLint",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    version: "0.1.0",
                    description: "",
                    type: "module",
                    main: "dist/index.js",
                    types: "dist/index.d.ts",
                    scripts: {
                        build: "tsc",
                        test: "jest",
                        lint: "eslint src --ext .ts",
                        format: "prettier --write \"src/**/*.ts\"",
                    },
                    keywords: [],
                    author: "",
                    license: "MIT",
                    devDependencies: {
                        "@types/jest": "^29.0.0",
                        "@types/node": "^22.0.0",
                        "@typescript-eslint/eslint-plugin": "^8.0.0",
                        "@typescript-eslint/parser": "^8.0.0",
                        eslint: "^9.0.0",
                        jest: "^29.0.0",
                        prettier: "^3.0.0",
                        "ts-jest": "^29.0.0",
                        typescript: "^5.0.0",
                    },
                }, null, 2) + "\n",
            },
            {
                path: "tsconfig.json",
                content: JSON.stringify({
                    compilerOptions: {
                        target: "ES2022",
                        module: "NodeNext",
                        moduleResolution: "NodeNext",
                        lib: ["ES2022"],
                        outDir: "dist",
                        rootDir: "src",
                        strict: true,
                        declaration: true,
                        declarationMap: true,
                        sourceMap: true,
                        esModuleInterop: true,
                        skipLibCheck: true,
                    },
                    include: ["src/**/*"],
                    exclude: ["node_modules", "dist", "**/*.test.ts"],
                }, null, 2) + "\n",
            },
            {
                path: "src/index.ts",
                content: `/**\n * ${name}\n */\n\nexport function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
            },
            {
                path: "src/index.test.ts",
                content: `import { greet } from './index.js';\n\ntest('greet returns correct string', () => {\n  expect(greet('World')).toBe('Hello, World!');\n});\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\ndist/\n.env\ncoverage/\n`,
            },
            {
                path: ".eslintrc.json",
                content: JSON.stringify({
                    parser: "@typescript-eslint/parser",
                    plugins: ["@typescript-eslint"],
                    extends: [
                        "eslint:recommended",
                        "plugin:@typescript-eslint/recommended",
                    ],
                    rules: {},
                }, null, 2) + "\n",
            },
            {
                path: ".prettierrc",
                content: JSON.stringify({ semi: true, singleQuote: false, trailingComma: "es5", printWidth: 100 }, null, 2) + "\n",
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA TypeScript library.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm test\n\`\`\`\n`,
            },
        ],
    },
    "react-app": {
        description: "React single-page application with TypeScript and Vite",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    version: "0.1.0",
                    private: true,
                    scripts: {
                        dev: "vite",
                        build: "tsc && vite build",
                        preview: "vite preview",
                        test: "vitest",
                        lint: "eslint src --ext .ts,.tsx",
                    },
                    dependencies: {
                        react: "^18.0.0",
                        "react-dom": "^18.0.0",
                    },
                    devDependencies: {
                        "@types/react": "^18.0.0",
                        "@types/react-dom": "^18.0.0",
                        "@vitejs/plugin-react": "^4.0.0",
                        eslint: "^9.0.0",
                        typescript: "^5.0.0",
                        vite: "^5.0.0",
                        vitest: "^1.0.0",
                    },
                }, null, 2) + "\n",
            },
            {
                path: "tsconfig.json",
                content: JSON.stringify({
                    compilerOptions: {
                        target: "ES2020",
                        lib: ["ES2020", "DOM", "DOM.Iterable"],
                        module: "ESNext",
                        moduleResolution: "bundler",
                        jsx: "react-jsx",
                        strict: true,
                        noEmit: true,
                        esModuleInterop: true,
                        skipLibCheck: true,
                        resolveJsonModule: true,
                    },
                    include: ["src"],
                }, null, 2) + "\n",
            },
            {
                path: "vite.config.ts",
                content: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n`,
            },
            {
                path: "index.html",
                content: `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
            },
            {
                path: "src/main.tsx",
                content: `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App.js';\n\nReactDOM.createRoot(document.getElementById('root')!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
            },
            {
                path: "src/App.tsx",
                content: `import React from 'react';\n\nexport default function App() {\n  return <h1>Hello from ${name}!</h1>;\n}\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\ndist/\n.env\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA React + TypeScript + Vite app.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
            },
        ],
    },
    "express-api": {
        description: "Express REST API with TypeScript",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    version: "0.1.0",
                    description: "Express REST API",
                    type: "module",
                    main: "dist/index.js",
                    scripts: {
                        build: "tsc",
                        start: "node dist/index.js",
                        dev: "tsx src/index.ts",
                        test: "jest",
                        lint: "eslint src --ext .ts",
                    },
                    dependencies: {
                        express: "^4.18.0",
                    },
                    devDependencies: {
                        "@types/express": "^4.17.0",
                        "@types/jest": "^29.0.0",
                        "@types/node": "^22.0.0",
                        jest: "^29.0.0",
                        "ts-jest": "^29.0.0",
                        tsx: "^4.0.0",
                        typescript: "^5.0.0",
                    },
                }, null, 2) + "\n",
            },
            {
                path: "tsconfig.json",
                content: JSON.stringify({
                    compilerOptions: {
                        target: "ES2022",
                        module: "NodeNext",
                        moduleResolution: "NodeNext",
                        outDir: "dist",
                        rootDir: "src",
                        strict: true,
                        esModuleInterop: true,
                        skipLibCheck: true,
                        declaration: true,
                        sourceMap: true,
                    },
                    include: ["src/**/*"],
                    exclude: ["node_modules", "dist"],
                }, null, 2) + "\n",
            },
            {
                path: "src/index.ts",
                content: `import express from 'express';\n\nconst app = express();\nconst PORT = process.env.PORT ?? 3000;\n\napp.use(express.json());\n\napp.get('/health', (_req, res) => {\n  res.json({ status: 'ok' });\n});\n\napp.listen(PORT, () => {\n  console.log(\`Server running on port \${PORT}\`);\n});\n\nexport default app;\n`,
            },
            {
                path: "src/routes/index.ts",
                content: `import { Router } from 'express';\n\nconst router = Router();\n\nrouter.get('/', (_req, res) => {\n  res.json({ message: 'Welcome to ${name} API' });\n});\n\nexport default router;\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\ndist/\n.env\ncoverage/\n`,
            },
            {
                path: ".env.example",
                content: `PORT=3000\nNODE_ENV=development\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nAn Express REST API built with TypeScript.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\n## Endpoints\n\n- \`GET /health\` — health check\n- \`GET /\` — welcome message\n`,
            },
        ],
    },
    "python-script": {
        description: "Simple Python script with a requirements file and README",
        files: name => [
            {
                path: "main.py",
                content: `#!/usr/bin/env python3\n"""${name} - main entry point."""\n\ndef main() -> None:\n    print("Hello from ${name}!")\n\n\nif __name__ == "__main__":\n    main()\n`,
            },
            {
                path: "requirements.txt",
                content: `# Add dependencies here\n`,
            },
            {
                path: ".gitignore",
                content: `__pycache__/\n*.pyc\n*.pyo\n.env\nvenv/\n.venv/\ndist/\nbuild/\n*.egg-info/\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA Python project.\n\n## Getting started\n\n\`\`\`bash\npython -m venv venv\nsource venv/bin/activate  # Windows: venv\\Scripts\\activate\npip install -r requirements.txt\npython main.py\n\`\`\`\n`,
            },
        ],
    },
    "python-package": {
        description: "Python package with pyproject.toml, pytest, and type hints",
        files: name => {
            const safeName = name.replace(/-/g, "_");
            return [
                {
                    path: "pyproject.toml",
                    content: `[build-system]\nrequires = ["setuptools>=68", "wheel"]\nbuild-backend = "setuptools.backends.legacy:build"\n\n[project]\nname = "${name}"\nversion = "0.1.0"\ndescription = ""\nrequires-python = ">=3.10"\ndependencies = []\n\n[project.optional-dependencies]\ndev = ["pytest", "pytest-cov", "mypy", "ruff"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.mypy]\nstrict = true\n\n[tool.ruff]\nline-length = 100\n`,
                },
                {
                    path: `src/${safeName}/__init__.py`,
                    content: `"""${name} package."""\n\n__version__ = "0.1.0"\n`,
                },
                {
                    path: `src/${safeName}/core.py`,
                    content: `"""Core module for ${name}."""\n\n\ndef greet(name: str) -> str:\n    """Return a greeting string."""\n    return f"Hello, {name}!"\n`,
                },
                {
                    path: "tests/__init__.py",
                    content: ``,
                },
                {
                    path: "tests/test_core.py",
                    content: `"""Tests for ${name}.core."""\nfrom ${safeName}.core import greet\n\n\ndef test_greet() -> None:\n    assert greet("World") == "Hello, World!"\n`,
                },
                {
                    path: ".gitignore",
                    content: `__pycache__/\n*.pyc\n.env\nvenv/\n.venv/\ndist/\nbuild/\n*.egg-info/\n.mypy_cache/\n.ruff_cache/\n`,
                },
                {
                    path: "README.md",
                    content: `# ${name}\n\nA Python package.\n\n## Development\n\n\`\`\`bash\npython -m venv venv\nsource venv/bin/activate\npip install -e ".[dev]"\npytest\n\`\`\`\n`,
                },
            ];
        },
    },
    "go-module": {
        description: "Go module with a main package and basic test",
        files: name => [
            {
                path: "go.mod",
                content: `module ${name}\n\ngo 1.22\n`,
            },
            {
                path: "main.go",
                content: `package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from ${name}!")\n}\n`,
            },
            {
                path: "main_test.go",
                content: `package main\n\nimport "testing"\n\nfunc TestMain(t *testing.T) {\n\t// Add your tests here\n\tt.Log("${name} tests pass")\n}\n`,
            },
            {
                path: ".gitignore",
                content: `# Binaries\n${name}\n*.exe\n*.out\n\n# Modules\nvendor/\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA Go module.\n\n## Getting started\n\n\`\`\`bash\ngo mod tidy\ngo run .\ngo test ./...\n\`\`\`\n`,
            },
        ],
    },
    "rust-binary": {
        description: "Rust binary crate with Cargo",
        files: name => [
            {
                path: "Cargo.toml",
                content: `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`,
            },
            {
                path: "src/main.rs",
                content: `fn main() {\n    println!("Hello from ${name}!");\n}\n`,
            },
            {
                path: ".gitignore",
                content: `/target\nCargo.lock\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nA Rust binary.\n\n## Getting started\n\n\`\`\`bash\ncargo build\ncargo run\ncargo test\n\`\`\`\n`,
            },
        ],
    },
    "monorepo-npm": {
        description: "npm workspaces monorepo with a shared library and an app package",
        files: name => [
            {
                path: "package.json",
                content: JSON.stringify({
                    name,
                    private: true,
                    workspaces: ["packages/*"],
                    scripts: {
                        build: "npm run build --workspaces",
                        test: "npm run test --workspaces",
                    },
                }, null, 2) + "\n",
            },
            {
                path: "packages/shared/package.json",
                content: JSON.stringify({
                    name: `@${name}/shared`,
                    version: "0.1.0",
                    main: "src/index.js",
                    scripts: { test: 'echo "no tests" && exit 0' },
                }, null, 2) + "\n",
            },
            {
                path: "packages/shared/src/index.js",
                content: `export const greet = name => \`Hello from shared, \${name}!\`;\n`,
            },
            {
                path: "packages/app/package.json",
                content: JSON.stringify({
                    name: `@${name}/app`,
                    version: "0.1.0",
                    type: "module",
                    main: "src/index.js",
                    scripts: { start: "node src/index.js", test: 'echo "no tests" && exit 0' },
                    dependencies: { [`@${name}/shared`]: "*" },
                }, null, 2) + "\n",
            },
            {
                path: "packages/app/src/index.js",
                content: `import { greet } from '@${name}/shared';\nconsole.log(greet('world'));\n`,
            },
            {
                path: ".gitignore",
                content: `node_modules/\ndist/\n.env\n`,
            },
            {
                path: "README.md",
                content: `# ${name}\n\nnpm workspaces monorepo.\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm run build\n\`\`\`\n`,
            },
        ],
    },
};
// ---------------------------------------------------------------------------
// File snippets (single-file templates)
// ---------------------------------------------------------------------------
const FILE_SNIPPETS = {
    gitignore_node: {
        description: "Node.js .gitignore",
        defaultPath: ".gitignore",
        content: `node_modules/\ndist/\nbuild/\n.env\n.env.local\ncoverage/\n*.log\n`,
    },
    gitignore_python: {
        description: "Python .gitignore",
        defaultPath: ".gitignore",
        content: `__pycache__/\n*.pyc\n*.pyo\n.env\nvenv/\n.venv/\ndist/\nbuild/\n*.egg-info/\n.mypy_cache/\n.pytest_cache/\n`,
    },
    gitignore_rust: {
        description: "Rust .gitignore",
        defaultPath: ".gitignore",
        content: `/target\nCargo.lock\n`,
    },
    gitignore_go: {
        description: "Go .gitignore",
        defaultPath: ".gitignore",
        content: `# Binaries\n*.exe\n*.out\n\n# Vendor\nvendor/\n`,
    },
    dockerfile_node: {
        description: "Dockerfile for a Node.js app",
        defaultPath: "Dockerfile",
        content: `FROM node:22-alpine AS builder\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM node:22-alpine\nWORKDIR /app\nCOPY --from=builder /app/dist ./dist\nCOPY --from=builder /app/node_modules ./node_modules\nCOPY package*.json ./\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n`,
    },
    dockerfile_python: {
        description: "Dockerfile for a Python app",
        defaultPath: "Dockerfile",
        content: `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nCMD ["python", "main.py"]\n`,
    },
    dockercompose: {
        description: "docker-compose.yml with a web service and postgres",
        defaultPath: "docker-compose.yml",
        content: `version: '3.9'\nservices:\n  web:\n    build: .\n    ports:\n      - "3000:3000"\n    environment:\n      - DATABASE_URL=postgresql://postgres:postgres@db:5432/app\n    depends_on:\n      - db\n  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: postgres\n      POSTGRES_PASSWORD: postgres\n      POSTGRES_DB: app\n    volumes:\n      - pgdata:/var/lib/postgresql/data\nvolumes:\n  pgdata:\n`,
    },
    eslint_ts: {
        description: "ESLint config for TypeScript (flat config)",
        defaultPath: "eslint.config.js",
        content: `import js from '@eslint/js';\nimport tsParser from '@typescript-eslint/parser';\nimport tsPlugin from '@typescript-eslint/eslint-plugin';\n\nexport default [\n  js.configs.recommended,\n  {\n    files: ['**/*.ts'],\n    languageOptions: { parser: tsParser },\n    plugins: { '@typescript-eslint': tsPlugin },\n    rules: {\n      ...tsPlugin.configs.recommended.rules,\n    },\n  },\n];\n`,
    },
    prettier: {
        description: "Prettier config",
        defaultPath: ".prettierrc",
        content: JSON.stringify({ semi: true, singleQuote: false, trailingComma: "es5", printWidth: 100, tabWidth: 2 }, null, 2) + "\n",
    },
    jest_ts: {
        description: "Jest config for TypeScript (ts-jest)",
        defaultPath: "jest.config.ts",
        content: `import type { Config } from 'jest';\n\nconst config: Config = {\n  preset: 'ts-jest',\n  testEnvironment: 'node',\n  extensionsToTreatAsEsm: ['.ts'],\n  moduleNameMapper: {\n    '^(\\.{1,2}/.*)\\.js$': '$1',\n  },\n  transform: {\n    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],\n  },\n};\n\nexport default config;\n`,
    },
    github_ci_node: {
        description: "GitHub Actions CI workflow for Node.js",
        defaultPath: ".github/workflows/ci.yml",
        content: `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        node-version: [20.x, 22.x]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: \${{ matrix.node-version }}\n          cache: npm\n      - run: npm ci\n      - run: npm run build --if-present\n      - run: npm test\n`,
    },
    github_ci_python: {
        description: "GitHub Actions CI workflow for Python",
        defaultPath: ".github/workflows/ci.yml",
        content: `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        python-version: ["3.11", "3.12"]\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: \${{ matrix.python-version }}\n      - run: pip install -e ".[dev]"\n      - run: pytest\n`,
    },
    env_example: {
        description: "Example .env file",
        defaultPath: ".env.example",
        content: `# Copy this file to .env and fill in your values\nNODE_ENV=development\nPORT=3000\nDATABASE_URL=\nSECRET_KEY=\n`,
    },
    mit_license: {
        description: "MIT License file",
        defaultPath: "LICENSE",
        content: `MIT License\n\nCopyright (c) ${new Date().getFullYear()} <author>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`,
    },
};
// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------
const server = new Server({ name: "project-builder", version: "0.1.0" }, { capabilities: { tools: {} } });
// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        // ------------------------------------------------------------------
        {
            name: "list_templates",
            description: "List all available project templates and file snippet templates that can be used to scaffold new projects or add common configuration files.",
            inputSchema: {
                type: "object",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["project", "snippet", "all"],
                        description: 'Filter by kind: "project" templates, file "snippet" templates, or "all". Defaults to "all".',
                        default: "all",
                    },
                },
                required: [],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "scaffold_project",
            description: "Scaffold a new software project from a named template. Creates the project directory under the workspace root and writes all boilerplate files. Use list_templates to see available template names.",
            inputSchema: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Project name (used as the directory name and in generated files). Should be a valid npm/Python/Go package name (lowercase, hyphens OK).",
                    },
                    template: {
                        type: "string",
                        description: 'Template to use (e.g. "typescript-library", "express-api", "react-app", "python-package"). Use list_templates to see all options.',
                    },
                    overwrite: {
                        type: "boolean",
                        description: "If true, overwrite files that already exist. Defaults to false.",
                        default: false,
                    },
                },
                required: ["name", "template"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "add_file",
            description: "Add a single file from a named snippet template to an existing project directory. Use list_templates (kind=snippet) to see available snippets.",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory (relative to workspace root or absolute within workspace).",
                    },
                    snippet: {
                        type: "string",
                        description: 'Snippet template name (e.g. "dockerfile_node", "github_ci_node"). Use list_templates to see options.',
                    },
                    outputPath: {
                        type: "string",
                        description: "Override the default output path within the project directory. If omitted, the snippet's default path is used.",
                    },
                    overwrite: {
                        type: "boolean",
                        description: "If true, overwrite the file if it already exists. Defaults to false.",
                        default: false,
                    },
                },
                required: ["projectPath", "snippet"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "add_dependency",
            description: "Add one or more dependencies to a project's dependency manifest (package.json, requirements.txt, pyproject.toml, go.mod, or Cargo.toml).",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory.",
                    },
                    dependencies: {
                        type: "array",
                        items: { type: "string" },
                        description: 'List of dependency specifiers, e.g. ["express@^4.18.0", "zod@^3.0.0"] for npm, ["requests>=2.28", "pydantic"] for Python.',
                    },
                    dev: {
                        type: "boolean",
                        description: "If true, add as a dev/optional dependency (npm devDependencies, Python dev extras). Defaults to false.",
                        default: false,
                    },
                },
                required: ["projectPath", "dependencies"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "remove_dependency",
            description: "Remove a dependency from a project's manifest (package.json or requirements.txt).",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory.",
                    },
                    dependency: {
                        type: "string",
                        description: "Name of the dependency to remove (without version specifier).",
                    },
                },
                required: ["projectPath", "dependency"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "add_script",
            description: "Add or update an npm script in a project's package.json.",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory containing package.json.",
                    },
                    scriptName: {
                        type: "string",
                        description: 'Script name (e.g. "start", "build", "test").',
                    },
                    command: {
                        type: "string",
                        description: 'Shell command for the script (e.g. "node dist/index.js").',
                    },
                },
                required: ["projectPath", "scriptName", "command"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "get_project_info",
            description: "Read and return parsed metadata from a project's manifest file (package.json, pyproject.toml, Cargo.toml, go.mod). Useful to inspect current dependencies, scripts, and project version.",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory.",
                    },
                },
                required: ["projectPath"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "run_command",
            description: "Run a whitelisted build/install/test command in a project directory. Use list_commands to see what commands are available.",
            inputSchema: {
                type: "object",
                properties: {
                    projectPath: {
                        type: "string",
                        description: "Path to the project directory.",
                    },
                    command: {
                        type: "string",
                        description: 'Command key from the allowed list (e.g. "npm_install", "npm_build", "go_test"). Use list_commands to see all options.',
                    },
                    timeoutSeconds: {
                        type: "number",
                        description: "Maximum time in seconds to wait for the command. Defaults to 120.",
                        default: 120,
                    },
                },
                required: ["projectPath", "command"],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "list_commands",
            description: "Return the list of whitelisted commands that can be executed via run_command.",
            inputSchema: {
                type: "object",
                properties: {},
                required: [],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "list_projects",
            description: "List all project directories (immediate subdirectories) inside the workspace root.",
            inputSchema: {
                type: "object",
                properties: {},
                required: [],
            },
        },
        // ------------------------------------------------------------------
        {
            name: "get_workspace_info",
            description: "Return information about the current workspace root.",
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
            case "list_templates": {
                const kind = args?.kind ?? "all";
                const result = {};
                if (kind === "project" || kind === "all") {
                    result.projectTemplates = Object.fromEntries(Object.entries(PROJECT_TEMPLATES).map(([k, v]) => [
                        k,
                        { description: v.description },
                    ]));
                }
                if (kind === "snippet" || kind === "all") {
                    result.snippetTemplates = Object.fromEntries(Object.entries(FILE_SNIPPETS).map(([k, v]) => [
                        k,
                        { description: v.description, defaultPath: v.defaultPath },
                    ]));
                }
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            // -----------------------------------------------------------------------
            case "scaffold_project": {
                const projectName = args.name;
                const templateName = args.template;
                const overwrite = args.overwrite ?? false;
                const template = PROJECT_TEMPLATES[templateName];
                if (!template) {
                    throw new McpError(ErrorCode.InvalidParams, `Unknown template "${templateName}". Available: ${Object.keys(PROJECT_TEMPLATES).join(", ")}`);
                }
                const projectDir = resolveProjectPath(projectName);
                const files = template.files(projectName);
                const created = [];
                const skipped = [];
                for (const file of files) {
                    const fullPath = path.join(projectDir, file.path);
                    await fs.mkdir(path.dirname(fullPath), { recursive: true });
                    try {
                        await fs.access(fullPath);
                        // File exists
                        if (overwrite) {
                            await fs.writeFile(fullPath, file.content, "utf8");
                            created.push(file.path + " (overwritten)");
                        }
                        else {
                            skipped.push(file.path);
                        }
                    }
                    catch {
                        // File does not exist — create it
                        await fs.writeFile(fullPath, file.content, "utf8");
                        created.push(file.path);
                    }
                }
                const summary = [
                    `✓ Scaffolded project "${projectName}" from template "${templateName}" at:`,
                    `  ${projectDir}`,
                    "",
                    `Created files (${created.length}):`,
                    ...created.map(f => `  + ${f}`),
                    ...(skipped.length > 0
                        ? [
                            "",
                            `Skipped (already exist, pass overwrite=true to replace):`,
                            ...skipped.map(f => `  - ${f}`),
                        ]
                        : []),
                ].join("\n");
                return { content: [{ type: "text", text: summary }] };
            }
            // -----------------------------------------------------------------------
            case "add_file": {
                const projectPath = resolveProjectPath(args.projectPath);
                const snippetName = args.snippet;
                const overwrite = args.overwrite ?? false;
                const snippet = FILE_SNIPPETS[snippetName];
                if (!snippet) {
                    throw new McpError(ErrorCode.InvalidParams, `Unknown snippet "${snippetName}". Available: ${Object.keys(FILE_SNIPPETS).join(", ")}`);
                }
                const relPath = args.outputPath ?? snippet.defaultPath;
                const fullPath = path.join(projectPath, relPath);
                // Validate the resolved full path is within workspace
                resolveProjectPath(fullPath);
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                let existed = false;
                try {
                    await fs.access(fullPath);
                    existed = true;
                }
                catch { /* does not exist */ }
                if (existed && !overwrite) {
                    throw new McpError(ErrorCode.InvalidParams, `File "${fullPath}" already exists. Pass overwrite=true to replace it.`);
                }
                await fs.writeFile(fullPath, snippet.content, "utf8");
                return {
                    content: [
                        {
                            type: "text",
                            text: `✓ ${existed ? "Overwrote" : "Created"} ${relPath} in "${projectPath}".`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "add_dependency": {
                const projectPath = resolveProjectPath(args.projectPath);
                const deps = args.dependencies;
                const dev = args.dev ?? false;
                const result = await addDependency(projectPath, deps, dev);
                return { content: [{ type: "text", text: result }] };
            }
            // -----------------------------------------------------------------------
            case "remove_dependency": {
                const projectPath = resolveProjectPath(args.projectPath);
                const dep = args.dependency;
                const result = await removeDependency(projectPath, dep);
                return { content: [{ type: "text", text: result }] };
            }
            // -----------------------------------------------------------------------
            case "add_script": {
                const projectPath = resolveProjectPath(args.projectPath);
                const scriptName = args.scriptName;
                const command = args.command;
                const pkgPath = path.join(projectPath, "package.json");
                let pkg;
                try {
                    const raw = await fs.readFile(pkgPath, "utf8");
                    pkg = JSON.parse(raw);
                }
                catch {
                    throw new McpError(ErrorCode.InvalidParams, `No package.json found in "${projectPath}".`);
                }
                if (!pkg.scripts || typeof pkg.scripts !== "object") {
                    pkg.scripts = {};
                }
                pkg.scripts[scriptName] = command;
                await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
                return {
                    content: [
                        {
                            type: "text",
                            text: `✓ Added script "${scriptName}": "${command}" to package.json.`,
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "get_project_info": {
                const projectPath = resolveProjectPath(args.projectPath);
                const info = await getProjectInfo(projectPath);
                return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
            }
            // -----------------------------------------------------------------------
            case "run_command": {
                const projectPath = resolveProjectPath(args.projectPath);
                const commandKey = args.command;
                const timeoutMs = (args.timeoutSeconds ?? 120) * 1000;
                const cmd = ALLOWED_COMMANDS[commandKey];
                if (!cmd) {
                    throw new McpError(ErrorCode.InvalidParams, `Unknown command "${commandKey}". Available: ${Object.keys(ALLOWED_COMMANDS).join(", ")}`);
                }
                let stdout = "";
                let stderr = "";
                let exitCode = 0;
                try {
                    const result = await execFileAsync(cmd.bin, cmd.allowedArgs ?? [], {
                        cwd: projectPath,
                        timeout: timeoutMs,
                    });
                    stdout = result.stdout;
                    stderr = result.stderr;
                }
                catch (err) {
                    const e = err;
                    stdout = e.stdout ?? "";
                    stderr = e.stderr ?? "";
                    exitCode = e.code ?? 1;
                }
                const output = [
                    `$ ${cmd.bin} ${(cmd.allowedArgs ?? []).join(" ")}`,
                    `exit code: ${exitCode}`,
                    ...(stdout ? ["--- stdout ---", stdout.trim()] : []),
                    ...(stderr ? ["--- stderr ---", stderr.trim()] : []),
                ].join("\n");
                return { content: [{ type: "text", text: output }] };
            }
            // -----------------------------------------------------------------------
            case "list_commands": {
                const cmds = Object.entries(ALLOWED_COMMANDS).map(([key, val]) => ({
                    key,
                    description: val.description,
                }));
                return { content: [{ type: "text", text: JSON.stringify(cmds, null, 2) }] };
            }
            // -----------------------------------------------------------------------
            case "list_projects": {
                let entries;
                try {
                    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
                }
                catch {
                    throw new McpError(ErrorCode.InternalError, `Cannot read workspace root "${workspaceRoot}".`);
                }
                const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ workspaceRoot, projects: dirs }, null, 2),
                        },
                    ],
                };
            }
            // -----------------------------------------------------------------------
            case "get_workspace_info": {
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ workspaceRoot, allowedCommands: Object.keys(ALLOWED_COMMANDS) }, null, 2),
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
// ---------------------------------------------------------------------------
// Helpers: project info
// ---------------------------------------------------------------------------
async function getProjectInfo(projectPath) {
    // Try package.json (Node.js)
    try {
        const raw = await fs.readFile(path.join(projectPath, "package.json"), "utf8");
        const pkg = JSON.parse(raw);
        return {
            type: "nodejs",
            manifest: "package.json",
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            scripts: pkg.scripts ?? {},
            dependencies: pkg.dependencies ?? {},
            devDependencies: pkg.devDependencies ?? {},
        };
    }
    catch { /* not a Node project */ }
    // Try pyproject.toml
    try {
        const raw = await fs.readFile(path.join(projectPath, "pyproject.toml"), "utf8");
        return { type: "python", manifest: "pyproject.toml", raw };
    }
    catch { /* not pyproject */ }
    // Try requirements.txt
    try {
        const raw = await fs.readFile(path.join(projectPath, "requirements.txt"), "utf8");
        const deps = raw.split("\n").filter(l => l.trim() && !l.startsWith("#"));
        return { type: "python", manifest: "requirements.txt", dependencies: deps };
    }
    catch { /* no requirements */ }
    // Try Cargo.toml
    try {
        const raw = await fs.readFile(path.join(projectPath, "Cargo.toml"), "utf8");
        return { type: "rust", manifest: "Cargo.toml", raw };
    }
    catch { /* no Cargo */ }
    // Try go.mod
    try {
        const raw = await fs.readFile(path.join(projectPath, "go.mod"), "utf8");
        const lines = raw.split("\n");
        const moduleLine = lines.find(l => l.startsWith("module "));
        const goLine = lines.find(l => l.startsWith("go "));
        return {
            type: "go",
            manifest: "go.mod",
            module: moduleLine?.replace("module ", "").trim(),
            goVersion: goLine?.replace("go ", "").trim(),
        };
    }
    catch { /* no go.mod */ }
    return { type: "unknown", projectPath };
}
// ---------------------------------------------------------------------------
// Helpers: dependency management
// ---------------------------------------------------------------------------
async function addDependency(projectPath, deps, dev) {
    // Node.js: package.json
    const pkgPath = path.join(projectPath, "package.json");
    try {
        const raw = await fs.readFile(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        const key = dev ? "devDependencies" : "dependencies";
        if (!pkg[key] || typeof pkg[key] !== "object") {
            pkg[key] = {};
        }
        for (const dep of deps) {
            // Handle "name@version" or just "name"
            const atIdx = dep.lastIndexOf("@");
            const hasVersion = atIdx > 0;
            const depName = hasVersion ? dep.substring(0, atIdx) : dep;
            const version = hasVersion ? dep.substring(atIdx + 1) : "*";
            pkg[key][depName] = version;
        }
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        return `✓ Added ${deps.join(", ")} to ${key} in package.json.`;
    }
    catch { /* not a Node project */ }
    // Python: requirements.txt
    const reqPath = path.join(projectPath, "requirements.txt");
    try {
        let content = "";
        try {
            content = await fs.readFile(reqPath, "utf8");
        }
        catch { /* file may not exist yet */ }
        const lines = content ? content.split("\n") : [];
        for (const dep of deps) {
            const depName = dep.split(/[><=!]/)[0].trim();
            const existingIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith(depName.toLowerCase()));
            if (existingIdx >= 0) {
                lines[existingIdx] = dep;
            }
            else {
                lines.push(dep);
            }
        }
        await fs.writeFile(reqPath, lines.filter(l => l.trim() || l === "").join("\n"), "utf8");
        return `✓ Added ${deps.join(", ")} to requirements.txt.`;
    }
    catch (err) {
        throw new McpError(ErrorCode.InvalidParams, `Could not detect project type in "${projectPath}": no package.json or requirements.txt found. Error: ${err}`);
    }
}
async function removeDependency(projectPath, dep) {
    // Node.js
    const pkgPath = path.join(projectPath, "package.json");
    try {
        const raw = await fs.readFile(pkgPath, "utf8");
        const pkg = JSON.parse(raw);
        let removed = false;
        for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            if (pkg[key] && typeof pkg[key] === "object" && dep in pkg[key]) {
                delete pkg[key][dep];
                removed = true;
            }
        }
        if (!removed) {
            return `Dependency "${dep}" was not found in package.json.`;
        }
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        return `✓ Removed "${dep}" from package.json.`;
    }
    catch { /* not a Node project */ }
    // Python: requirements.txt
    const reqPath = path.join(projectPath, "requirements.txt");
    try {
        const content = await fs.readFile(reqPath, "utf8");
        const lines = content.split("\n");
        const filtered = lines.filter(l => !l.trim().toLowerCase().startsWith(dep.toLowerCase()));
        if (filtered.length === lines.length) {
            return `Dependency "${dep}" was not found in requirements.txt.`;
        }
        await fs.writeFile(reqPath, filtered.join("\n"), "utf8");
        return `✓ Removed "${dep}" from requirements.txt.`;
    }
    catch {
        throw new McpError(ErrorCode.InvalidParams, `No package.json or requirements.txt found in "${projectPath}".`);
    }
}
// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[mcp-project-builder-server] started. Workspace: ${workspaceRoot}\n`);
}
main().catch(err => {
    process.stderr.write(`[mcp-project-builder-server] fatal: ${err}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map