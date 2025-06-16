import app from "../app.js";
import serverless from "serverless-http";

const handler = serverless(app);

export { handler };
