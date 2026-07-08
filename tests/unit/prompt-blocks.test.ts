import {
  buildCreatorContextBlock,
  buildHookSection,
  buildScriptSection,
  resolveVideoFormat,
  SCRIPT_FORMAT_STYLE,
  THUMBNAIL_FORMAT_DIRECTIVE,
} from "../../src/utlils/prompt-blocks";
import {
  GENERATE_TITLE_PROMPT,
  GENERATE_DESCRIPTION_PROMPT,
  GENERATE_THUMBNAIL_PROMPT,
  GENERATE_SHORTS_PROMPT,
  SCRIPT_SYSTEM_PROMPT,
} from "../../src/constants/prompt";

describe("prompt blocks", () => {
  describe("buildCreatorContextBlock", () => {
    it("renders only the fields that exist", () => {
      const block = buildCreatorContextBlock({
        niche: "AI tools",
        brandName: null,
        targetAudience: "founders",
        topTitles: [],
      });
      expect(block).toContain("Niche: AI tools");
      expect(block).toContain("Target audience: founders");
      expect(block).not.toContain("Brand:");
      expect(block).not.toContain("top-performing");
    });

    it("caps top titles at 5", () => {
      const block = buildCreatorContextBlock({
        topTitles: ["1", "2", "3", "4", "5", "6", "7"],
      });
      expect(block.match(/^- /gm)).toHaveLength(5);
    });

    it("returns empty string for null/empty context", () => {
      expect(buildCreatorContextBlock(null)).toBe("");
      expect(buildCreatorContextBlock({})).toBe("");
      expect(buildCreatorContextBlock({ niche: null, topTitles: [] })).toBe("");
    });
  });

  describe("buildScriptSection", () => {
    it("wraps a real script", () => {
      expect(buildScriptSection("My script")).toBe("Video Script:\nMy script");
    });

    it("degrades to the no-script directive for empty/absent scripts", () => {
      for (const value of [null, undefined, "", "   "]) {
        expect(buildScriptSection(value)).toContain("No script is available yet");
      }
    });
  });

  describe("buildHookSection", () => {
    it("wraps a hook and is empty when absent", () => {
      expect(buildHookSection("Great hook")).toContain("Great hook");
      expect(buildHookSection(null)).toBe("");
      expect(buildHookSection("  ")).toBe("");
    });
  });

  describe("resolveVideoFormat", () => {
    it("defaults everything except 'faceless' to talking_head", () => {
      expect(resolveVideoFormat("faceless")).toBe("faceless");
      expect(resolveVideoFormat("talking_head")).toBe("talking_head");
      expect(resolveVideoFormat(undefined)).toBe("talking_head");
      expect(resolveVideoFormat("weird")).toBe("talking_head");
    });
  });

  describe("assembled prompts leave no unreplaced placeholders", () => {
    // Mirrors the service assembly for the fully-degraded case (no script, no
    // hook, no channel context) — the highest risk of a leftover {placeholder}.
    const PLACEHOLDER = /\{[a-zA-Z][a-zA-Z0-9]*\}/;

    it("title prompt (full inputs)", () => {
      const prompt = GENERATE_TITLE_PROMPT
        .replace("{creatorContext}", "")
        .replace("{researchSignals}", "")
        .replace("{script}", "script text")
        .replace("{hookSection}", "");
      expect(prompt).not.toMatch(PLACEHOLDER);
    });

    it("description prompt (degraded: title only)", () => {
      const prompt = GENERATE_DESCRIPTION_PROMPT
        .replace("{title}", "My Title")
        .replace("{creatorContext}", buildCreatorContextBlock(null))
        .replace("{scriptSection}", buildScriptSection(null))
        .replace("{hookSection}", buildHookSection(null));
      expect(prompt).not.toMatch(PLACEHOLDER);
    });

    it("thumbnail prompt (degraded: title only, both formats)", () => {
      for (const format of ["talking_head", "faceless"] as const) {
        const prompt = GENERATE_THUMBNAIL_PROMPT
          .replace("{title}", "My Title")
          .replace("{formatDirective}", THUMBNAIL_FORMAT_DIRECTIVE[format])
          .replace("{creatorContext}", "")
          .replace("{scriptSection}", buildScriptSection(""))
          .replace("{hookSection}", "");
        expect(prompt).not.toMatch(PLACEHOLDER);
      }
    });

    it("shorts prompt", () => {
      const prompt = GENERATE_SHORTS_PROMPT
        .replace("{creatorContext}", "")
        .replace("{script}", "script text")
        .replace(/{duration}/g, "30");
      expect(prompt).not.toMatch(PLACEHOLDER);
    });

    it("script system prompt (both formats)", () => {
      for (const format of ["talking_head", "faceless"] as const) {
        const prompt = SCRIPT_SYSTEM_PROMPT.replace(
          "{videoFormatStyle}",
          SCRIPT_FORMAT_STYLE[format]
        );
        expect(prompt).not.toMatch(PLACEHOLDER);
      }
    });
  });
});
