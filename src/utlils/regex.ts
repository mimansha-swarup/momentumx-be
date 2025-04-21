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
