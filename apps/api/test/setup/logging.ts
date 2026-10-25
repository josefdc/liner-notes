// Tests write no log lines: the logger is silent unless a test captures its lines
// (captureLogsForTests in src/logger.ts) or LOG_LEVEL is set in the shell. A log file set in the
// shell is never written by tests.
process.env.LOG_LEVEL ??= "silent";
delete process.env.LOG_FILE;
