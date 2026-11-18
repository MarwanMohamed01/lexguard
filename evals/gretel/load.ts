import { existsSync, readFileSync } from "node:fs";
import { parquetReadObjects } from "hyparquet";
import { parsePyLiteral, type PyValue } from "./pyliteral";

export interface GretelEntity {
  value: string;
  types: string[];
}

export interface GretelRow {
  uid: string;
  domain: string;
  documentType: string;
  text: string;
  entities: GretelEntity[];
}

export const GRETEL_TEST_FILE = new URL("../data/gretel/test.parquet", import.meta.url);

export function gretelAvailable(): boolean {
  return existsSync(GRETEL_TEST_FILE);
}

export async function loadGretelTest(): Promise<GretelRow[]> {
  const buffer = readFileSync(GRETEL_TEST_FILE);
  const file = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
  return rows.map((row) => ({
    uid: String(row.uid),
    domain: String(row.domain),
    documentType: String(row.document_type),
    text: String(row.text),
    entities: toEntities(parsePyLiteral(String(row.entities))),
  }));
}

// Validates the parsed shape instead of trusting it: downloaded data is untrusted input.
function toEntities(value: PyValue): GretelEntity[] {
  if (!Array.isArray(value)) throw new Error("entities is not a list");
  return value.map((item) => {
    if (typeof item !== "object" || Array.isArray(item)) throw new Error("entity is not a dict");
    const entity = item.entity;
    const types = item.types;
    if (typeof entity !== "string" || !Array.isArray(types)) throw new Error("bad entity shape");
    return { value: entity, types: types.map(String) };
  });
}
