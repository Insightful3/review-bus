// Writes spec/reviewer-output.schema.json from the zod schema. Run after build.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { reviewerOutputJsonSchema } from "./reviewer-output.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(root, "spec", "reviewer-output.schema.json");
writeFileSync(out, JSON.stringify(reviewerOutputJsonSchema(), null, 2) + "\n");
