import app from "./app";

if (process.env.NODE_ENV === "LOCAL") {
  const port = 3000;
  app.listen(port, () => {
    console.log(`The server is running at ${port}`);
  });
}

export default app;
