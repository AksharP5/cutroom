// Tiny export fixtures need only one Chromium worker to stay within the suite's memory budget.
process.env.PRODUCER_MAX_WORKERS ??= "1";
