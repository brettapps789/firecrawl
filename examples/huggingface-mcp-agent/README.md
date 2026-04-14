# HuggingFace MCP Server Agent

An agentic web-research assistant that combines **HuggingFace smolagents** with the **Firecrawl MCP server**. The agent receives a natural-language task, autonomously decides which Firecrawl tools to call (scrape, crawl, map, search, extract …), and synthesizes a final answer.

## How it works

```
User task
    │
    ▼
HuggingFace InferenceClientModel (Qwen2.5-72B-Instruct)
    │   tool calls / observations
    ▼
smolagents ToolCallingAgent
    │   MCP tool calls (SSE transport)
    ▼
Firecrawl MCP Server  ──▶  scrape / crawl / map / extract
    │
    ▼
Final answer returned to user
```

## Features

- **Model Context Protocol (MCP)** — connects to the hosted Firecrawl MCP server over SSE, so every Firecrawl capability is available as a tool automatically.
- **HuggingFace Inference API** — uses `Qwen/Qwen2.5-72B-Instruct` by default; swap `HF_MODEL_ID` for any model on the Hub.
- **Multi-step reasoning** — the agent iterates up to 10 steps, chaining tool calls until it has enough information to answer.
- Color-coded console output for easy reading.

## Prerequisites

- Python 3.9 or higher
- A [Firecrawl API key](https://www.firecrawl.dev/)
- A [Hugging Face token](https://huggingface.co/settings/tokens) with Inference API access

## Installation

1. Clone this repository and navigate to this example:
   ```bash
   cd examples/huggingface-mcp-agent
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Copy the environment template and fill in your keys:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env`:
   ```
   FIRECRAWL_API_KEY=your_firecrawl_api_key_here
   HF_TOKEN=your_huggingface_token_here
   ```

## Usage

```bash
python huggingface_mcp_agent.py
```

You will be prompted for:

1. **Website URL** — the starting point for the agent (e.g. `https://docs.firecrawl.dev`)
2. **Research objective** — what you want to find out (e.g. "List all available API endpoints and their descriptions")

### Example session

```
Enter the website URL to research: https://firecrawl.dev
Enter your research objective: What are the main pricing plans and their limits?

Agent is working on your task...

Agent Result:
Firecrawl offers three plans:
• Free  — 500 credits/month, scrape only
• Hobby — $16/month, 3 000 credits …
…
```

### Customizing the model

Edit `HF_MODEL_ID` in the script to use a different model:

```python
HF_MODEL_ID = "meta-llama/Llama-3.3-70B-Instruct"
```

Any chat model on the HuggingFace Hub that is available via the serverless Inference API will work.

## Dependencies

| Package | Purpose |
|---------|---------|
| `smolagents[mcp]` | Agent framework + MCP client from HuggingFace |
| `firecrawl-py` | Optional — direct Firecrawl SDK (not required for MCP usage) |
| `python-dotenv` | Load `.env` environment variables |

## License

Apache 2.0
