import { HttpError } from "../utlils/errors.js";
// Curated HttpError messages pass through; anything else is logged server-side
// and replaced with a generic message so internals never reach the client.
const sendSafeError = (res, error, message) => {
    if (error instanceof HttpError) {
        res.sendError({ message: error.message, statusCode: error.statusCode });
        return;
    }
    console.error(JSON.stringify({
        event: "title_intelligence_error",
        message: error instanceof Error ? error.message : String(error),
    }));
    res.sendError({ message, statusCode: 500 });
};
class TitleIntelligenceController {
    constructor(service) {
        this.service = service;
        this.generate = async (req, res) => {
            try {
                const { idea, script } = req.body;
                if (!idea && !script) {
                    return res.sendError({
                        message: "At least one of 'idea' or 'script' is required",
                        statusCode: 400,
                    });
                }
                const { result, timings } = await this.service.generate(idea ?? "", script ?? "");
                res.sendSuccess({ data: result, meta: { timings }, statusCode: 200 });
            }
            catch (error) {
                sendSafeError(res, error, "Failed to generate smart titles");
            }
        };
        this.deepGenerate = async (req, res) => {
            try {
                const { idea, script } = req.body;
                if (!idea && !script) {
                    return res.sendError({
                        message: "At least one of 'idea' or 'script' is required",
                        statusCode: 400,
                    });
                }
                const result = await this.service.deepGenerate(idea ?? "", script ?? "");
                res.sendSuccess({ data: result, statusCode: 200 });
            }
            catch (error) {
                sendSafeError(res, error, "Failed to deep-generate smart titles");
            }
        };
    }
}
export default TitleIntelligenceController;
