import os
from dotenv import load_dotenv
from smolagents import MCPClient, InferenceClientModel, ToolCallingAgent

# ANSI color codes for pretty terminal output
class Colors:
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    GREEN = '\033[92m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

# Load environment variables
load_dotenv()

# Retrieve API keys from environment variables
firecrawl_api_key = os.getenv("FIRECRAWL_API_KEY")
hf_token = os.getenv("HF_TOKEN")

if not firecrawl_api_key:
    raise ValueError(
        f"{Colors.RED}FIRECRAWL_API_KEY is not set. "
        f"Please add it to your .env file.{Colors.RESET}"
    )

if not hf_token:
    raise ValueError(
        f"{Colors.RED}HF_TOKEN is not set. "
        f"Please add your Hugging Face token to your .env file.{Colors.RESET}"
    )

# Firecrawl MCP server URL (SSE transport)
FIRECRAWL_MCP_URL = f"https://mcp.firecrawl.dev/{firecrawl_api_key}/sse"

# HuggingFace model — using Qwen2.5-72B-Instruct via the Inference API
HF_MODEL_ID = "Qwen/Qwen2.5-72B-Instruct"


def run_agent(task: str, model_id: str = HF_MODEL_ID) -> str:
    """
    Run a HuggingFace smolagents ToolCallingAgent backed by the Firecrawl MCP server.

    Args:
        task: Natural-language task for the agent to complete.
        model_id: HuggingFace model ID to use for the agent.

    Returns:
        The agent's final answer as a string.
    """
    print(f"\n{Colors.CYAN}╔══════════════════════════════════════════════════════╗{Colors.RESET}")
    print(f"{Colors.CYAN}║      HuggingFace MCP Agent — powered by Firecrawl      ║{Colors.RESET}")
    print(f"{Colors.CYAN}╚══════════════════════════════════════════════════════╝{Colors.RESET}\n")

    print(f"{Colors.BLUE}Task:{Colors.RESET} {task}")
    print(f"{Colors.BLUE}Model:{Colors.RESET} {model_id}\n")

    print(f"{Colors.YELLOW}Connecting to Firecrawl MCP server...{Colors.RESET}")

    with MCPClient(
        {"url": FIRECRAWL_MCP_URL, "transport": "sse"},
        structured_output=True,
    ) as firecrawl_tools:
        print(
            f"{Colors.GREEN}Connected! Available tools: "
            f"{[t.name for t in firecrawl_tools]}{Colors.RESET}\n"
        )

        model = InferenceClientModel(
            model_id=model_id,
            token=hf_token,
        )

        agent = ToolCallingAgent(
            tools=firecrawl_tools,
            model=model,
            max_steps=10,
        )

        print(f"{Colors.YELLOW}Agent is working on your task...{Colors.RESET}\n")
        result = agent.run(task)

    print(f"\n{Colors.GREEN}═══════════════════════════════════════{Colors.RESET}")
    print(f"{Colors.GREEN}Agent Result:{Colors.RESET}")
    print(f"{Colors.MAGENTA}{result}{Colors.RESET}")
    print(f"{Colors.GREEN}═══════════════════════════════════════{Colors.RESET}\n")

    return result


def main():
    print(
        f"{Colors.CYAN}HuggingFace MCP Server Agent{Colors.RESET}\n"
        f"Uses smolagents + Firecrawl MCP to research any topic on the web.\n"
    )

    url = input(f"{Colors.BLUE}Enter the website URL to research: {Colors.RESET}").strip()
    if not url:
        print(f"{Colors.RED}No URL entered. Exiting.{Colors.RESET}")
        return

    if not url.startswith("http"):
        url = "https://" + url

    objective = input(
        f"{Colors.BLUE}Enter your research objective (what do you want to find?): {Colors.RESET}"
    ).strip()
    if not objective:
        print(f"{Colors.RED}No objective entered. Exiting.{Colors.RESET}")
        return

    task = (
        f"Visit {url} and help me with the following objective: {objective}\n\n"
        "Use the Firecrawl tools to scrape or crawl the website as needed, "
        "then provide a thorough, well-structured answer."
    )

    run_agent(task)


if __name__ == "__main__":
    main()
