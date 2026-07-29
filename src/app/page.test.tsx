import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";

describe("HomePage", () => {
  it("renders the product name as a heading", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1, name: /deployhub/i })).toBeInTheDocument();
  });
});
