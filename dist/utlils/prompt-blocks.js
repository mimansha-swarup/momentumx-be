/**
 * Conditional prompt-block builders (phases 1C). Optional prompt variables are
 * handled BEFORE .replace() — a block resolves to real content or "" so no
 * {placeholder} is ever left unreplaced in an assembled prompt.
 */
/** Insert each value once, without interpreting dollar signs or placeholders inside it. */
export const fillTemplate = (template, values) => template.replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, token => Object.prototype.hasOwnProperty.call(values, token) ? values[token] : token);
export const resolveVideoFormat = (value) => value === "faceless" ? "faceless" : "talking_head";
export const SCRIPT_FORMAT_STYLE = {
    talking_head: "talking-head videos where the creator speaks directly to the camera",
    faceless: "faceless, documentary-style videos",
};
export const THUMBNAIL_FORMAT_DIRECTIVE = {
    talking_head: "- Use a genuine supplied creator image only when relevant; if unavailable, offer an object or diagram composition. Never invent a face or reaction",
    faceless: "- Do not suggest faces, people, or facial expressions — these are faceless videos; use text, graphics, icons, and scene imagery",
};
export const buildCreatorContextBlock = (channel) => {
    if (!channel)
        return "";
    const lines = [];
    if (channel.brandName)
        lines.push(`Brand: ${channel.brandName}`);
    if (channel.format)
        lines.push(`Video format: ${channel.format}`);
    if (channel.channelDescription)
        lines.push(`Channel description: ${channel.channelDescription}`);
    if (channel.niche)
        lines.push(`Niche: ${channel.niche}`);
    if (channel.targetAudience) {
        lines.push(`Target audience: ${channel.targetAudience}`);
    }
    if (channel.topTitles?.length) {
        lines.push("Creator's reference titles (voice and topic context, not evidence):");
        channel.topTitles.slice(0, 5).forEach((title) => lines.push(`- ${title}`));
    }
    if (lines.length === 0)
        return "";
    return [
        "Creator context (make the output sound like this channel):",
        ...lines,
    ].join("\n");
};
export const buildScriptSection = (script) => script && script.trim()
    ? `Video Script:\n${script}`
    : "No script is available yet — base the output on the video title, the opening hook (if any), and the creator context. Do not invent specific script details, names, or numbers.";
export const buildHookSection = (hook) => hook && hook.trim()
    ? `Opening Hook (the creator's selected opening line):\n${hook}`
    : "";
