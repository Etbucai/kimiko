import { defineConfig } from "drizzle-kit";
import { Env } from "./src/env";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/database/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: Env.databaseUrl,
  },
  strict: true,
  verbose: true,
});
