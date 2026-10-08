import { greet } from "@fixture/lib";

export function format(name: string): string {
  return greet(name).toUpperCase();
}
