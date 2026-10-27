/**
 * Zod settings for the page, applied before any schema parses (main.tsx imports this first).
 *
 * jitless: Zod would otherwise test whether it may compile parsers with `new Function`. The
 * Content-Security-Policy the web server sends (apps/web/Caddyfile) allows no eval, so the test
 * fails, and the browser reports it as a policy violation; Zod then parses without compiling
 * anyway. Parsing is the same either way.
 */
import { config } from 'zod';

config({ jitless: true });
