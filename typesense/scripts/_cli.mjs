// Shared bits for the scripts: consistent logging and a tidy exit on failure.
import { ConfigError } from '../src/client.mjs';

export const log = (...args) => console.log(...args);
export const warn = (...args) => console.warn(...args);

/** Run a script body, print a useful message on failure, and set the exit code. */
export async function main(fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nConfiguration: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`\n${error?.message ?? error}`);
    if (process.env.DEBUG) console.error(error);
    process.exitCode = 1;
  }
}

/** "1,234" — counts read better with separators in a seeding log. */
export const n = value => Number(value).toLocaleString('en-US');
