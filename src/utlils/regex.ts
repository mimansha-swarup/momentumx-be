// The function extractTextFromHTML is used to extract text from HTML content.
export function extractTextFromHTML(htmlWithTags: string) {
  const html = htmlWithTags
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") //remove all script tag
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ""); //remove all style tag

  // Remove all HTML tags
  const text = html.replace(/<[^>]+>/g, " ");

  // Remove extra whitespace and trim the result
  return text.replace(/\s+/g, " ").trim();
}

// utils/streamParser.ts
export function createChunkHandler(onTitle: (title: string) => void) {
  let buffer = "";
  const extractedTitles = new Set<string>();

  return (chunk: string) => {
    buffer += chunk;
    const regex = /"([^"]+?)"/g;
    let match;
    let lastIndex = 0;

    while ((match = regex.exec(buffer)) !== null) {
      const title = match[1].trim();
      if (!extractedTitles.has(title)) {
        extractedTitles.add(title);
        onTitle(title);
      }
      lastIndex = regex.lastIndex;
    }

    buffer = buffer.slice(lastIndex);
  };
}

export function extractChannelInfo(url: string) {
  const patterns = {
    // Case 1: Direct channel ID
    channel:
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/channel\/([a-zA-Z0-9_-]{24})/,

    // Case 2: Handle format
    handle: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9._-]+)/,

    // Case 3: Custom URL or legacy username
    custom:
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:c|user)\/([a-zA-Z0-9._-]+)/,
  };

  for (const [type, regex] of Object.entries(patterns)) {
    const match = url.match(regex);
    if (match) return { type, value: match[1] };
  }

  return null;
}
