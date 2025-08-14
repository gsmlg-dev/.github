import os
import re
import sys
import requests

def fetch_repos(org_name):
    """Fetches a list of repositories for a given GitHub organization."""
    repos = []
    url = f"https://api.github.com/orgs/{org_name}/repos"
    headers = {
        "Accept": "application/vnd.github.v3+json",
    }

    # Use a token if available for higher rate limits
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"token {token}"

    while url:
        response = requests.get(url, headers=headers)
        response.raise_for_status()  # Will raise an exception for 4xx/5xx errors

        for repo in response.json():
            if not repo["private"]:
                repos.append({
                    "name": repo["name"],
                    "language": repo["language"],
                    "stars": repo["stargazers_count"],
                    "forks": repo["forks_count"],
                    "url": repo["html_url"],
                })

        # Check for next page
        if 'next' in response.links:
            url = response.links['next']['url']
        else:
            url = None

    return sorted(repos, key=lambda x: x["stars"], reverse=True)

def generate_readme_table(repos):
    """Generates a markdown table from a list of repositories."""
    table = "| Repository | Language | Stars | Forks |\n"
    table += "|---|---|---|---|\n"
    for repo in repos:
        language = repo["language"] if repo["language"] else "N/A"
        stars = f"⭐️ {repo['stars']}"
        forks = f"🍴 {repo['forks']}"
        table += f"| [{repo['name']}]({repo['url']}) | {language} | {stars} | {forks} |\n"
    return table

def update_readme(readme_path, table_content):
    """Updates the README file with the new table content."""
    with open(readme_path, "r") as f:
        content = f.read()

    start_marker = "<!--START_SECTION:repositories-->"
    end_marker = "<!--END_SECTION:repositories-->"

    # Use regex to find and replace content between markers
    pattern = re.compile(f"{re.escape(start_marker)}.*{re.escape(end_marker)}", re.DOTALL)
    new_content = pattern.sub(f"{start_marker}\n{table_content}\n{end_marker}", content)

    with open(readme_path, "w") as f:
        f.write(new_content)

if __name__ == "__main__":
    org = "gsmlg-dev"
    readme_file = "profile/README.md"

    try:
        repositories = fetch_repos(org)
        markdown_table = generate_readme_table(repositories)
        update_readme(readme_file, markdown_table)
        print(f"Successfully updated {readme_file}")
    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from GitHub API: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        sys.exit(1)
