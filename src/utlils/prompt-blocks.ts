import { IChannelContext, VideoFormat } from "../types/routes/context.js";

/**
 * Conditional prompt-block builders (phases 1C). Optional prompt variables are
 * handled BEFORE .replace() — a block resolves to real content or "" so no
 * {placeholder} is ever left unreplaced in an assembled prompt.
 */

export const resolveVideoFormat = (value: unknown): VideoFormat =>
  value === "faceless" ? "faceless" : "talking_head";

export const SCRIPT_FORMAT_STYLE: Record<VideoFormat, string> = {
  talking_head:
    "talking-head videos where the creator speaks directly to the camera",
  faceless: "faceless, documentary-style videos",
};

export const THUMBNAIL_FORMAT_DIRECTIVE: Record<VideoFormat, string> = {
  talking_head:
    "- Feature the creator where impactful — expressive close-up faces with strong emotion perform well for talking-head channels; combine with text, graphics, and scene imagery",
  faceless:
    "- Do not suggest faces, people, or facial expressions — these are faceless videos; use text, graphics, icons, and scene imagery",
};

export const buildCreatorContextBlock = (
  channel: Partial<IChannelContext> | null | undefined
): string => {
  if (!channel) return "";
  const lines: string[] = [];
  if (channel.brandName) lines.push(`Brand: ${channel.brandName}`);
  if (channel.niche) lines.push(`Niche: ${channel.niche}`);
  if (channel.targetAudience) {
    lines.push(`Target audience: ${channel.targetAudience}`);
  }
  if (channel.topTitles?.length) {
    lines.push("Creator's top-performing titles:");
    channel.topTitles.slice(0, 5).forEach((title) => lines.push(`- ${title}`));
  }
  if (lines.length === 0) return "";
  return [
    "Creator context (make the output sound like this channel):",
    ...lines,
  ].join("\n");
};

export const buildScriptSection = (script?: string | null): string =>
  script && script.trim()
    ? `Video Script:\n${script}`
    : "No script is available yet — base the output on the video title, the opening hook (if any), and the creator context. Do not invent specific script details, names, or numbers.";

export const buildHookSection = (hook?: string | null): string =>
  hook && hook.trim()
    ? `Opening Hook (the creator's selected opening line):\n${hook}`
    : "";
