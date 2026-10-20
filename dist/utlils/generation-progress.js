import { HttpError } from "./errors.js";
/** Opt-in progress transport. The ordinary JSON contract remains available. */
export async function generationResponse(req, res, message, generate) {
    if (!req.get("Accept")?.includes("text/event-stream")) {
        res.sendSuccess({ message, data: await generate() });
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const send = (event, data) => {
        if (!res.destroyed && !res.writableEnded)
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // Heartbeats mean only that the connection is alive, never that work advanced.
    const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded)
            res.write(": heartbeat\n\n");
    }, 15000);
    const cleanup = () => clearInterval(heartbeat);
    res.once("close", cleanup);
    try {
        const data = await generate((stage, detail) => send("progress", { stage, message: detail }), text => send("chunk", { text }));
        // Generation includes persistence and settlement; previews cannot masquerade as saved results.
        send("result", { success: true, message, data });
    }
    catch (error) {
        const known = error instanceof HttpError;
        const statusCode = known ? error.statusCode : 500;
        console.error(JSON.stringify({ event: "generation_stream_failed", path: req.path, message: error instanceof Error ? error.message : "Unknown error" }));
        const detail = !known ? undefined : statusCode < 500
            ? error.detail
            : error.detail?.charged === false
                ? { charged: false }
                : undefined;
        send("generation_error", {
            message: known ? error.message : "Generation failed. Please try again.",
            statusCode,
            code: known && statusCode < 500 ? error.code : undefined,
            detail,
        });
    }
    finally {
        cleanup();
        res.off("close", cleanup);
        if (!res.destroyed && !res.writableEnded)
            res.end();
    }
}
