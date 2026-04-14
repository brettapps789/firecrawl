#!/usr/bin/env node
/**
 * API Wizard MCP Server
 *
 * Exposes a suite of API design, documentation, validation, mocking, and
 * interaction tools as MCP tools so that AI agents can build and test REST APIs
 * end-to-end without leaving the conversation.
 *
 * Usage:
 *   node dist/index.js [--workspace /path/to/workspace]
 *
 * If no workspace is provided the current working directory is used as the
 * root for reading/writing OpenAPI spec files.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import http from "http";
import https from "https";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Workspace root
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return path.normalize(path.resolve(p));
}

const workspaceRoot = normalizePath(
  (() => {
    const idx = process.argv.indexOf("--workspace");
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : process.cwd();
  })(),
);

function resolveWorkspacePath(filePath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? normalizePath(filePath)
    : normalizePath(path.join(workspaceRoot, filePath));
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Access denied: "${resolved}" is outside the workspace root "${workspaceRoot}"`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// In-memory spec registry (specId → OpenAPI object)
// ---------------------------------------------------------------------------

interface OpenAPIInfo {
  title: string;
  version: string;
  description?: string;
}

interface OpenAPISpec {
  openapi: string;
  info: OpenAPIInfo;
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
  tags?: Array<{ name: string; description?: string }>;
}

interface OpenAPIOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content: Record<string, { schema: JsonSchema }>;
  };
  responses: Record<string, OpenAPIResponse>;
  security?: Array<Record<string, string[]>>;
}

interface OpenAPIParameter {
  name: string;
  in: "query" | "header" | "path" | "cookie";
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}

interface OpenAPIResponse {
  description: string;
  content?: Record<string, { schema: JsonSchema }>;
  headers?: Record<string, { description?: string; schema: JsonSchema }>;
}

interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  scheme?: string;
  bearerFormat?: string;
  in?: "query" | "header" | "cookie";
  name?: string;
  description?: string;
}

type JsonSchema = Record<string, unknown>;

const specRegistry = new Map<string, OpenAPISpec>();

// ---------------------------------------------------------------------------
// In-process mock server registry
// ---------------------------------------------------------------------------

interface MockServer {
  server: http.Server;
  port: number;
  specId: string;
}

const mockServers = new Map<string, MockServer>();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateSpecId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Infer a JSON Schema type from a JavaScript value. */
function inferSchema(value: unknown, depth = 0): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 && depth < 4 ? inferSchema(value[0], depth + 1) : {},
    };
  }
  if (typeof value === "object") {
    const props: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      props[k] = depth < 4 ? inferSchema(v, depth + 1) : {};
    }
    return { type: "object", properties: props };
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string" };
}

/** Validate an OpenAPI 3.x spec object and return a list of problems. */
function validateSpec(spec: OpenAPISpec): string[] {
  const problems: string[] = [];

  if (!spec.openapi || !spec.openapi.startsWith("3.")) {
    problems.push('spec.openapi must be a 3.x version string (e.g. "3.1.0")');
  }
  if (!spec.info?.title) problems.push("spec.info.title is required");
  if (!spec.info?.version) problems.push("spec.info.version is required");
  if (!spec.paths || typeof spec.paths !== "object") {
    problems.push("spec.paths is required and must be an object");
    return problems;
  }

  const validMethods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

  for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
    if (!pathKey.startsWith("/")) {
      problems.push(`Path "${pathKey}" must start with "/"`);
    }
    if (typeof pathItem !== "object" || pathItem === null) {
      problems.push(`Path "${pathKey}" must be an object`);
      continue;
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!validMethods.includes(method)) {
        problems.push(`"${method}" on ${pathKey} is not a valid HTTP method`);
        continue;
      }
      const op = operation as OpenAPIOperation;
      if (!op.responses || Object.keys(op.responses).length === 0) {
        problems.push(`${method.toUpperCase()} ${pathKey}: at least one response is required`);
      }
      // Check path params are declared
      const pathParams = (pathKey.match(/\{([^}]+)\}/g) ?? []).map(p => p.slice(1, -1));
      const declaredParams = (op.parameters ?? [])
        .filter(p => p.in === "path")
        .map(p => p.name);
      for (const pp of pathParams) {
        if (!declaredParams.includes(pp)) {
          problems.push(
            `${method.toUpperCase()} ${pathKey}: path parameter "{${pp}}" is not declared in parameters`,
          );
        }
      }
    }
  }
  return problems;
}

/** Perform an HTTP/HTTPS request and return a structured result. */
async function httpRequest(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}> {
  const { method, url, headers = {}, body, timeoutMs = 30_000 } = options;
  const parsed = new URL(url);
  const lib = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = lib.request(
      {
        method: method.toUpperCase(),
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
      },
      res => {
        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(", ") : (v ?? ""),
              ]),
            ),
            body: data,
            durationMs: Date.now() - start,
          });
        });
        res.on("error", reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

/** Generate a mock response for a given operation. */
function generateMockResponse(
  operation: OpenAPIOperation,
  preferredStatus: number,
): { status: number; body: unknown } {
  const statuses = Object.keys(operation.responses ?? {}).map(Number).filter(Boolean);
  const status =
    statuses.includes(preferredStatus)
      ? preferredStatus
      : statuses.find(s => s >= 200 && s < 300) ?? statuses[0] ?? 200;

  const response = operation.responses?.[String(status)];
  if (!response?.content) return { status, body: null };

  const contentTypes = Object.keys(response.content);
  const jsonContent = contentTypes.find(ct => ct.includes("json"));
  if (!jsonContent) return { status, body: null };

  const schema = response.content[jsonContent]?.schema;
  if (!schema) return { status, body: null };

  return { status, body: generateMockValue(schema) };
}

/** Generate a mock value from a JSON Schema. */
function generateMockValue(schema: JsonSchema, depth = 0): unknown {
  if (depth > 5) return null;

  const type = schema.type as string | undefined;
  const example = schema.example;
  if (example !== undefined) return example;

  if (schema.enum && Array.isArray(schema.enum)) return schema.enum[0];

  switch (type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      return Object.fromEntries(
        Object.entries(props).map(([k, v]) => [k, generateMockValue(v, depth + 1)]),
      );
    }
    case "array": {
      const items = (schema.items ?? {}) as JsonSchema;
      return [generateMockValue(items, depth + 1)];
    }
    case "string": {
      const fmt = schema.format as string | undefined;
      if (fmt === "date-time") return new Date().toISOString();
      if (fmt === "date") return new Date().toISOString().slice(0, 10);
      if (fmt === "email") return "user@example.com";
      if (fmt === "uri" || fmt === "url") return "https://example.com";
      if (fmt === "uuid") return "00000000-0000-0000-0000-000000000000";
      return "string";
    }
    case "integer":
      return (schema.minimum as number | undefined) ?? 0;
    case "number":
      return (schema.minimum as number | undefined) ?? 0.0;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
}

/** Parse a curl command string into method, url, headers, and body. */
function parseCurlCommand(curl: string): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
} {
  const tokens = tokenizeCurl(curl);
  let method = "GET";
  let url = "";
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "curl") { i++; continue; }
    if (token === "-X" || token === "--request") {
      method = tokens[++i] ?? "GET";
      i++; continue;
    }
    if (token === "-H" || token === "--header") {
      const header = tokens[++i] ?? "";
      const colonIdx = header.indexOf(":");
      if (colonIdx > 0) {
        headers[header.slice(0, colonIdx).trim()] = header.slice(colonIdx + 1).trim();
      }
      i++; continue;
    }
    if (token === "-d" || token === "--data" || token === "--data-raw" || token === "--data-binary") {
      body = tokens[++i] ?? null;
      if (method === "GET") method = "POST";
      i++; continue;
    }
    if (token === "--json") {
      body = tokens[++i] ?? null;
      if (method === "GET") method = "POST";
      headers["Content-Type"] = "application/json";
      i++; continue;
    }
    if (!token.startsWith("-") && !url) {
      url = token.replace(/^['"]|['"]$/g, "");
    }
    i++;
  }

  return { method, url, headers, body };
}

function tokenizeCurl(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const s = input.replace(/\\\n/g, " ");

  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; i++; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; i++; continue; }
    if ((ch === " " || ch === "\t" || ch === "\n") && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
    i++;
  }
  if (current) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Code generation helpers
// ---------------------------------------------------------------------------

function generateTypeScriptClient(
  spec: OpenAPISpec,
  pathKey: string,
  method: string,
): string {
  const op = spec.paths[pathKey]?.[method] as OpenAPIOperation | undefined;
  if (!op) return `// endpoint ${method.toUpperCase()} ${pathKey} not found in spec`;

  const baseUrl = spec.servers?.[0]?.url ?? "https://api.example.com";
  const operationId = op.operationId ?? `${method}${pathKey.replace(/\W/g, "_")}`;
  const pathParams = (op.parameters ?? []).filter(p => p.in === "path");
  const queryParams = (op.parameters ?? []).filter(p => p.in === "query");
  const hasBody = !!op.requestBody;

  const paramList = [
    ...pathParams.map(p => `${p.name}: string`),
    ...(queryParams.length > 0
      ? [`query?: { ${queryParams.map(p => `${p.name}?: string`).join("; ")} }`]
      : []),
    ...(hasBody ? ["body?: unknown"] : []),
    'options?: RequestInit',
  ].join(", ");

  let urlExpr = `\`${baseUrl}${pathKey.replace(/\{(\w+)\}/g, "${$1}")}\``;
  if (queryParams.length > 0) {
    urlExpr = `(() => { const u = new URL(${urlExpr}); if (query) Object.entries(query).forEach(([k,v]) => v != null && u.searchParams.set(k, v)); return u.toString(); })()`;
  }

  const bodyPart = hasBody
    ? `\n  body: JSON.stringify(body),\n  headers: { 'Content-Type': 'application/json', ...options?.headers },`
    : "";

  return `// Auto-generated TypeScript client — ${op.summary ?? `${method.toUpperCase()} ${pathKey}`}
export async function ${operationId}(${paramList}): Promise<Response> {
  const url = ${urlExpr};
  return fetch(url, {
    method: '${method.toUpperCase()}',${bodyPart}
    ...options,
  });
}`;
}

function generatePythonClient(
  spec: OpenAPISpec,
  pathKey: string,
  method: string,
): string {
  const op = spec.paths[pathKey]?.[method] as OpenAPIOperation | undefined;
  if (!op) return `# endpoint ${method.toUpperCase()} ${pathKey} not found in spec`;

  const baseUrl = spec.servers?.[0]?.url ?? "https://api.example.com";
  const operationId = (op.operationId ?? `${method}_${pathKey.replace(/\W+/g, "_")}`).replace(/-/g, "_");
  const pathParams = (op.parameters ?? []).filter(p => p.in === "path");
  const queryParams = (op.parameters ?? []).filter(p => p.in === "query");
  const hasBody = !!op.requestBody;

  const paramList = [
    ...pathParams.map(p => `${p.name}: str`),
    ...(queryParams.length > 0 ? queryParams.map(p => `${p.name}: str | None = None`) : []),
    ...(hasBody ? ["body: dict | None = None"] : []),
  ].join(", ");

  const urlLine = `    url = f"${baseUrl}${pathKey.replace(/\{(\w+)\}/g, "{$1}")}"`;
  const queryPart =
    queryParams.length > 0
      ? `\n    params = {k: v for k, v in {${queryParams.map(p => `"${p.name}": ${p.name}`).join(", ")}}.items() if v is not None}`
      : "";
  const paramsArg = queryParams.length > 0 ? ", params=params" : "";
  const bodyArg = hasBody ? ", json=body" : "";

  return `# Auto-generated Python client — ${op.summary ?? `${method.toUpperCase()} ${pathKey}`}
import requests

def ${operationId}(${paramList}) -> requests.Response:
${urlLine}${queryPart}
    return requests.${method}(url${paramsArg}${bodyArg})`;
}

function generateCurlExample(
  spec: OpenAPISpec,
  pathKey: string,
  method: string,
): string {
  const op = spec.paths[pathKey]?.[method] as OpenAPIOperation | undefined;
  if (!op) return `# endpoint ${method.toUpperCase()} ${pathKey} not found in spec`;

  const baseUrl = spec.servers?.[0]?.url ?? "https://api.example.com";
  const pathParams = (op.parameters ?? []).filter(p => p.in === "path");
  const queryParams = (op.parameters ?? []).filter(p => p.in === "query");
  const hasBody = !!op.requestBody;

  let urlStr = baseUrl + pathKey;
  for (const p of pathParams) urlStr = urlStr.replace(`{${p.name}}`, `<${p.name}>`);
  if (queryParams.length > 0) {
    urlStr += "?" + queryParams.map(p => `${p.name}=<${p.name}>`).join("&");
  }

  const lines = [
    `curl -X ${method.toUpperCase()} \\`,
    `  '${urlStr}' \\`,
    `  -H 'Accept: application/json'`,
  ];

  if (hasBody) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '{"key": "value"}'`);
  }

  return `# ${op.summary ?? `${method.toUpperCase()} ${pathKey}`}\n` + lines.join("\n");
}

// ---------------------------------------------------------------------------
// Mock server handler
// ---------------------------------------------------------------------------

function createMockHandler(spec: OpenAPISpec): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const reqMethod = (req.method ?? "GET").toLowerCase();

    // Find matching path
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      const pattern = pathKey.replace(/\{[^}]+\}/g, "([^/]+)");
      const regex = new RegExp(`^${pattern}$`);
      if (!regex.test(reqUrl.pathname)) continue;

      const operation = pathItem[reqMethod] as OpenAPIOperation | undefined;
      if (!operation) {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      const { status, body } = generateMockResponse(operation, 200);
      res.writeHead(status, { "Content-Type": "application/json", "X-Mock": "true" });
      res.end(body !== null ? JSON.stringify(body, null, 2) : "");
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found", path: reqUrl.pathname }));
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "api-wizard", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_spec",
      description:
        "Create a new in-memory OpenAPI 3.1 specification. Returns a specId that must be passed to subsequent tools.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "API title" },
          version: { type: "string", description: 'API version string, e.g. "1.0.0"' },
          description: { type: "string", description: "API description (optional)" },
          serverUrl: { type: "string", description: 'Base server URL, e.g. "https://api.example.com"' },
        },
        required: ["title", "version"],
      },
    },
    {
      name: "load_spec",
      description: "Load an OpenAPI spec from a JSON or YAML file into memory. Returns a specId.",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path to the OpenAPI JSON file (relative to workspace or absolute)." },
          specId: { type: "string", description: "Optional custom specId. If omitted one is derived from the title." },
        },
        required: ["filePath"],
      },
    },
    {
      name: "save_spec",
      description: "Save an in-memory spec to a JSON file in the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string", description: "Spec identifier returned by create_spec or load_spec." },
          filePath: { type: "string", description: "Destination file path relative to workspace (e.g. openapi.json)." },
        },
        required: ["specId", "filePath"],
      },
    },
    {
      name: "list_specs",
      description: "List all in-memory specs with their IDs, title, version, and path count.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "add_endpoint",
      description:
        "Add or replace an endpoint (path + HTTP method) in an in-memory spec.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          path: { type: "string", description: 'Endpoint path, e.g. "/users/{id}"' },
          method: {
            type: "string",
            enum: ["get", "post", "put", "patch", "delete", "head", "options"],
            description: "HTTP method (lowercase)",
          },
          summary: { type: "string" },
          description: { type: "string" },
          operationId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          parameters: {
            type: "array",
            description: "Path, query, header, or cookie parameters",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                in: { type: "string", enum: ["path", "query", "header", "cookie"] },
                required: { type: "boolean" },
                description: { type: "string" },
                schema: { type: "object" },
              },
              required: ["name", "in"],
            },
          },
          requestBody: {
            type: "object",
            description: "Request body definition",
            properties: {
              description: { type: "string" },
              required: { type: "boolean" },
              schema: { type: "object", description: "JSON Schema for the request body" },
            },
          },
          responses: {
            type: "object",
            description: 'Map of HTTP status codes to response definitions, e.g. {"200": {"description": "OK", "schema": {...}}}',
          },
        },
        required: ["specId", "path", "method", "responses"],
      },
    },
    {
      name: "remove_endpoint",
      description: "Remove an endpoint from a spec.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          path: { type: "string" },
          method: { type: "string" },
        },
        required: ["specId", "path", "method"],
      },
    },
    {
      name: "list_endpoints",
      description: "List all endpoints in a spec with their methods, summaries, and tags.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          tag: { type: "string", description: "Optional tag filter" },
        },
        required: ["specId"],
      },
    },
    {
      name: "get_endpoint",
      description: "Return the full OpenAPI definition for a single endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          path: { type: "string" },
          method: { type: "string" },
        },
        required: ["specId", "path", "method"],
      },
    },
    {
      name: "validate_spec",
      description:
        "Validate an in-memory spec for structural and semantic errors. Returns a list of problems or confirms the spec is valid.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
        },
        required: ["specId"],
      },
    },
    {
      name: "diff_specs",
      description:
        "Compare two in-memory specs and report added, removed, and changed endpoints.",
      inputSchema: {
        type: "object",
        properties: {
          specIdA: { type: "string", description: "Base spec" },
          specIdB: { type: "string", description: "Target spec to compare against the base" },
        },
        required: ["specIdA", "specIdB"],
      },
    },
    {
      name: "make_request",
      description:
        "Execute an HTTP request and return the status, headers, and body. Useful for testing live APIs.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "HTTP method" },
          url: { type: "string", description: "Full URL" },
          headers: { type: "object", description: "Request headers" },
          body: { type: "string", description: "Request body (string)" },
          timeoutSeconds: { type: "number", description: "Request timeout in seconds (default 30)" },
        },
        required: ["method", "url"],
      },
    },
    {
      name: "inspect_api",
      description:
        "Send a request to a live endpoint and automatically infer an OpenAPI schema from the response. Optionally adds the inferred endpoint to an existing spec.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          url: { type: "string" },
          headers: { type: "object" },
          body: { type: "string" },
          specId: { type: "string", description: "If provided, the inferred endpoint is added to this spec." },
          endpointPath: { type: "string", description: 'OpenAPI path override, e.g. "/users/{id}". Defaults to the URL path.' },
        },
        required: ["method", "url"],
      },
    },
    {
      name: "import_from_curl",
      description:
        "Parse a curl command string into a structured request definition. Optionally executes the request.",
      inputSchema: {
        type: "object",
        properties: {
          curl: { type: "string", description: "The curl command to parse" },
          execute: { type: "boolean", description: "If true, also executes the parsed request and returns the response.", default: false },
        },
        required: ["curl"],
      },
    },
    {
      name: "generate_client_code",
      description:
        "Generate client code for one or all endpoints in a spec. Supports TypeScript, Python, and curl.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          language: { type: "string", enum: ["typescript", "python", "curl"], description: "Target language" },
          path: { type: "string", description: "Endpoint path. If omitted, generates code for all endpoints." },
          method: { type: "string", description: "HTTP method. Required when path is specified." },
        },
        required: ["specId", "language"],
      },
    },
    {
      name: "add_schema",
      description: "Add a reusable JSON Schema component to a spec's components.schemas.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          name: { type: "string", description: "Schema name (used as $ref key)" },
          schema: { type: "object", description: "The JSON Schema definition" },
        },
        required: ["specId", "name", "schema"],
      },
    },
    {
      name: "add_security_scheme",
      description: "Add a security scheme (API key, Bearer token, OAuth2) to a spec.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          name: { type: "string", description: 'Security scheme name, e.g. "bearerAuth"' },
          type: { type: "string", enum: ["apiKey", "http", "oauth2", "openIdConnect"] },
          scheme: { type: "string", description: 'For type=http: "bearer" or "basic"' },
          bearerFormat: { type: "string", description: 'For Bearer: "JWT"' },
          in: { type: "string", enum: ["query", "header", "cookie"], description: "For apiKey: where the key is sent" },
          keyName: { type: "string", description: "For apiKey: the parameter name (e.g. X-API-Key)" },
        },
        required: ["specId", "name", "type"],
      },
    },
    {
      name: "mock_server_start",
      description:
        "Start an in-process HTTP mock server for a spec on a local port. The mock server returns auto-generated responses based on the spec schemas.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          port: { type: "number", description: "Local port to listen on (default: 4010)" },
        },
        required: ["specId"],
      },
    },
    {
      name: "mock_server_stop",
      description: "Stop a running mock server.",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
        },
        required: ["specId"],
      },
    },
    {
      name: "list_mock_servers",
      description: "List all running mock servers.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "export_spec",
      description: "Return the full OpenAPI spec as a JSON string (for pasting into other tools).",
      inputSchema: {
        type: "object",
        properties: {
          specId: { type: "string" },
          pretty: { type: "boolean", description: "Pretty-print JSON (default: true)", default: true },
        },
        required: ["specId"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;

  function requireSpec(specId: string): OpenAPISpec {
    const spec = specRegistry.get(specId);
    if (!spec) {
      const available = [...specRegistry.keys()].join(", ") || "(none)";
      throw new McpError(
        ErrorCode.InvalidParams,
        `Spec "${specId}" not found. Available specs: ${available}`,
      );
    }
    return spec;
  }

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "create_spec": {
        const title = args!.title as string;
        const version = args!.version as string;
        const description = args!.description as string | undefined;
        const serverUrl = (args!.serverUrl as string | undefined) ?? "https://api.example.com";
        const specId = generateSpecId(title);

        const spec: OpenAPISpec = {
          openapi: "3.1.0",
          info: { title, version, ...(description ? { description } : {}) },
          servers: [{ url: serverUrl }],
          paths: {},
        };
        specRegistry.set(specId, spec);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ specId, title, version, serverUrl }, null, 2),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "load_spec": {
        const filePath = resolveWorkspacePath(args!.filePath as string);
        const raw = await fs.readFile(filePath, "utf8");
        let spec: OpenAPISpec;
        try {
          spec = JSON.parse(raw) as OpenAPISpec;
        } catch {
          throw new McpError(ErrorCode.InvalidParams, `File "${filePath}" is not valid JSON.`);
        }
        const specId = (args!.specId as string | undefined) ?? generateSpecId(spec.info?.title ?? "api");
        specRegistry.set(specId, spec);
        return {
          content: [
            {
              type: "text",
              text: `✓ Loaded spec "${spec.info?.title}" as specId="${specId}" (${Object.keys(spec.paths ?? {}).length} paths).`,
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "save_spec": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const filePath = resolveWorkspacePath(args!.filePath as string);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(spec, null, 2) + "\n", "utf8");
        return {
          content: [
            { type: "text", text: `✓ Saved spec "${specId}" to "${filePath}".` },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "list_specs": {
        const list = [...specRegistry.entries()].map(([id, s]) => ({
          specId: id,
          title: s.info.title,
          version: s.info.version,
          endpointCount: Object.values(s.paths).reduce(
            (acc, p) => acc + Object.keys(p).length,
            0,
          ),
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify(list, null, 2) },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "add_endpoint": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const endpointPath = args!.path as string;
        const method = (args!.method as string).toLowerCase();
        const responses = args!.responses as Record<string, { description: string; schema?: JsonSchema }>;

        // Build operation
        const operation: OpenAPIOperation = {
          responses: Object.fromEntries(
            Object.entries(responses).map(([status, resp]) => [
              status,
              {
                description: resp.description,
                ...(resp.schema
                  ? { content: { "application/json": { schema: resp.schema } } }
                  : {}),
              } as OpenAPIResponse,
            ]),
          ),
        };

        if (args!.summary) operation.summary = args!.summary as string;
        if (args!.description) operation.description = args!.description as string;
        if (args!.operationId) operation.operationId = args!.operationId as string;
        if (args!.tags) operation.tags = args!.tags as string[];

        if (args!.parameters) {
          operation.parameters = args!.parameters as OpenAPIParameter[];
        } else {
          // Auto-extract path parameters
          const pathParams = (endpointPath.match(/\{([^}]+)\}/g) ?? []).map(p => p.slice(1, -1));
          if (pathParams.length > 0) {
            operation.parameters = pathParams.map(p => ({
              name: p,
              in: "path" as const,
              required: true,
              schema: { type: "string" },
            }));
          }
        }

        if (args!.requestBody) {
          const rb = args!.requestBody as { description?: string; required?: boolean; schema?: JsonSchema };
          operation.requestBody = {
            required: rb.required ?? true,
            ...(rb.description ? { description: rb.description } : {}),
            content: {
              "application/json": {
                schema: rb.schema ?? { type: "object" },
              },
            },
          };
        }

        if (!spec.paths[endpointPath]) spec.paths[endpointPath] = {};
        spec.paths[endpointPath][method] = operation;

        return {
          content: [
            {
              type: "text",
              text: `✓ Added ${method.toUpperCase()} ${endpointPath} to spec "${specId}".`,
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "remove_endpoint": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const endpointPath = args!.path as string;
        const method = (args!.method as string).toLowerCase();

        if (!spec.paths[endpointPath]?.[method]) {
          return {
            content: [
              { type: "text", text: `Endpoint ${method.toUpperCase()} ${endpointPath} not found in spec "${specId}".` },
            ],
          };
        }

        delete spec.paths[endpointPath][method];
        if (Object.keys(spec.paths[endpointPath]).length === 0) {
          delete spec.paths[endpointPath];
        }

        return {
          content: [
            { type: "text", text: `✓ Removed ${method.toUpperCase()} ${endpointPath} from spec "${specId}".` },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "list_endpoints": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const tagFilter = args!.tag as string | undefined;

        const endpoints: Array<{
          method: string;
          path: string;
          operationId?: string;
          summary?: string;
          tags?: string[];
        }> = [];

        for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(pathItem)) {
            const operation = op as OpenAPIOperation;
            if (tagFilter && !operation.tags?.includes(tagFilter)) continue;
            endpoints.push({
              method: method.toUpperCase(),
              path: pathKey,
              operationId: operation.operationId,
              summary: operation.summary,
              tags: operation.tags,
            });
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(endpoints, null, 2) }],
        };
      }

      // -----------------------------------------------------------------------
      case "get_endpoint": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const endpointPath = args!.path as string;
        const method = (args!.method as string).toLowerCase();

        const op = spec.paths[endpointPath]?.[method];
        if (!op) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Endpoint ${method.toUpperCase()} ${endpointPath} not found in spec "${specId}".`,
          );
        }

        return {
          content: [{ type: "text", text: JSON.stringify(op, null, 2) }],
        };
      }

      // -----------------------------------------------------------------------
      case "validate_spec": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const problems = validateSpec(spec);

        if (problems.length === 0) {
          return {
            content: [
              { type: "text", text: `✓ Spec "${specId}" is valid. No problems found.` },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Found ${problems.length} problem(s) in spec "${specId}":\n\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "diff_specs": {
        const specIdA = args!.specIdA as string;
        const specIdB = args!.specIdB as string;
        const specA = requireSpec(specIdA);
        const specB = requireSpec(specIdB);

        const endpointsA = new Set<string>();
        const endpointsB = new Set<string>();

        for (const [p, pi] of Object.entries(specA.paths)) {
          for (const m of Object.keys(pi)) endpointsA.add(`${m.toUpperCase()} ${p}`);
        }
        for (const [p, pi] of Object.entries(specB.paths)) {
          for (const m of Object.keys(pi)) endpointsB.add(`${m.toUpperCase()} ${p}`);
        }

        const added = [...endpointsB].filter(e => !endpointsA.has(e));
        const removed = [...endpointsA].filter(e => !endpointsB.has(e));
        const common = [...endpointsA].filter(e => endpointsB.has(e));

        // Check changed summaries/descriptions on common endpoints
        const changed: string[] = [];
        for (const endpoint of common) {
          const [method, ...pathParts] = endpoint.split(" ");
          const pathKey = pathParts.join(" ");
          const opA = specA.paths[pathKey]?.[method.toLowerCase()] as OpenAPIOperation;
          const opB = specB.paths[pathKey]?.[method.toLowerCase()] as OpenAPIOperation;
          if (JSON.stringify(opA) !== JSON.stringify(opB)) {
            changed.push(endpoint);
          }
        }

        const diff = {
          baseSpec: specIdA,
          targetSpec: specIdB,
          added,
          removed,
          changed,
          summary: `+${added.length} added, -${removed.length} removed, ~${changed.length} changed`,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(diff, null, 2) }],
        };
      }

      // -----------------------------------------------------------------------
      case "make_request": {
        const result = await httpRequest({
          method: args!.method as string,
          url: args!.url as string,
          headers: (args!.headers as Record<string, string> | undefined) ?? {},
          body: args!.body as string | undefined,
          timeoutMs: ((args!.timeoutSeconds as number | undefined) ?? 30) * 1000,
        });

        let parsedBody: unknown = result.body;
        try { parsedBody = JSON.parse(result.body); } catch { /* keep as string */ }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: result.status,
                  statusText: result.statusText,
                  durationMs: result.durationMs,
                  headers: result.headers,
                  body: parsedBody,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "inspect_api": {
        const result = await httpRequest({
          method: args!.method as string,
          url: args!.url as string,
          headers: (args!.headers as Record<string, string> | undefined) ?? {},
          body: args!.body as string | undefined,
        });

        let parsedBody: unknown = result.body;
        try { parsedBody = JSON.parse(result.body); } catch { /* keep as string */ }

        const responseSchema = inferSchema(parsedBody);
        const urlParsed = new URL(args!.url as string);
        const endpointPath = (args!.endpointPath as string | undefined) ?? urlParsed.pathname;
        const method = (args!.method as string).toLowerCase();

        const inferred: OpenAPIOperation = {
          summary: `${(args!.method as string).toUpperCase()} ${endpointPath}`,
          responses: {
            [String(result.status)]: {
              description: `HTTP ${result.status} ${result.statusText}`,
              content: { "application/json": { schema: responseSchema } },
            },
          },
        };

        // If a specId was given, add the endpoint to the spec
        if (args!.specId) {
          const spec = requireSpec(args!.specId as string);
          if (!spec.paths[endpointPath]) spec.paths[endpointPath] = {};
          spec.paths[endpointPath][method] = inferred;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: result.status,
                  durationMs: result.durationMs,
                  inferredEndpoint: { path: endpointPath, method, operation: inferred },
                  ...(args!.specId ? { addedToSpec: args!.specId } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "import_from_curl": {
        const parsed = parseCurlCommand(args!.curl as string);
        const execute = (args!.execute as boolean | undefined) ?? false;

        if (!execute) {
          return {
            content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
          };
        }

        if (!parsed.url) {
          throw new McpError(ErrorCode.InvalidParams, "Could not extract a URL from the curl command.");
        }

        const result = await httpRequest({
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          body: parsed.body ?? undefined,
        });

        let parsedBody: unknown = result.body;
        try { parsedBody = JSON.parse(result.body); } catch { /* keep as string */ }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  parsed,
                  response: {
                    status: result.status,
                    statusText: result.statusText,
                    durationMs: result.durationMs,
                    body: parsedBody,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "generate_client_code": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const language = args!.language as "typescript" | "python" | "curl";
        const targetPath = args!.path as string | undefined;
        const targetMethod = args!.method as string | undefined;

        const generate = (p: string, m: string): string => {
          switch (language) {
            case "typescript": return generateTypeScriptClient(spec, p, m);
            case "python": return generatePythonClient(spec, p, m);
            case "curl": return generateCurlExample(spec, p, m);
          }
        };

        if (targetPath && targetMethod) {
          return {
            content: [{ type: "text", text: generate(targetPath, targetMethod.toLowerCase()) }],
          };
        }

        // Generate for all endpoints
        const blocks: string[] = [];
        for (const [p, pathItem] of Object.entries(spec.paths)) {
          for (const m of Object.keys(pathItem)) {
            blocks.push(generate(p, m));
          }
        }

        return {
          content: [{ type: "text", text: blocks.join("\n\n") }],
        };
      }

      // -----------------------------------------------------------------------
      case "add_schema": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const schemaName = args!.name as string;
        const schema = args!.schema as JsonSchema;

        if (!spec.components) spec.components = {};
        if (!spec.components.schemas) spec.components.schemas = {};
        spec.components.schemas[schemaName] = schema;

        return {
          content: [
            { type: "text", text: `✓ Added schema "${schemaName}" to spec "${specId}".` },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "add_security_scheme": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const schemeName = args!.name as string;
        const type = args!.type as SecurityScheme["type"];

        const scheme: SecurityScheme = { type };
        if (args!.scheme) scheme.scheme = args!.scheme as string;
        if (args!.bearerFormat) scheme.bearerFormat = args!.bearerFormat as string;
        if (args!.in) scheme.in = args!.in as SecurityScheme["in"];
        if (args!.keyName) scheme.name = args!.keyName as string;

        if (!spec.components) spec.components = {};
        if (!spec.components.securitySchemes) spec.components.securitySchemes = {};
        spec.components.securitySchemes[schemeName] = scheme;

        return {
          content: [
            { type: "text", text: `✓ Added security scheme "${schemeName}" (${type}) to spec "${specId}".` },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "mock_server_start": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const port = (args!.port as number | undefined) ?? 4010;

        if (mockServers.has(specId)) {
          const existing = mockServers.get(specId)!;
          return {
            content: [
              { type: "text", text: `Mock server for "${specId}" is already running on port ${existing.port}.` },
            ],
          };
        }

        const httpServer = http.createServer(createMockHandler(spec));

        await new Promise<void>((resolve, reject) => {
          httpServer.once("error", reject);
          httpServer.listen(port, "127.0.0.1", resolve);
        });

        mockServers.set(specId, { server: httpServer, port, specId });

        return {
          content: [
            {
              type: "text",
              text: `✓ Mock server for "${specId}" started at http://127.0.0.1:${port}\n` +
                `Routes: ${Object.entries(spec.paths).flatMap(([p, pi]) => Object.keys(pi).map(m => `${m.toUpperCase()} ${p}`)).join(", ")}`,
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "mock_server_stop": {
        const specId = args!.specId as string;
        const mock = mockServers.get(specId);
        if (!mock) {
          return {
            content: [{ type: "text", text: `No mock server running for spec "${specId}".` }],
          };
        }

        await new Promise<void>((resolve, reject) => {
          mock.server.close(err => (err ? reject(err) : resolve()));
        });

        mockServers.delete(specId);
        return {
          content: [{ type: "text", text: `✓ Mock server for "${specId}" stopped.` }],
        };
      }

      // -----------------------------------------------------------------------
      case "list_mock_servers": {
        const list = [...mockServers.values()].map(m => ({
          specId: m.specId,
          port: m.port,
          url: `http://127.0.0.1:${m.port}`,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
        };
      }

      // -----------------------------------------------------------------------
      case "export_spec": {
        const specId = args!.specId as string;
        const spec = requireSpec(specId);
        const pretty = (args!.pretty as boolean | undefined) ?? true;
        return {
          content: [
            { type: "text", text: pretty ? JSON.stringify(spec, null, 2) : JSON.stringify(spec) },
          ],
        };
      }

      // -----------------------------------------------------------------------
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof McpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpError(ErrorCode.InternalError, message);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[mcp-api-wizard-server] started. Workspace: ${workspaceRoot}\n`,
  );
}

main().catch(err => {
  process.stderr.write(`[mcp-api-wizard-server] fatal: ${err}\n`);
  process.exit(1);
});
