// The function extractTextFromHTML is used to extract text from HTML content.
export function extractTextFromHTML(htmlWithTags) {
    const html = htmlWithTags
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") //remove all script tag
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ""); //remove all style tag
    // Remove all HTML tags
    const text = html.replace(/<[^>]+>/g, " ");
    // Remove extra whitespace and trim the result
    return text.replace(/\s+/g, " ").trim();
}
export function extractChannelInfo(url) {
    const patterns = {
        // Case 1: Direct channel ID
        channel: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/channel\/([a-zA-Z0-9_-]{24})/,
        // Case 2: Handle format
        handle: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9._-]+)/,
        // Case 3: Custom URL or legacy username
        custom: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:c|user)\/([a-zA-Z0-9._-]+)/,
    };
    for (const [type, regex] of Object.entries(patterns)) {
        const match = url.match(regex);
        if (match)
            return { type, value: match[1] };
    }
    return null;
}
// YouTube's search API returns titles with HTML entities (&amp;, &#39;, …) and
// sometimes transport-double-encoded ones (&amp;#39;) — decode at the boundary so
// downstream prompts never see encoded text.
//
// ONE PASS OVER THE ORIGINAL STRING, but the pattern itself matches an OPTIONAL
// "amp;" prefix in front of every entity body (numeric or named). That means a
// transport-double-escaped entity — "&amp;#39;" or "&amp;quot;" — is recognised as a
// SINGLE token and decoded in one step, without ever rescanning a replacer's own
// output: nothing decodes "&amp;" first and then goes looking at what's left behind
// it. "&amp;#39;" -> "'" and "&amp;quot;" -> "\"" now get the identical one-layer-deeper
// treatment, which is the consistency the old ordered chain got right for numeric
// entities by accident and wrong for everything else.
//
// THE RESIDUAL AMBIGUITY, stated plainly: "&amp;" alone (with no entity body
// following it) decodes to "&", same as always — the pattern's own "amp" alternative
// IS the ampersand entity, so a title that genuinely wants to display the literal
// text "&amp;" is indistinguishable from one layer of transport escaping around
// nothing, and reads as "&". That is the one case this can't disambiguate from the
// string alone; it is far rarer than a double-escaped apostrophe or quote, so this
// resolves in favour of undoing the escaping.
//
// fromCodePoint, NOT fromCharCode: the latter truncates above U+FFFF, so "&#128512;"
// became a lone broken surrogate instead of an emoji — and emoji are everywhere in
// YouTube titles. Lone surrogates (U+D800-U+DFFF) and anything above U+10FFFF are not
// valid scalar values — fromCodePoint would throw, so those are left as the original
// entity text instead of decoded.
//
// Shared by research.repository AND extract.repository on purpose: both hit the same
// search endpoint, and extract's titles land in the channel context that
// utlils/content.ts formats straight into the generation prompt.
const ENTITY_PATTERN = /&(?:amp;)?(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|quot|apos|lt|gt));/g;
export function decodeEntities(text) {
    return text.replace(ENTITY_PATTERN, (whole, decimal, hex, named) => {
        switch (named) {
            case "amp":
                return "&";
            case "quot":
                return '"';
            case "apos":
                return "'";
            case "lt":
                return "<";
            case "gt":
                return ">";
        }
        const point = decimal !== undefined ? Number(decimal) : parseInt(hex, 16);
        const isSurrogate = point >= 0xd800 && point <= 0xdfff;
        return point >= 0 && point <= 0x10ffff && !isSurrogate
            ? String.fromCodePoint(point)
            : whole;
    });
}
