import app from "./app";
import serverless from "serverless-http";

if (process.env.NODE_ENV === "LOCAL") {
  const port = 3000;
  app.listen(port, () => {
    console.log(`The server is running at ${port}`);
  });
}

// export default app;

export const handler = serverless(app);
