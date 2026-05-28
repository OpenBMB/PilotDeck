/**
 * Secondary-model prompt builder for `web_fetch` (W13).
 */

export const WEB_FETCH_TOOL_NAME = "web_fetch";

export const WEB_FETCH_DESCRIPTION = `- Fetches content from a specified URL and can process it using a secondary AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- If a model client is available, applies the prompt to the fetched content using a secondary model call
- Without a model client, returns the fetched markdown content directly
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Fetched content may be truncated and model responses may be summarized if the page is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new web_fetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).`;

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;

  return `\nWeb page content:\n---\n${markdownContent}\n---\n\n${prompt}\n\n${guidelines}\n`;
}
