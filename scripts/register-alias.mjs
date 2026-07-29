import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL("./scripts/alias-hooks.mjs"));
