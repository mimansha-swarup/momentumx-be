import { PACKAGING_SYSTEM_PROMPT, GENERATE_TITLE_PROMPT, GENERATE_DESCRIPTION_PROMPT, GENERATE_THUMBNAIL_PROMPT, GENERATE_HOOKS_PROMPT, GENERATE_SHORTS_PROMPT, } from "../constants/prompt.js";
import { GENERATION_CONFIG_PACKAGING } from "../constants/firebase.js";
import { generateStreamingContent } from "../utlils/ai.js";
import { firebase } from "../config/firebase.js";
class PackagingService {
    constructor(repo) {
        this.generateContent = async (userPrompt) => {
            const result = await generateStreamingContent(PACKAGING_SYSTEM_PROMPT, userPrompt, GENERATION_CONFIG_PACKAGING);
            let accumulatedRes = "";
            for await (const chunk of result.stream) {
                const part = chunk.text();
                if (part) {
                    accumulatedRes += part;
                }
            }
            return JSON.parse(accumulatedRes);
        };
        this.generateTitle = async (script) => {
            try {
                const userPrompt = GENERATE_TITLE_PROMPT.replace("{script}", script);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                console.log("error generating title", error);
                throw error;
            }
        };
        this.generateDescription = async (script, title) => {
            try {
                const userPrompt = GENERATE_DESCRIPTION_PROMPT
                    .replace("{script}", script)
                    .replace("{title}", title);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                console.log("error generating description", error);
                throw error;
            }
        };
        this.generateThumbnail = async (script, title) => {
            try {
                const userPrompt = GENERATE_THUMBNAIL_PROMPT
                    .replace("{script}", script)
                    .replace("{title}", title);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                console.log("error generating thumbnail", error);
                throw error;
            }
        };
        this.generateHooks = async (script) => {
            try {
                const userPrompt = GENERATE_HOOKS_PROMPT.replace("{script}", script);
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                console.log("error generating hooks", error);
                throw error;
            }
        };
        this.generateShorts = async (script, duration) => {
            try {
                const userPrompt = GENERATE_SHORTS_PROMPT
                    .replace("{script}", script)
                    .replace(/{duration}/g, duration.toString());
                const result = await this.generateContent(userPrompt);
                return result;
            }
            catch (error) {
                console.log("error generating shorts", error);
                throw error;
            }
        };
        this.savePackaging = async (userId, data) => {
            try {
                const packagingData = {
                    ...data,
                    createdBy: userId,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                };
                const result = await this.repo.save(packagingData);
                return result;
            }
            catch (error) {
                console.log("error saving packaging", error);
                throw error;
            }
        };
        this.getPackaging = async (packagingId, userId) => {
            try {
                const result = await this.repo.get(packagingId);
                if (!result)
                    return null;
                if (result.createdBy !== userId)
                    throw new Error("Unauthorized");
                return result;
            }
            catch (error) {
                console.log("error getting packaging", error);
                throw error;
            }
        };
        this.getPackagingByUser = async (userId) => {
            try {
                const result = await this.repo.getByUserId(userId);
                return result;
            }
            catch (error) {
                console.log("error getting packaging by user", error);
                throw error;
            }
        };
        this.regenerateItem = async (userId, packagingId, item, script, title, duration) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                const err = new Error("Packaging not found");
                err.statusCode = 404;
                throw err;
            }
            if (pkg.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const validItems = ["title", "description", "thumbnail", "shorts"];
            if (!validItems.includes(item)) {
                const err = new Error(`item must be one of: ${validItems.join(", ")}`);
                err.statusCode = 400;
                throw err;
            }
            if (!script) {
                const err = new Error("script is required");
                err.statusCode = 400;
                throw err;
            }
            if ((item === "description" || item === "thumbnail") && !title) {
                const err = new Error("title is required for description and thumbnail regeneration");
                err.statusCode = 400;
                throw err;
            }
            if (item === "shorts" && !duration) {
                const err = new Error("duration is required for shorts regeneration");
                err.statusCode = 400;
                throw err;
            }
            let result;
            let fieldKey;
            if (item === "title") {
                result = await this.generateTitle(script);
                fieldKey = "titles";
            }
            else if (item === "description") {
                result = await this.generateDescription(script, title);
                fieldKey = "description";
            }
            else if (item === "thumbnail") {
                result = await this.generateThumbnail(script, title);
                fieldKey = "thumbnail";
            }
            else {
                result = await this.generateShorts(script, duration);
                fieldKey = "shorts";
            }
            await this.repo.update(packagingId, { [fieldKey]: result });
            return { id: packagingId, item, data: result };
        };
        this.updateFeedback = async (userId, packagingId, item, feedback) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                const err = new Error("Packaging not found");
                err.statusCode = 404;
                throw err;
            }
            if (pkg.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const validItems = ["title", "description", "thumbnail", "shorts"];
            if (!validItems.includes(item)) {
                const err = new Error(`item must be one of: ${validItems.join(", ")}`);
                err.statusCode = 400;
                throw err;
            }
            const validFeedback = ["like", "dislike", null];
            if (!validFeedback.includes(feedback)) {
                const err = new Error('feedback must be "like", "dislike", or null');
                err.statusCode = 400;
                throw err;
            }
            await this.repo.update(packagingId, { [`feedback.${item}`]: feedback });
            return { id: packagingId, item, feedback };
        };
        this.exportPackaging = async (userId, packagingId) => {
            const pkg = await this.repo.get(packagingId);
            if (!pkg) {
                const err = new Error("Packaging not found");
                err.statusCode = 404;
                throw err;
            }
            if (pkg.createdBy !== userId) {
                const err = new Error("Forbidden");
                err.statusCode = 403;
                throw err;
            }
            const today = new Date().toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
            });
            const formatValue = (val) => {
                if (val === undefined || val === null)
                    return "N/A";
                if (typeof val === "string")
                    return val;
                return JSON.stringify(val, null, 2);
            };
            const titles = pkg.titles;
            const titlesText = Array.isArray(titles)
                ? titles.map((t, i) => `${i + 1}. ${typeof t === "string" ? t : JSON.stringify(t)}`).join("\n")
                : formatValue(titles);
            const lines = [
                `Video Package — ${today}`,
                "══════════════════════════════════",
                "",
                "TITLES",
                "──────",
                titlesText,
                "",
                "DESCRIPTION",
                "───────────",
                formatValue(pkg.description),
                "",
                "THUMBNAIL BRIEF",
                "───────────────",
                formatValue(pkg.thumbnail),
                "",
                "SHORTS SCRIPT",
                "─────────────",
                formatValue(pkg.shorts),
            ];
            return { text: lines.join("\n") };
        };
        this.repo = repo;
    }
}
export default PackagingService;
