#!/usr/bin/env node
// Checks the WCAG contrast of the design tokens: every text colour at 4.5:1 or more and every
// data-visualisation colour at 3:1 or more, on every surface token.
//
//   node scripts/contrast.mjs apps/web/src/styles/tokens.css
//
// The check itself is apps/web/config/contrast.mjs, which the web build also runs (the web
// image's build context has no scripts/).

import { main } from "../apps/web/config/contrast.mjs";

process.exitCode = main(process.argv.slice(2));
