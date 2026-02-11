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
        this.getPackaging = async (packagingId) => {
            try {
                const result = await this.repo.get(packagingId);
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
        this.repo = repo;
    }
}
export default PackagingService;
