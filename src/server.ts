import app from "./app.js";

const port = 3000;
app.listen(port, () => {
  console.log(`The server is running at ${port}`);
});

export default app;
