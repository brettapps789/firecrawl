# Market Research MCP Server — Top Selling Ebooks

An **MCP (Model Context Protocol) server** that exposes market research tools
for top-selling ebooks. Connect it to any MCP-compatible AI assistant (e.g.
Claude Desktop, Cursor, Continue) and ask natural-language questions like:

> *"What are the top 10 bestselling romance Kindle ebooks right now?"*  
> *"Compare 'Atomic Habits', 'The 48 Laws of Power', and 'Deep Work'."*  
> *"What market trends should I know about before publishing a self-help ebook?"*

The server scrapes live data from Amazon Kindle Best Sellers and Goodreads
using **Firecrawl** and returns structured JSON you can act on.

---

## Tools exposed

| Tool | Description |
|------|-------------|
| `search_top_ebooks` | Fetch current bestselling Kindle eBooks for a category |
| `get_ebook_details` | Deep-dive into a single title (pricing, rank, reviews, comps) |
| `analyze_market_trends` | Category-level trend analysis (pricing, themes, KU coverage) |
| `compare_ebooks` | Side-by-side competitive comparison of 2–5 titles |
| `get_goodreads_bestsellers` | Community-validated bestseller lists from Goodreads |

### Supported categories for `search_top_ebooks` / `analyze_market_trends`

`fiction`, `nonfiction`, `mystery`, `romance`, `sci-fi`, `fantasy`,
`biography`, `self-help`, `business`, `history`, `children`, `horror`,
`thriller`, `literary fiction`

---

## Requirements

- Python 3.11+
- [Firecrawl API key](https://firecrawl.dev) — free tier is sufficient for
  light usage

---

## Installation

```bash
# 1. Clone the repo (if you haven't already)
git clone https://github.com/mendableai/firecrawl.git
cd firecrawl/examples/mcp-ebook-market-research

# 2. Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Configure environment variables
cp .env.example .env
# Edit .env and add your Firecrawl API key
```

---

## Running the server

### Stdio mode (default — recommended for Claude Desktop / Cursor)

```bash
python server.py
```

The server communicates over **stdin / stdout**, which is what MCP clients
such as Claude Desktop expect.

### Connecting to Claude Desktop

Add the following entry to your Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ebook-market-research": {
      "command": "python",
      "args": ["/absolute/path/to/server.py"],
      "env": {
        "FIRECRAWL_API_KEY": "your_firecrawl_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop and the tools will appear in the tool picker.

---

## Example prompts

Once connected, try these in your AI assistant:

```
Search for the top 5 best-selling fantasy ebooks on Amazon.
```

```
Give me detailed market info on the ebook "Fourth Wing" by Rebecca Yarros.
```

```
Analyze market trends in the self-help ebook category.
```

```
Compare these ebooks: "Atomic Habits", "The 48 Laws of Power", "Deep Work".
```

```
Fetch the Goodreads list of best Kindle books of all time.
```

---

## How it works

```
AI Assistant (Claude, etc.)
        │  MCP tool call
        ▼
  server.py  (FastMCP)
        │  HTTP requests
        ▼
  Firecrawl API
        │  scrapes & LLM-extracts
        ▼
  Amazon / Goodreads
        │  structured JSON
        ▼
  AI Assistant receives data
```

1. The AI assistant invokes one of the MCP tools with parameters.
2. `server.py` builds the target URL(s) and calls Firecrawl's `/v1/extract`
   endpoint with a tailored extraction prompt.
3. Firecrawl scrapes the live page(s) and uses its built-in LLM to return
   structured JSON.
4. The server returns the JSON string to the AI assistant, which uses it to
   answer the user's question.

---

## License

MIT
