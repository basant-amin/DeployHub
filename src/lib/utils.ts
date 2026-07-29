import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names and resolve Tailwind conflicts so the last
 * utility wins (e.g. `cn("p-2", "p-4")` -> `"p-4"`). Used by shadcn/ui and
 * throughout the component layer.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
