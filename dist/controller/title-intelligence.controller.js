class TitleIntelligenceController {
    constructor(service) {
        this.service = service;
        this.generate = async (req, res) => {
            try {
                const { idea, script } = req.body;
                console.log("IDEA", idea);
                if (!idea && !script) {
                    return res.sendError({
                        message: "At least one of 'idea' or 'script' is required",
                        statusCode: 400,
                    });
                }
                const result = await this.service.generate(idea ?? "", script ?? "");
                res.sendSuccess({ data: result, statusCode: 200 });
            }
            catch (error) {
                res.sendError({ message: "Failed to generate smart titles", detail: error });
            }
        };
    }
}
export default TitleIntelligenceController;
