import path from "node:path";

import { api } from "../../generated/api.js";

export function format(file: string) {
  return `${api}:${path.basename(file)}`;
}
