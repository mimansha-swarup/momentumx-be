import app from "./app.js";
import { GENERATION_MODEL } from "./config/ai.js";
const port = 3000;
app.listen(port, () => {
    console.log(`The server is running at ${port}`);
    console.log(JSON.stringify({ event: "ai_model_configured", model: GENERATION_MODEL }));
});
export default app;
