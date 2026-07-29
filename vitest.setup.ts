import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount and clean up the DOM after every test to keep them isolated.
afterEach(() => {
  cleanup();
});
