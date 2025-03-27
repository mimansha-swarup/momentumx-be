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
