/** Background jobs get their own budget; the HTTP client does not use this. */
const JOB_TIMEOUT_MS = 120000;

export async function runJob(job: () => Promise<void>): Promise<void> {
  await Promise.race([
    job(),
    new Promise((resolve) => setTimeout(resolve, JOB_TIMEOUT_MS)),
  ]);
}
