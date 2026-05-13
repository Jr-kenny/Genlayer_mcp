import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ContractArtifact {
  absolutePath: string;
  base64: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
}

export async function loadContractArtifact(inputPath: string): Promise<ContractArtifact> {
  const absolutePath = path.resolve(process.cwd(), inputPath);
  const buffer = await fs.readFile(absolutePath);

  return {
    absolutePath,
    base64: buffer.toString("base64"),
    fileName: path.basename(absolutePath),
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.byteLength
  };
}
