import { register } from "node:module";

// Resolved against this module, not the working directory: see `alias-hooks.mjs`.
register(new URL("./alias-hooks.mjs", import.meta.url));
