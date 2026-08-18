import { createLabApp } from "./app.js";
import { MemoryKv } from "./kv.js";

const port = Number(process.env.PORT ?? 4600);
createLabApp(new MemoryKv()).listen(port, () => {
  console.log(`Mutation Lab: http://localhost:${port}  (control: /__control)`);
});
