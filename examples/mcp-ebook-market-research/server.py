#!/usr/bin/env python3
"""
Market Research MCP Server for Top Selling Ebooks

An MCP (Model Context Protocol) server that exposes tools for researching
top-selling ebooks using Firecrawl web scraping.
"""

import os
import json
import requests
from dotenv import load_dotenv
from firecrawl import V1FirecrawlApp
from mcp.server.fastmcp import FastMCP

load_dotenv()

FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY", "")

# Base URLs for ebook bestseller sources
AMAZON_KINDLE_BESTSELLERS = "https://www.amazon.com/Best-Sellers-Kindle-Store-eBooks/zgbs/digital-text/"
GOODREADS_LISTOPIA = "https://www.goodreads.com/list/show/"

# Supported categories — used to build human-readable Amazon search URLs so
# that each category has a distinct, correct URL with no node-ID guessing.
SUPPORTED_CATEGORIES = {
    "fiction", "nonfiction", "mystery", "romance", "sci-fi", "fantasy",
    "biography", "self-help", "business", "history", "children", "horror",
    "thriller", "literary fiction",
}


def _get_firecrawl() -> V1FirecrawlApp:
    """Return a configured Firecrawl SDK client."""
    if not FIRECRAWL_API_KEY:
        raise ValueError(
            "FIRECRAWL_API_KEY is not set. "
            "Copy .env.example to .env and add your key."
        )
    return V1FirecrawlApp(api_key=FIRECRAWL_API_KEY)


def _amazon_search_url(query: str) -> str:
    """Build an Amazon Kindle eBook search URL for a given query string."""
    encoded = requests.utils.quote(query)
    return f"https://www.amazon.com/s?k={encoded}&i=digital-text&rh=n%3A133140011"


def _firecrawl_extract(urls: list[str], prompt: str) -> object:
    """Extract structured data from URLs using the Firecrawl SDK."""
    app = _get_firecrawl()
    response = app.extract(urls, prompt=prompt, enable_web_search=False)
    # V1FirecrawlApp.extract returns a V1ExtractResponse; .data holds the result.
    return response.data if hasattr(response, "data") else response


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "Ebook Market Research",
    instructions=(
        "This server provides market research tools for top-selling ebooks. "
        "Use search_top_ebooks to discover bestsellers by genre, get_ebook_details "
        "for in-depth information on a single title, analyze_market_trends to spot "
        "category-wide patterns, and compare_ebooks to benchmark titles side-by-side."
    ),
)


@mcp.tool()
def search_top_ebooks(category: str = "fiction", limit: int = 10) -> str:
    """
    Fetch the current top-selling Kindle eBooks for a given category from
    Amazon's Best Sellers list.

    Args:
        category: Ebook genre/category (e.g. fiction, nonfiction, mystery,
                  romance, sci-fi, fantasy, biography, self-help, business,
                  history, children, horror, thriller). Defaults to 'fiction'.
        limit:    Maximum number of titles to return (1-50). Defaults to 10.

    Returns:
        JSON string containing a list of top-selling ebook entries, each with
        rank, title, author, price, rating, and review count.
    """
    limit = max(1, min(50, limit))
    category_lower = category.lower().strip()

    if category_lower not in SUPPORTED_CATEGORIES:
        category_lower = "fiction"

    # Use Amazon search to reliably land on category-specific Kindle results.
    target_url = _amazon_search_url(f"best selling {category_lower} ebooks")

    prompt = (
        f"Extract the top {limit} bestselling Kindle eBooks in the {category_lower} "
        "category from this Amazon search results page. For each book return: "
        "rank (integer, starting at 1), title, author, "
        "price (string, e.g. '$9.99' or 'Free'), rating (number out of 5), "
        "review_count (integer), asin (Amazon product ID if visible), and "
        "product_url. Return a JSON array of objects with these exact keys."
    )

    try:
        data = _firecrawl_extract([target_url], prompt)
        books = data if isinstance(data, list) else data.get("books", []) if isinstance(data, dict) else []
        return json.dumps(
            {
                "category": category_lower,
                "source": target_url,
                "count": len(books[:limit]),
                "books": books[:limit],
            },
            indent=2,
        )
    except Exception as exc:
        return json.dumps({"error": str(exc), "category": category})


@mcp.tool()
def get_ebook_details(title: str, author: str = "") -> str:
    """
    Retrieve detailed market information about a specific ebook, including
    description, pricing, sales rank, reviews, and comparable titles.

    Args:
        title:  The title of the ebook to look up.
        author: (Optional) Author name to disambiguate titles.

    Returns:
        JSON string with detailed ebook market data.
    """
    search_query = f"{title} {author}".strip()
    amazon_search_url = (
        f"https://www.amazon.com/s?k={requests.utils.quote(search_query)}"
        "&i=digital-text&rh=n%3A133140011"
    )

    prompt = (
        f"Find the Kindle eBook '{search_query}' on this page. Extract: "
        "title, author, price, kindle_unlimited (true/false), rating (number), "
        "review_count (integer), bestseller_rank (string, e.g. '#1 in Mystery'), "
        "description (first 300 chars), page_count (or equivalent), publisher, "
        "publication_date, asin, product_url, and similar_books (list of up to "
        "5 similar titles with author and price). Return a single JSON object."
    )

    try:
        data = _firecrawl_extract([amazon_search_url], prompt)
        return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc), "query": search_query})


@mcp.tool()
def analyze_market_trends(category: str = "fiction", depth: str = "standard") -> str:
    """
    Analyze current market trends for a given ebook category, covering pricing
    patterns, dominant sub-genres, Kindle Unlimited prevalence, and emerging themes.

    Args:
        category: Ebook genre/category to analyze (same values as search_top_ebooks).
        depth:    'quick' (top 10 titles) or 'standard' (top 20 titles, default).

    Returns:
        JSON string with trend analysis including price distribution, rating
        distribution, Kindle Unlimited coverage, popular themes, and
        actionable insights for content creators and marketers.
    """
    limit = 10 if depth == "quick" else 20
    category_lower = category.lower().strip()

    if category_lower not in SUPPORTED_CATEGORIES:
        category_lower = "fiction"

    target_url = _amazon_search_url(f"best selling {category_lower} ebooks")

    prompt = (
        f"Analyze the top {limit} bestselling Kindle eBooks in the {category_lower} "
        "category from this Amazon page for market research. Return a JSON object with: "
        "category (string), "
        "total_analyzed (integer), "
        "price_distribution (object with keys: free_count, under_3_count, "
        "  3_to_7_count, 7_to_15_count, over_15_count), "
        "average_price (number), "
        "kindle_unlimited_percentage (number 0-100), "
        "average_rating (number), "
        "top_authors (list of up to 5 most frequent author names), "
        "common_themes (list of up to 8 recurring keywords or themes from titles), "
        "price_leaders (top 3 books sorted by value: title, price, rating), "
        "highly_rated (top 3 books by rating: title, author, rating), "
        "market_insights (list of 3-5 plain-English observations about what "
        "  makes these books successful), "
        "emerging_patterns (list of 2-3 trends that appear to be growing)."
    )

    try:
        data = _firecrawl_extract([target_url], prompt)
        if isinstance(data, dict):
            data["source"] = target_url
        return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc), "category": category})


@mcp.tool()
def compare_ebooks(titles: list[str]) -> str:
    """
    Compare multiple ebooks side-by-side on key market metrics to support
    competitive analysis and positioning decisions.

    Args:
        titles: List of ebook titles to compare (2-5 titles recommended).

    Returns:
        JSON string with a comparison table covering price, rating, review
        volume, sales rank, Kindle Unlimited availability, and a competitive
        summary for each title.
    """
    if not titles:
        return json.dumps({"error": "Please provide at least one title to compare"})

    titles = titles[:5]  # cap at 5 to keep extraction manageable

    search_urls = [
        (
            f"https://www.amazon.com/s?k={requests.utils.quote(t)}"
            "&i=digital-text&rh=n%3A133140011"
        )
        for t in titles
    ]

    titles_str = ", ".join(f'"{t}"' for t in titles)
    prompt = (
        f"For each of these ebooks: {titles_str}, find the Kindle edition on "
        "the search results page and extract: title, author, price (string), "
        "kindle_unlimited (true/false), rating (number), review_count (integer), "
        "bestseller_rank (string), asin, and product_url. "
        "Return a JSON object with key 'books' containing a list of these objects, "
        "plus a key 'comparison_summary' with 2-3 sentences on how the titles "
        "compare in terms of price, reader reception, and market positioning."
    )

    try:
        data = _firecrawl_extract(search_urls, prompt)
        return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc), "titles": titles})


@mcp.tool()
def get_goodreads_bestsellers(list_id: str = "1.Best_Books_Ever") -> str:
    """
    Fetch ebook data from a Goodreads community list for additional market
    signal beyond Amazon sales rankings.

    Args:
        list_id: Goodreads list identifier (the part after /list/show/).
                 Defaults to '1.Best_Books_Ever'. Other popular options:
                 '17911203.Best_Kindle_Books_of_All_Time',
                 '6472970.Best_Ebooks_to_read'.

    Returns:
        JSON string with list name, top books (title, author, avg_rating,
        ratings_count, description snippet), and community insights.
    """
    url = f"{GOODREADS_LISTOPIA}{list_id}"

    prompt = (
        "Extract the top 15 books from this Goodreads list. For each book return: "
        "rank (integer), title, author, avg_rating (number), ratings_count (integer), "
        "description (first 200 chars if available), genres (list of strings), "
        "and goodreads_url. "
        "Also return a key 'list_name' (the name of this Goodreads list) and "
        "'list_description' (a short summary of the list's purpose). "
        "Return a JSON object with keys: list_name, list_description, books."
    )

    try:
        data = _firecrawl_extract([url], prompt)
        return json.dumps(data, indent=2)
    except Exception as exc:
        return json.dumps({"error": str(exc), "list_id": list_id})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    mcp.run()
