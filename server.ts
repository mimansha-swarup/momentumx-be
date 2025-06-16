import app from "./src/app";
import serverless from "serverless-http";

const handler = serverless(app);

export { handler };
