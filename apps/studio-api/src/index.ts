import "dotenv/config";
import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = buildApp();

// Said once, loudly, at boot. Both of these are correct in development and
// wrong in production, and the way they go wrong is silent -- a staging
// deployment that has been inventing transcripts for a month, or a
// production one signing tokens with a key published in this repository.
if (env.JWT_SECRET_IS_DEV_DEFAULT) {
  app.log.warn(
    "JWT_SECRET is not set, so tokens are signed with the development " +
      "placeholder in src/config/env.ts. Fine locally; production refuses to boot like this.",
  );
}
if (env.SIMULATE_JOBS) {
  app.log.warn(
    "STUDIO_SIMULATE_JOBS is on: transcribe, dub and render return invented " +
      "results on a timer. Every job and transcript it writes is marked simulated.",
  );
}

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info("Studio API listening at " + address);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });

// A SIGINT in the middle of a job otherwise leaves its row `running`
// forever; `close()` runs the worker's own stop, which drains it.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
